"""Thin HITL reservation client for the generalized hitl-reserve daemon.

Talks the daemon's JSON API directly (POST /reserve, /reservation/{id}/heartbeat,
/release; GET /status) and does the ssh/scp/tunnel plumbing in Python. The
reservation workflow (flashing, tunneling to a DUT via the rig) is splanc-specific,
so it lives HERE in the harness rather than in the general `hitl` CLI — the CLI
stays a minimal reserve/status/release/shared client.

The `Reservation` API is unchanged from the previous CLI-shelling version, so
callers (the e2e driver, the reach probe, the benches) stay put:

    r = Reservation(); r.acquire()          # pick a free rig, reserve, hold it
    r.scp_to([bundle], "/tmp/"); r.ssh("hitl-flash …", capture=True)
    with r.forward(dut_ip, 81) as port: ...  # tunnel to the DUT via the rig
    r.release()                             # or use it as a context manager

Model: acquire() picks a matching free host from the pool ($HITL_HOSTS, or the
legacy $HITL_SERVERS), reserves a unit with a throwaway SSH key, and holds the
lease with a background heartbeat thread until release(). Each operation is a short
ssh/scp to the unit's endpoint. Stdlib only (urllib/subprocess/threading).
"""

from __future__ import annotations

import base64
import json
import os
import random
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager

import serial_capture


def _host_of(base_url: str) -> str:
    """The hostname out of a base URL like 'http://hitl-rig-1:8087' -> 'hitl-rig-1'."""
    return base_url.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0]


class ReserveError(RuntimeError):
    pass


class DutUnreachable(ReserveError):
    """The DUT itself cannot be reached from the rig after provisioning: a device
    (or WiFi association) failure, not rig trouble. A ReserveError subclass so
    callers that only distinguish "the run could not complete" keep working."""


DEFAULT_PORT = "8087"
# ACL tag every splanc HITL rig carries; the pool falls back to discovering rigs by
# this tag on the tailnet when no host list is given (matches the old Go CLI's
# internal/tailnet). Override with $HITL_TAG.
DEFAULT_TAG = "tag:splanc-hitl"
# `--require` capability aliases (old CLI parseRequire): the logic analyzer is a
# per-unit tap capability, granular by the signal it taps.
_REQUIRE_ALIASES = {
    "analyzer": "logic-analyzer-led-strip",
    "analyzer-led-strip": "logic-analyzer-led-strip",
    "analyzer-spi": "logic-analyzer-spi",
}


def default_hitl() -> list[str]:
    """Kept for signature compatibility; the client no longer shells the CLI."""
    return (os.environ.get("HITL_BIN") or "hitl").split()


def _norm(tokens: list[str]) -> list[str]:
    """Canonicalize bare host / host:port / URL tokens to base URLs."""
    out: list[str] = []
    for tok in tokens:
        u = tok if "://" in tok else "http://" + tok
        if ":" not in u.split("://", 1)[1]:
            u = u + ":" + DEFAULT_PORT
        if u not in out:
            out.append(u)
    return out


def _discover_tailnet_rigs(status_json: str | None = None) -> list[str]:
    """Hostnames of online tailnet nodes carrying the HITL tag (default
    tag:splanc-hitl, override $HITL_TAG). The fallback when neither $HITL_HOSTS nor
    $HITL_SERVERS is set — how CI (which sets no host list) finds the fleet. Mirrors
    the old Go CLI's internal/tailnet: include Self if tagged, and tagged peers that
    are Online. `status_json` is injectable for tests; otherwise `tailscale status
    --json` is run locally. A missing/erroring tailscale CLI yields no rigs."""
    tag = os.environ.get("HITL_TAG") or DEFAULT_TAG
    if status_json is None:
        try:
            p = subprocess.run(
                ["tailscale", "status", "--json"], capture_output=True, text=True, timeout=15
            )
            if p.returncode != 0 or not (p.stdout or "").strip():
                return []
            status_json = p.stdout
        except Exception:  # noqa: BLE001 (no tailscale / not joined -> just no discovery)
            return []
    try:
        st = json.loads(status_json)
    except Exception:  # noqa: BLE001
        return []

    def host(n: dict) -> str:
        return n.get("HostName") or (n.get("DNSName") or "").rstrip(".")

    def tagged(n: dict | None) -> bool:
        return bool(n) and tag in (n.get("Tags") or [])

    hosts: list[str] = []
    self_n = st.get("Self")
    if tagged(self_n):  # self is included regardless of the Online flag
        hosts.append(host(self_n))
    for n in (st.get("Peer") or {}).values():
        if tagged(n) and n.get("Online"):  # skip offline peers so the pool doesn't stall
            hosts.append(host(n))
    return sorted(h for h in hosts if h)


def _pool() -> list[str]:
    """Canonical base URLs: $HITL_HOSTS (or legacy $HITL_SERVERS) if set, else rigs
    discovered on the tailnet by the HITL tag."""
    raw = os.environ.get("HITL_HOSTS") or os.environ.get("HITL_SERVERS") or ""
    tokens = raw.replace(",", " ").split()
    if not tokens:
        tokens = _discover_tailnet_rigs()
    urls = _norm(tokens)
    # $HITL_EXCLUDE_HOSTS (comma/space list of hostnames) fences specific rigs OUT of
    # this run's pool. Used to keep a test lane off a rig it can't run on — e.g. the
    # netstack lane skips a rig whose AP the heapless netstack can't yet join (rig-3's
    # Pi 3 onboard AP drops the DUT's protected unicast; tracked as a firmware RX bug),
    # while the vendor-stack lane still uses it. Matched by hostname, so it applies
    # whether the pool came from $HITL_HOSTS or tailnet-tag discovery.
    excl = set((os.environ.get("HITL_EXCLUDE_HOSTS") or "").replace(",", " ").split())
    if excl:
        urls = [u for u in urls if _host_of(u) not in excl]
    return urls


# How many times a queued reservation re-queues after the daemon forgets it (404),
# or migrates off a host that was cordoned while we waited.
_MAX_REQUEUES = 3

# Scheduling classes understood by a priority-aware hitl-reserved, highest first.
PRIORITY_CLASSES = ("merge-queue", "pr-ci", "dev")


def _priority() -> str:
    """$HITL_PRIORITY normalized to a class name (default dev). Unknown values pass
    through lowercased; the daemon maps anything it doesn't know to dev."""
    return (os.environ.get("HITL_PRIORITY") or "dev").strip().lower() or "dev"


def _env_float(name: str, default: float | None) -> float | None:
    v = os.environ.get(name)
    if v is None or not v.strip():
        return default
    return float(v)


class WaitPolicy:
    """When a queued client stops waiting for activation. Pure (see QueueWatch).

    * legacy_timeout — against a daemon that predates priorities (no queue-progress
      fields): the old fixed timeout (2400 s), unchanged behaviour.
    * stall_timeout ($HITL_QUEUE_STALL_TIMEOUT, default 3600 s) — against a
      priority-aware daemon: give up only after the queue made NO progress for this
      long (progress = our position dropped, or a unit we can use was freed). Default
      one hour because a CI-held unit is bounded by HITL_HOLD_MAX (3600 s in CI), so
      an hour with no unit freeing up means the rig is wedged, not busy.
    * hard_cap ($HITL_ACTIVATE_TIMEOUT or a caller's explicit timeout) — an absolute
      cap on this wait, if set.
    * deadline ($HITL_DEADLINE, unix epoch s) — the CI job's ceiling: never wait past
      it, so later flaky-retry attempts can't queue beyond the job's budget.
    * max_wait ($HITL_ACTIVATE_MAX, default 6 h) — a safety net for a priority-aware
      wait with no other cap.
    * unreachable_timeout ($HITL_RIG_UNREACHABLE_TIMEOUT, 300 s) /
      blocked_timeout (300 s) — the rig is unhealthy: the daemon stopped answering, or
      it reports no unit that could ever serve us (unplugged).
    * cordon_migrate_after (120 s) — our host was cordoned for maintenance: try to
      move to another host (see Reservation._migrate_off_cordoned)."""

    def __init__(
        self,
        legacy_timeout: float = 2400.0,
        stall_timeout: float = 3600.0,
        hard_cap: float | None = None,
        deadline: float | None = None,
        max_wait: float = 6 * 3600.0,
        unreachable_timeout: float = 300.0,
        blocked_timeout: float = 300.0,
        cordon_migrate_after: float = 120.0,
    ) -> None:
        self.legacy_timeout = legacy_timeout
        self.stall_timeout = stall_timeout
        self.hard_cap = hard_cap
        self.deadline = deadline
        self.max_wait = max_wait
        self.unreachable_timeout = unreachable_timeout
        self.blocked_timeout = blocked_timeout
        self.cordon_migrate_after = cordon_migrate_after

    @classmethod
    def from_env(
        cls, timeout: float | None = None, legacy_timeout: float | None = None
    ) -> "WaitPolicy":
        """`timeout` is an explicit hard cap (the caller's or $HITL_ACTIVATE_TIMEOUT
        via acquire); it also serves as the legacy fixed timeout unless
        `legacy_timeout` is given."""
        legacy = legacy_timeout if legacy_timeout is not None else timeout
        return cls(
            legacy_timeout=2400.0 if legacy is None else legacy,
            stall_timeout=_env_float("HITL_QUEUE_STALL_TIMEOUT", 3600.0),
            hard_cap=timeout,
            deadline=_env_float("HITL_DEADLINE", None),
            max_wait=_env_float("HITL_ACTIVATE_MAX", 6 * 3600.0),
            unreachable_timeout=_env_float("HITL_RIG_UNREACHABLE_TIMEOUT", 300.0),
        )


def _fmt_s(s: float) -> str:
    s = max(0, int(s))
    return f"{s // 60}m{s % 60:02d}s" if s >= 60 else f"{s}s"


class QueueWatch:
    """Tracks one queued reservation's waiting and decides when to give up (pure:
    every method takes `now`, so tests drive it without sleeping).

    A daemon is priority-aware when its reservation view carries `priority`; then
    the stall/health rules apply. Otherwise only the legacy fixed timeout does
    (plus the hard cap / deadline, which apply to both)."""

    def __init__(self, policy: WaitPolicy, now: float) -> None:
        self.p = policy
        self.start = now
        self.aware = False
        self.progress_at = now  # last progress, client clock
        self.last_ok = now  # last successful poll
        self.unreachable_since: float | None = None
        self.blocked = ""
        self.blocked_since: float | None = None
        self.last_pos: int | None = None
        self._last_line = ""
        self._last_print = -1e18

    def reset_progress(self, now: float) -> None:
        """A requeue/migration: a fresh slot is a fresh start for the stall clock."""
        self.progress_at = now
        self.last_pos = None

    def observe_unreachable(self, now: float) -> None:
        if self.unreachable_since is None:
            self.unreachable_since = now

    def observe(self, view: dict, now: float) -> str | None:
        """Fold in one queued view; return a log line to print, if any."""
        self.last_ok = now
        self.unreachable_since = None
        pos = view.get("position", -1)
        if view.get("priority"):
            self.aware = True
            # The daemon's own clock judges progress (immune to client clock skew).
            sp = view.get("since_progress_seconds") or 0
            self.progress_at = max(self.progress_at, now - float(sp))
        if self.last_pos is not None and isinstance(pos, int) and pos < self.last_pos:
            self.progress_at = now
        self.last_pos = pos if isinstance(pos, int) else self.last_pos
        blocked = view.get("blocked") or ""
        if blocked != self.blocked:
            self.blocked, self.blocked_since = blocked, (now if blocked else None)
        if not self.aware:
            line = f"queued: position {pos}"
            if line != self._last_line:
                self._last_line = line
                return line
            return None
        line = f"queued: position {pos} class={view.get('priority')}"
        eta = view.get("eta_seconds")
        if eta is not None:
            line += f" eta~{_fmt_s(eta)}"
        if blocked:
            line += f" BLOCKED({blocked})"
        stalled = now - self.progress_at
        # Print on change (ignoring the stall counter), else once a minute with it.
        if line != self._last_line or now - self._last_print >= 60:
            self._last_line, self._last_print = line, now
            return line + (f" (no queue progress for {_fmt_s(stalled)})" if stalled >= 60 else "")
        return None

    def should_migrate(self, now: float) -> bool:
        return (
            self.aware
            and self.blocked == "cordoned"
            and self.blocked_since is not None
            and now - self.blocked_since >= self.p.cordon_migrate_after
        )

    def verdict(self, now: float) -> str | None:
        """None to keep waiting, else the reason to give up (completes the sentence
        'reservation X did not activate …')."""
        p = self.p
        waited = now - self.start
        if p.deadline is not None and now >= p.deadline:
            return f"before the CI deadline (HITL_DEADLINE; waited {waited:.0f}s)"
        if p.hard_cap is not None and waited >= p.hard_cap:
            return f"within {p.hard_cap:.0f}s"
        if not self.aware:
            if waited >= p.legacy_timeout:
                return f"within {p.legacy_timeout:.0f}s"
            return None
        if waited >= p.max_wait:
            return f"within the {p.max_wait:.0f}s safety cap (HITL_ACTIVATE_MAX)"
        if now - self.progress_at >= p.stall_timeout:
            return (
                f"(queue stalled: no progress for {now - self.progress_at:.0f}s, "
                f"HITL_QUEUE_STALL_TIMEOUT={p.stall_timeout:.0f}; waited {waited:.0f}s)"
            )
        if (
            self.unreachable_since is not None
            and now - self.unreachable_since >= p.unreachable_timeout
        ):
            return f"(rig unhealthy: daemon unreachable for {now - self.unreachable_since:.0f}s)"
        if (
            self.blocked == "no-unit"
            and self.blocked_since is not None
            and now - self.blocked_since >= p.blocked_timeout
        ):
            return f"(rig unhealthy: no unit can serve this request for {now - self.blocked_since:.0f}s)"
        return None


def _get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 (trusted tailnet)
        return json.load(r)


def _post(url: str, body: dict | None = None, timeout: float = 15.0) -> dict:
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise ReserveError(f"{url}: {e.code} {detail}") from e


def _unit_serves(u: dict, unit_type: str, caps: list[str]) -> bool:
    """Whether a FREE unit can serve the request under the pin rules the pool sees."""
    if u.get("active") is not None:
        return False
    if unit_type and u.get("type") != unit_type:
        return False
    have = set(u.get("capabilities") or [])
    if not set(caps).issubset(have):
        return False
    if not unit_type and u.get("pin_only"):
        return False  # caps-only/unconstrained never targets a pin-only unit
    return True


class Reservation:
    """One reservation held for the session; see the module docstring."""

    def __init__(
        self,
        server: str | None = None,
        owner: str | None = None,
        require: str | None = None,
        require_caps: list[str] | None = None,
        sku: str | None = None,
        device: str | None = None,
        hitl: list[str] | None = None,
    ) -> None:
        # $HITL_SERVER pins a specific rig for every script (the old CLI honored it on
        # every subcommand); an explicit arg still wins.
        self.server = server or os.environ.get("HITL_SERVER") or None
        self._pinned_server = bool(self.server)  # pinned => never migrate off it
        # Scheduling class on a priority-aware daemon: CI sets $HITL_PRIORITY from the
        # GitHub event (merge-queue / pr-ci); humans and agents default to dev.
        self.priority = _priority()
        # Who is reserving (daemon metrics' owner_kind): the harness is automation.
        self.actor = os.environ.get("HITL_ACTOR") or "agent"
        self._hold_timer: threading.Timer | None = None
        self.owner = owner or os.environ.get("HITL_OWNER") or f"hitl-harness@{socket.gethostname()}"
        # `require` is a single capability alias; expand it (analyzer -> the granular
        # logic-analyzer-* tap cap) exactly as the old CLI's parseRequire did, then
        # fold it into require_caps. Without this "analyzer" never matches any unit
        # (units advertise logic-analyzer-led-strip / -spi) and the reservation queues
        # forever.
        caps = list(require_caps or [])
        if require:
            caps.append(_REQUIRE_ALIASES.get(require, require))
        self.require_caps = caps
        # sku -> unit_type (an explicit hardware-class target, e.g. "esp32c6"). Like
        # $HITL_SERVER/$HITL_OWNER above, default it from $HITL_SKU so a target can pin
        # the SoC uniformly via `env` (a c6 netstack test sets HITL_SKU=esp32c6 to skip
        # a same-rig esp32c3 DUT); an explicit arg still wins. This filters by the unit's
        # `type` (see _unit_serves), NOT a capability, so it keeps matching the old-daemon
        # c6 DUTs (which are type esp32c6 but carry no chip:* cap).
        self.sku = sku or os.environ.get("HITL_SKU") or None
        # -> unit (pin by exact name). $HITL_DEVICE pins it for drivers that take no
        # --device flag (e.g. an fx_bench A/B on one DUT), like $HITL_SERVER above.
        self.device = device or os.environ.get("HITL_DEVICE") or None
        self.id: str | None = None
        self.host: str | None = None
        self.port: int | None = None
        self.user: str | None = None
        self.endpoint: str | None = None
        self._unit: str | None = None
        self._reserve_body: dict | None = None  # kept so a lost queued slot can re-queue
        self._hb_stop: threading.Event | None = None
        self._hb_thread: threading.Thread | None = None
        self._keydir: str | None = None
        self._keyfile: str | None = None
        # Always-on DUT serial capture (see serial_capture). On unless
        # HITL_SERIAL_CAPTURE=0; `serial_logs` holds {log name: text} after release().
        self.serial_capture = os.environ.get("HITL_SERIAL_CAPTURE", "1") != "0"
        self._serial_on = False
        self.serial_logs: dict[str, str] = {}

    # --- lifecycle -------------------------------------------------------
    def acquire(self) -> None:
        """Reserve a matching free rig and hold it with a heartbeat thread."""
        self._gen_key()
        if self.priority == "dev":
            self._dev_backoff()
        base = self._pick_server()
        pub = open(self._keyfile + ".pub").read().strip()
        body = {
            "owner": self.owner,
            "ssh_public_key": pub,
            # hitl-reserve scheduling class + actor; a daemon that predates them
            # ignores both (plain FIFO).
            "priority": self.priority,
            "actor": self.actor,
        }
        if self.device:
            body["unit"] = self.device
        if self.sku:
            body["unit_type"] = self.sku
        if self.require_caps:
            body["require_caps"] = self.require_caps
        self._reserve_body = body
        res = _post(base + "/reserve", body)
        self.server = base
        self.id = res.get("id")
        if not self.id:
            raise ReserveError(f"reserve gave no id: {res}")
        self._start_heartbeat()
        # $HITL_ACTIVATE_TIMEOUT, if set, is a hard cap on the wait (s); otherwise a
        # priority-aware daemon is waited on for as long as its queue makes progress
        # (see WaitPolicy), and an old daemon for the legacy fixed 2400 s.
        env = os.environ.get("HITL_ACTIVATE_TIMEOUT")
        self._await_active(float(env) if env else None)
        print(
            f"reserved: id={self.id} on {self.server} unit={self._unit} class={self.priority}",
            flush=True,
        )
        self._start_hold_watchdog()
        self._serial_start()

    def _pick_server(self, pool: list[str] | None = None, allow_cordoned: bool = True) -> str:
        """Pick a host to reserve on. Prefer a host with the MOST free matching units
        (spreads load), else one with a matching busy unit (to queue on), else fail
        immediately. Break ties RANDOMLY so a burst of concurrent reservations (the
        CI suite fires the whole set at once) fans out across the fleet instead of all
        piling onto the first rig. `allow_cordoned=False` refuses to fall back to a
        cordoned host (used when migrating OFF a cordoned one)."""
        if pool is None:
            pool = [self.server] if self.server else _pool()
        if not pool:
            raise ReserveError(
                "no hosts: set --server, $HITL_HOSTS/$HITL_SERVERS, or join a tailnet "
                f"with rigs tagged {os.environ.get('HITL_TAG') or DEFAULT_TAG}"
            )
        free: list[tuple[str, int]] = []  # (host, free-matching-unit count)
        queueable, inventories, errs = [], [], []
        # A cordoned (maintenance/drain) host activates nothing until it's released, and
        # its idle units would otherwise read as FREE and attract every new reservation
        # — the opposite of draining it. Use one only if no other host can serve us.
        cordoned: list[str] = []
        for base in pool:
            try:
                st = _get(base + "/status")
            except Exception as e:  # noqa: BLE001
                errs.append(f"{base}: {e}")
                continue
            units = st.get("units") or []
            inventories.append(
                f"{base}: "
                + ", ".join(
                    f"{u.get('name', '?')} ({u.get('type', '?')}: {','.join(u.get('capabilities') or [])})"
                    for u in units
                )
            )
            n = sum(1 for u in units if self._unit_matches(u) and u.get("active") is None)
            if st.get("cordoned"):
                if any(self._unit_matches(u) for u in units):
                    cordoned.append(base)
                continue
            if n:
                free.append((base, n))
            elif any(self._unit_matches(u) for u in units):
                queueable.append(base)
        if free:
            most = max(n for _, n in free)
            return random.choice([b for b, n in free if n == most])
        if queueable:
            return random.choice(queueable)
        if cordoned and allow_cordoned:
            print(f"all matching hosts are cordoned; queueing on one: {cordoned}", flush=True)
            return random.choice(cordoned)
        requested = (
            f"device={self.device or 'any'}, sku={self.sku or 'any'}, caps={self.require_caps}"
        )
        raise ReserveError(
            f"no reachable host with a matching unit ({requested}); "
            + "; ".join(inventories + errs)
        )

    def _unit_matches(self, u: dict) -> bool:
        """Like _unit_serves but ignoring free/busy — for routing to a queueable host."""
        if self.device and u.get("name") != self.device:
            return False
        if self.sku and u.get("type") != self.sku:
            return False
        if not set(self.require_caps).issubset(set(u.get("capabilities") or [])):
            return False
        if not self.sku and not self.device and u.get("pin_only"):
            return False
        return True

    # --- dev back-off (the documented convention, applied for dev reservations) ---
    def _dev_backoff(self) -> None:
        """Before a DEV reservation enqueues, consult the rigs' cheap GET /queue and
        back off while every rig says dev should wait (CI bursts), instead of piling
        more waiters onto the queue. Bounded by $HITL_BACKOFF_MAX (default 1800 s):
        after that we enqueue anyway and the daemon's priority aging guarantees a
        turn. Disabled with HITL_BACKOFF=0. A rig without /queue (old daemon) or an
        unreachable pool ends the back-off at once (old behaviour)."""
        if os.environ.get("HITL_BACKOFF", "1") == "0":
            return
        budget = float(os.environ.get("HITL_BACKOFF_MAX") or 1800)
        give_up_at = time.time() + budget
        pool = [self.server] if self.server else _pool()
        while True:
            wait = self._dev_retry_after(pool)
            remaining = give_up_at - time.time()
            if wait is None or wait <= 0:
                return
            if remaining <= 0:
                print("[hitl] dev back-off budget spent; enqueueing anyway", flush=True)
                return
            sleep_s = min(remaining, wait * random.uniform(0.8, 1.2))
            print(
                f"[hitl] fleet busy with CI (dev retry-after {wait:.0f}s on every rig); "
                f"backing off {sleep_s:.0f}s before enqueueing (HITL_BACKOFF=0 disables)",
                flush=True,
            )
            time.sleep(sleep_s)

    def _dev_retry_after(self, pool: list[str]) -> float | None:
        """The smallest dev retry-after hint (s) across the pool for a unit type this
        request can use; 0 = go ahead now, None = no hint available (old daemon,
        unreachable pool, or no matching type) -> don't back off."""
        best: float | None = None
        for base in pool:
            try:
                st = _get(base + "/status", timeout=5)
                q = _get(base + "/queue", timeout=5)
            except Exception:  # noqa: BLE001 (old daemon: 404 on /queue; or unreachable)
                return None
            types = {u.get("type") for u in st.get("units") or [] if self._unit_matches(u)}
            for t in q.get("types") or []:
                if t.get("type") in types:
                    v = float(t.get("retry_after_seconds") or 0)
                    best = v if best is None else min(best, v)
        return best

    # The whole CI suite fires at once against a small fleet, so a queue behind a
    # multi-minute soak is routine. A priority-aware daemon reports queue progress, so
    # we wait while it drains and give up only on a STALL, an unhealthy rig, a hard
    # cap or the CI job's deadline (WaitPolicy); against an old daemon we keep the
    # legacy fixed timeout. On giving up we RELEASE so we don't strand a queued slot
    # with the heartbeat thread keeping it alive; on an interrupt (Ctrl-C, SIGTERM
    # from a test timeout) we release too, so a killed client never leaks its slot.
    def _await_active(
        self, timeout: float | None = None, legacy_timeout: float | None = None
    ) -> None:
        try:
            self._await_active_inner(WaitPolicy.from_env(timeout, legacy_timeout))
        except (KeyboardInterrupt, SystemExit):
            # Interrupted while queued (Ctrl-C, or SIGTERM -> SystemExit from a test
            # timeout / cancelled job): release, or the slot outlives us until its
            # lease lapses and then activates for nobody.
            if self.id:
                try:
                    self.release(outcome="cancelled")
                except Exception:  # noqa: BLE001
                    pass
            raise

    def _await_active_inner(self, policy: "WaitPolicy") -> None:
        watch = QueueWatch(policy, time.time())
        requeues = 0
        while True:
            now = time.time()
            reason = watch.verdict(now)
            if reason:
                break
            try:
                r = _get(f"{self.server}/reservation/{self.id}")
            except urllib.error.HTTPError as e:
                # 404 while QUEUED = the daemon lost our slot (it keeps its queue in
                # memory; a redeploy/restart drops every waiter). Re-queue on the same
                # host instead of failing the test attempt — we lose our position, not
                # the run. Bounded, so a daemon that keeps forgetting us still fails.
                if e.code != 404 or not self._reserve_body or requeues >= _MAX_REQUEUES:
                    raise
                old = self.id
                try:
                    res = _post(f"{self.server}/reserve", self._reserve_body)
                except ReserveError as re_err:
                    if re.search(r": 4\d\d ", str(re_err)):
                        raise  # rejected (e.g. the pinned unit is gone): a real error
                    time.sleep(5)  # daemon still coming up (5xx); retry the GET loop
                    continue
                except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
                    time.sleep(5)  # daemon not listening yet; retry the GET loop
                    continue
                self.id = res.get("id") or old
                requeues += 1
                print(
                    f"requeued: daemon lost reservation {old} (restart?); now {self.id}", flush=True
                )
                watch.reset_progress(time.time())
                continue
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
                # Daemon briefly unreachable (restarting): keep waiting, within policy.
                watch.observe_unreachable(time.time())
                time.sleep(5)
                continue
            state = r.get("state")
            if state == "active":
                ep = r.get("endpoint") or {}
                self.port, self.user = ep.get("port"), ep.get("user")
                # Reach the container over the SAME address we reached the daemon at,
                # not the daemon's advertised endpoint host — that may be a .local
                # (mDNS) name that doesn't resolve from every client, whereas the pool
                # address (a tailnet MagicDNS name) does. Matches the old CLI, which
                # derived the ssh host from the server URL rather than trusting --host.
                self.host = _host_of(self.server) or ep.get("host")
                self._unit = r.get("unit")
                self.endpoint = f"{self.user}@{self.host}:{self.port}"
                # The daemon marks active as the container starts; give its sshd a
                # moment to bind so the first scp/ssh doesn't race it (best-effort, as
                # the old CLI's waitPort did — proceed regardless so a real failure
                # surfaces on the actual scp/ssh with a clear error).
                _wait_port(self.host, int(self.port), timeout=45)
                return
            if state == "released":
                raise ReserveError(f"reservation released before activating: {r.get('message')}")
            line = watch.observe(r, time.time())
            if line:
                print(line, flush=True)
            if (
                watch.should_migrate(time.time())
                and requeues < _MAX_REQUEUES
                and self._migrate_off_cordoned()
            ):
                requeues += 1
                watch.reset_progress(time.time())
                continue
            time.sleep(2)
        reservation_id = self.id
        try:
            self.release()
        except Exception:  # noqa: BLE001
            pass
        raise ReserveError(f"reservation {reservation_id} did not activate {reason}")

    def _migrate_off_cordoned(self) -> bool:
        """Our host went into maintenance while we were queued (a redeploy drain can
        take hours). If we weren't pinned to it and another host can serve us, move:
        release here, re-reserve there. Returns whether we moved."""
        if self._pinned_server:
            return False
        try:
            others = [b for b in _pool() if b != self.server]
            if not others or not self._reserve_body:
                return False
            target = self._pick_server(pool=others, allow_cordoned=False)
            res = _post(f"{target}/reserve", self._reserve_body)
        except Exception as e:  # noqa: BLE001 (no alternative: keep waiting here)
            print(f"[hitl] host cordoned; no other host to move to ({e})", flush=True)
            return False
        if not res.get("id"):
            return False
        old_server, old_id = self.server, self.id
        try:
            _post(f"{old_server}/reservation/{old_id}/release")
        except Exception:  # noqa: BLE001 (its lease will lapse)
            pass
        self.server, self.id = target, res["id"]
        print(
            f"migrated: {old_server} is cordoned; re-queued on {target} as {self.id}",
            flush=True,
        )
        return True

    def _start_heartbeat(self) -> None:
        self._hb_stop = threading.Event()

        def beat() -> None:
            while not self._hb_stop.wait(20):
                try:
                    _post(f"{self.server}/reservation/{self.id}/heartbeat")
                except Exception:  # noqa: BLE001
                    pass  # transient; the next tick retries, the reaper is the backstop

        self._hb_thread = threading.Thread(target=beat, daemon=True)
        self._hb_thread.start()

    def _start_hold_watchdog(self) -> None:
        """$HITL_HOLD_MAX (s): bound how long this process may HOLD the unit once
        active. CI sets it because the per-test Bazel timeout is raised to cover long
        queue waits — without this a hung test body would now pin a scarce board for
        hours. On expiry we SIGTERM ourselves: the harness's SIGTERM hook turns that
        into SystemExit, so `finally: release()` still fetches the serial log and
        frees the unit (outcome=cancelled)."""
        hold_max = float(os.environ.get("HITL_HOLD_MAX") or 0)
        if hold_max <= 0:
            return

        def fire() -> None:
            print(
                f"[hitl] held the unit for HITL_HOLD_MAX={hold_max:.0f}s; terminating to free it",
                flush=True,
            )
            os.kill(os.getpid(), signal.SIGTERM)

        self._hold_timer = threading.Timer(hold_max, fire)
        self._hold_timer.daemon = True
        self._hold_timer.start()

    def release(self, outcome: str | None = None) -> None:
        # Fetch the DUT serial log BEFORE releasing (the container goes with the lease),
        # and dump its tail right away if we're unwinding from a failure.
        exc = sys.exc_info()[1]
        failing = _exc_is_failure(exc)
        if outcome is None and (_TERMINATING or isinstance(exc, KeyboardInterrupt)):
            outcome = "cancelled"  # the run was killed (test timeout / Ctrl-C), not done
        if self._hold_timer is not None:
            self._hold_timer.cancel()
            self._hold_timer = None
        self._serial_fetch()
        if failing:
            _dump_serial_logs()
        if self._hb_stop:
            self._hb_stop.set()
        if self.id and self.server:
            # ?outcome=cancelled is accounted separately in the daemon's capacity
            # metrics; an older daemon ignores the query string.
            q = "?outcome=cancelled" if outcome == "cancelled" else ""
            try:
                _post(f"{self.server}/reservation/{self.id}/release{q}")
                print("released", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"release: {e}", flush=True)
        self.id = None
        if self._keydir:
            shutil.rmtree(self._keydir, ignore_errors=True)
            self._keydir = None

    def __enter__(self) -> "Reservation":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()

    # --- DUT serial capture (serial_capture) -------------------------------
    def _serial_start(self) -> None:
        if not self.serial_capture or not self.user:
            return
        try:
            p = self.ssh(serial_capture.install_cmd(), capture=True, timeout=60, _raw=True)
            out = ((p.stdout or "") + (p.stderr or "")).strip().splitlines()
            line = out[-1] if out else f"rc={p.returncode}"
            self._serial_on = (
                p.returncode == 0
                and line.startswith("serial-capture: ")
                and not line.endswith((": none", "pyserial"))
            )
            print(f"[serial] {line}", flush=True)
        except Exception as e:  # noqa: BLE001 — capture must never fail the test
            print(f"[serial] capture unavailable: {e}", flush=True)

    def _serial_fetch(self) -> None:
        if not self._serial_on:
            return
        self._serial_on = False
        try:
            p = self.ssh(serial_capture.fetch_cmd(), capture=True, timeout=90, _raw=True)
            logs = serial_capture.parse_fetch(p.stdout or "")
        except Exception as e:  # noqa: BLE001
            print(f"[serial] could not fetch the DUT serial log: {e}", flush=True)
            return
        out_dir = (
            os.environ.get("HITL_SERIAL_LOG_DIR")
            or os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR")
            or tempfile.gettempdir()
        )
        target = os.environ.get("TEST_TARGET") or os.path.basename(sys.argv[0])
        for name, text in logs.items():
            self.serial_logs[name] = text
            label = f"{self._unit} {name} (reservation {self.id})"
            try:
                os.makedirs(out_dir, exist_ok=True)
                path = os.path.join(
                    out_dir,
                    serial_capture.log_filename(target, self._unit or "", self.id or "", name),
                )
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
            except OSError as e:
                path = f"(not saved: {e})"
            _SERIAL_LOGS.append([label, text, False])
            print(f"[serial] {label}: {len(text.splitlines())} lines -> {path}", flush=True)

    def serial_tail(self, n: int = serial_capture.TAIL_LINES) -> str:
        """The last `n` lines of every DUT serial log fetched at release()."""
        return "\n".join(serial_capture.format_tail(k, v, n) for k, v in self.serial_logs.items())

    # --- ssh key ---------------------------------------------------------
    def _gen_key(self) -> None:
        self._keydir = tempfile.mkdtemp(prefix="hitl-key-")
        self._keyfile = os.path.join(self._keydir, "id")
        subprocess.run(
            [
                "ssh-keygen",
                "-t",
                "ed25519",
                "-N",
                "",
                "-q",
                "-f",
                self._keyfile,
                "-C",
                "hitl-harness",
            ],
            check=True,
        )

    def _ssh_base(self) -> list[str]:
        return [
            "ssh",
            "-i",
            self._keyfile,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-p",
            str(self.port),
        ]

    # --- operations ------------------------------------------------------
    def ssh(
        self,
        remote_cmd: list[str] | str,
        capture: bool = False,
        timeout: float | None = None,
        _raw: bool = False,
    ) -> subprocess.CompletedProcess:
        """Run a shell command in the reservation's container. A command that opens
        the DUT's serial port itself (serial_capture.needs_port) runs with the
        background serial capture paused around it."""
        if isinstance(remote_cmd, list):
            remote_cmd = shlex.join(remote_cmd)
        if not _raw and self._serial_on and serial_capture.needs_port(remote_cmd):
            remote_cmd = serial_capture.wrap_port_cmd(remote_cmd)
        argv = self._ssh_base() + [f"{self.user}@{self.host}", "sh", "-c", shlex.quote(remote_cmd)]
        return subprocess.run(
            argv,
            check=False,
            timeout=timeout,
            capture_output=capture,
            text=capture or None,
            encoding="utf-8" if capture else None,
            errors="replace" if capture else None,
        )

    # Well-known container path of the per-rig "serialize the USB-serial device ops"
    # lock dir. The daemon bind-mounts it (a host-shared dir) into every container
    # ONLY on a rig configured to serialize those ops — a board whose one shared USB
    # bus can't run two DUTs' flash/monitor at once (a Pi 3: all USB ports + the
    # radio dongle hang off a single USB 2.0 hub). Where the mount is absent (a Pi 5,
    # which flashes two DUTs concurrently fine) the lock is a no-op and ops run
    # unserialized. This is the flash-side twin of the BLE provisioning lock
    # (hitl_improv.py's /run/hitl/provision-lock), so each rig can DESCRIBE which
    # device ops it must serialize purely by which lock dirs its daemon mounts.
    SERIALIZE_LOCK_DIR = "/run/hitl/flash-lock"

    def ssh_serialized(
        self,
        remote_cmd: list[str] | str,
        capture: bool = False,
        timeout: float | None = None,
        lock_dir: str | None = None,
    ) -> subprocess.CompletedProcess:
        """Like ssh(), but hold a per-rig flock across the command when this rig is
        configured to serialize USB-serial device ops (see SERIALIZE_LOCK_DIR).

        Wraps the command in a tiny in-container python that flocks lock_dir/lock
        (LOCK_EX) for the command's duration IF lock_dir exists, else runs it
        unwrapped — so two containers on a serialize-configured rig never drive the
        shared USB bus at once (flash vs flash, flash vs monitor/reset), while a
        capable rig without the mount is unaffected. The container has python3 (the
        toolbox) but no flock(1), so the lock is taken in python. The real command is
        passed base64'd to sidestep the double sh -c quoting.
        """
        lock_dir = lock_dir or self.SERIALIZE_LOCK_DIR
        if isinstance(remote_cmd, list):
            remote_cmd = shlex.join(remote_cmd)
        # Pause the serial capture INSIDE the base64'd command (ssh() can't see it).
        if self._serial_on and serial_capture.needs_port(remote_cmd):
            remote_cmd = serial_capture.wrap_port_cmd(remote_cmd)
        b64 = base64.b64encode(remote_cmd.encode()).decode()
        py = (
            "import base64,fcntl,os,subprocess,sys;"
            f"d={lock_dir!r};"
            "fd=(os.open(d+'/lock',os.O_CREAT|os.O_RDWR,0o666) if os.path.isdir(d) else None);"
            "(fcntl.flock(fd,fcntl.LOCK_EX) if fd is not None else None);"
            "sys.exit(subprocess.call(['sh','-c',base64.b64decode(sys.argv[1]).decode()]))"
        )
        wrapped = f"python3 -c {shlex.quote(py)} {b64}"
        return self.ssh(wrapped, capture=capture, timeout=timeout, _raw=True)

    # Well-known container path of the per-rig "AP-exclusive bandwidth" lock dir — the
    # airtime twin of the flash/BLE-adapter locks. Every DUT on a rig shares ONE AP on
    # ONE 2.4 GHz channel with no airtime-fairness lever, so under concurrent multi-DUT
    # load a sibling's throughput starves the channel and breaks cross-DUT isolation.
    # A bandwidth-heavy test holds this flock across ONLY its throughput body, so those
    # bodies take turns on the air while every other phase (setup, idle control, decode)
    # still runs in parallel. The daemon bind-mounts the dir (a host-shared dir) into
    # every reservation container, making the flock a host-wide mutex across the rig's
    # containers; where the mount is absent (a rig not yet redeployed) the lock is a
    # no-op and traffic runs unserialized, exactly as today.
    #
    # Unlike ssh_serialized (which flocks for the duration of ONE remote command), the
    # bench traffic is driven from THIS process over an ssh `-L` tunnel, so the lock has
    # to be held on the rig across a local Python block. ap_lock() does that with a
    # long-lived ssh running a tiny in-container holder that flocks the dir and then
    # blocks until we release it (or its heartbeat lapses).
    AP_LOCK_DIR = "/run/hitl/ap-lock"

    @contextmanager
    def ap_lock(self, reason: str = "", heartbeat: float = 10.0, lock_dir: str | None = None):
        """Hold the per-rig AP-exclusive bandwidth flock across the enclosed block.

        Spawns a long-lived ssh into the reservation container running a holder that
        flocks `lock_dir/ap.lock` (LOCK_EX) — blocking until a sibling releases it —
        and then idles until we tell it to let go. We feed it a heartbeat line every
        `heartbeat`s over the ssh stdin; the holder releases (exits, closing its fd) on
        a clean EOF at context exit OR if it misses ~3 heartbeats. That heartbeat is the
        unconditional guard: if THIS process is killed the heartbeat thread stops with
        it, so the holder times out and flock auto-releases — a crashed/killed test can
        never strand the rig's airtime. Best-effort: no lock dir (rig not yet
        redeployed) ⇒ the holder prints UNSERIALIZED and we run the body unserialized.

        LOCK ORDER: benches take ONLY this lock, and always AFTER provisioning has
        released the BLE-adapter lock, so the global order (adapter before AP) holds and
        the two locks can't deadlock — see hitl_improv._ap_lock.
        """
        lock_dir = lock_dir or self.AP_LOCK_DIR
        hb_timeout = max(heartbeat * 3.0, 5.0)  # holder releases if it misses ~3 beats
        py = _ap_holder_script(lock_dir, hb_timeout)
        argv = self._ssh_base() + [
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=3",
            f"{self.user}@{self.host}",
            f"python3 -c {shlex.quote(py)}",
        ]
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1
        )
        hb_stop = threading.Event()
        hb_thread: threading.Thread | None = None
        try:
            t0 = time.monotonic()
            held = False
            while True:
                line = proc.stdout.readline() if proc.stdout else ""
                if line == "":  # holder exited before a status ⇒ best-effort proceed
                    print(
                        f"[ap-lock] holder exited before acquiring (rc={proc.poll()}); "
                        "proceeding unserialized",
                        flush=True,
                    )
                    break
                tok = line.strip()
                if tok == "UNSERIALIZED":
                    print(
                        "[ap-lock] rig has no AP lock dir (pre-redeploy); "
                        "proceeding unserialized",
                        flush=True,
                    )
                    break
                if tok == "WAIT":
                    print(f"[ap-lock] waiting for rig AP-exclusive lock ({reason})…", flush=True)
                    continue
                if tok == "HELD":
                    held = True
                    print(
                        f"[ap-lock] AP lock held ({reason}; waited "
                        f"{time.monotonic() - t0:.1f}s)",
                        flush=True,
                    )
                    break
                # any other line is holder noise; keep reading for the status token
            if held:

                def _beat() -> None:
                    while not hb_stop.wait(heartbeat):
                        try:
                            proc.stdin.write("beat\n")
                            proc.stdin.flush()
                        except (BrokenPipeError, ValueError, OSError):
                            return  # holder gone; the reaper/EOF path releases it

                hb_thread = threading.Thread(target=_beat, daemon=True)
                hb_thread.start()
            yield
        finally:
            hb_stop.set()
            # Clean release: close stdin ⇒ holder sees EOF ⇒ exits ⇒ flock released.
            try:
                if proc.stdin:
                    proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            if hb_thread is not None:
                hb_thread.join(timeout=2)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.terminate()  # backstop; SIGHUP to the holder also frees the flock
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    def scp_to(self, locals_: list[str], remote_dir: str) -> None:
        argv = [
            "scp",
            "-i",
            self._keyfile,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-P",
            str(self.port),
            *locals_,
            f"{self.user}@{self.host}:{remote_dir}",
        ]
        subprocess.run(argv, check=True)

    def wifi(self) -> tuple[str, str] | None:
        """The rig's provisioning-network creds as (ssid, psk), or None if it runs
        none. Lets the e2e provision the DUT onto the rig's own AP with no external
        network — the daemon serves the creds via /status.provisioning."""
        try:
            st = _get(f"{self.server}/status")
        except Exception:  # noqa: BLE001
            return None
        p = st.get("provisioning")
        if not p or not p.get("ssid"):
            return None
        return (p["ssid"], p.get("psk", ""))

    def wifi_stations(self, dut_ip: str | None = None) -> dict:
        """The rig AP's per-station link stats for THIS reservation's DUT(s).

        The rig hosts the provisioning AP the DUT joins, so the AP sees the DUT's
        real radio link (what a test can't see from inside the DUT): tx/rx bitrate,
        retries, tx_failed, signal, bytes/packets, per station MAC — from the
        daemon's `iw dev <ap> station dump` (GET /reservation/<id>/wifi). E.g. a
        video-latency test reads `rx_bitrate_mbps` (station -> AP) to know the
        fixture's actual uplink rate.

        The daemon only ever reports stations this reservation OWNS: a network DUT's
        address is owned automatically; a USB board's station (a fresh random MAC
        every boot) is owned by CLAIMING the IP it was provisioned to — pass
        `dut_ip` (exclusive among active reservations; idempotent, so passing it on
        every call is fine and re-resolves the DUT's current MAC). Returns the
        report: {reservation, unit, iface, time, stations: [{mac, ip, hostname,
        signal_dbm, signal_avg_dbm, tx_bitrate_mbps, rx_bitrate_mbps, tx_retries,
        tx_failed, ..., raw}], missing: [owned IPs with no station right now]}.
        Raises ReserveError if not reserved, if the rig's daemon predates the
        endpoint / runs no AP (404/501), or if another reservation owns the IP.
        """
        if not self.id or not self.server:
            raise ReserveError("wifi_stations: no active reservation")
        url = f"{self.server}/reservation/{self.id}/wifi"
        if dut_ip:
            return _post(url, {"ip": dut_ip})
        try:
            return _get(url)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise ReserveError(f"{url}: {e.code} {detail}") from e

    def wifi_station(self, dut_ip: str) -> dict | None:
        """The AP's stats for the one station at `dut_ip` (claimed for this
        reservation), or None if it isn't associated right now. See wifi_stations."""
        rep = self.wifi_stations(dut_ip)
        return next((s for s in rep.get("stations") or [] if s.get("ip") == dut_ip), None)

    def assert_reachable(
        self,
        host: str,
        ports: tuple[int, ...] = (80, 81, 443),
        tries: int = 3,
        connect_timeout: int = 2,
    ) -> None:
        """Fail fast if the DUT isn't reachable from the rig before we tunnel to it.

        A board that associated with a *foreign* rig's AP (e.g. two co-located rigs
        sharing a provisioning SSID) provisions fine and reports an IP, but that IP
        lives on the other rig's LAN — every forward through THIS rig then dials into
        the void and the test dies much later with a vague "ws never came up". Probe
        the DUT's TCP ports from the rig's own network so that case fails immediately
        with an actionable message. A DUT on the right AP answers (open) or RSTs
        (closed) instantly, so this only spends real time when the board is genuinely
        unreachable (the connect hangs to the timeout). Any open port proves the DUT
        is on this rig's LAN — we don't require the player socket specifically, so
        this never races the WebSocket server's boot.

        `forward()` prepends the exact port it is about to tunnel to, so a network
        DUT that serves only on a non-default port is probed on that port too: the
        led-mapper-pi's player is wss:8443 and it never listens on 80/81/443, so
        the ESP32-only default set would false-flag it as "unreachable / foreign
        AP" on every subnet. The forwarded port is the one that actually matters —
        if the rig can open it, the tunnel works.
        """
        ports = tuple(dict.fromkeys(ports))  # de-dup (the forwarded port may be 443)
        portlist = " ".join(str(p) for p in ports)
        # POSIX sh (no `seq`); /dev/tcp is a bash feature, so the connect is bash -c.
        probe = (
            f"n=0; while [ $n -lt {tries} ]; do for p in {portlist}; do "
            f'timeout {connect_timeout} bash -c "exec 3<>/dev/tcp/{host}/$p" 2>/dev/null '
            f"&& exit 0; done; n=$((n+1)); sleep 2; done; exit 7"
        )
        try:
            proc = self.ssh(
                probe, capture=True, timeout=tries * (len(ports) * connect_timeout + 3) + 30
            )
        except subprocess.TimeoutExpired as e:
            # The probe bounds itself on the rig; only the ssh link can hang this long.
            raise ReserveError(f"could not probe DUT {host} from the rig (ssh hung)") from e
        if proc.returncode == 0:
            return
        if proc.returncode != 7:  # not the probe's verdict: ssh/the rig itself failed
            raise ReserveError(
                f"could not probe DUT {host} from the rig (ssh exited {proc.returncode})"
            )
        raise DutUnreachable(
            f"DUT {host} is unreachable from the rig (no TCP on {portlist} after "
            f"{tries} tries). The board most likely joined a foreign AP — check for a "
            f"duplicate provisioning SSID across rigs (`hitl wifi`) — or never joined "
            f"WiFi. Failing here instead of a later, vaguer WebSocket timeout."
        )

    @contextmanager
    def forward(self, remote_host: str, remote_port: int):
        """Local-forward a fresh localhost port to remote_host:remote_port via the rig.

        The tunnel's far end is dialed FROM the reservation's container (the -L
        target is resolved on the ssh server side), so the rig reaches the device;
        this host only needs to reach the rig. Yields the chosen local port.

        Preflight: assert the target is reachable from the rig first (all forwards
        in this harness target a just-provisioned DUT), turning a stray-board
        association into a clear error rather than a downstream socket timeout.
        """
        self.assert_reachable(remote_host, ports=(remote_port, 80, 81, 443))
        local_port = _free_local_port()
        # ExitOnForwardFailure so ssh dies (rather than sitting with no tunnel) if the
        # local bind fails — otherwise the caller would burn its retry budget dialing a
        # port nothing listens on.
        argv = self._ssh_base() + [
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            f"{local_port}:{remote_host}:{remote_port}",
            f"{self.user}@{self.host}",
        ]
        proc = subprocess.Popen(argv)
        try:
            if not _wait_listen(local_port, timeout=20) or proc.poll() is not None:
                raise ReserveError(
                    f"tunnel to {remote_host}:{remote_port} via {self.host} did not come up "
                    f"(ssh exited {proc.poll()})"
                )
            print(
                f"tunnel: localhost:{local_port} -> (rig) -> {remote_host}:{remote_port}",
                flush=True,
            )
            yield local_port
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


# Set once SIGTERM arrives (a Bazel test timeout, a cancelled CI job, or the
# HITL_HOLD_MAX watchdog): release() then reports outcome=cancelled.
_TERMINATING = False

# --- failure hooks: print the DUT serial tail when the test is failing ------------
# [label, text, dumped] for every log fetched in this process.
_SERIAL_LOGS: list[list] = []
_HOOKS_INSTALLED = False


def _exc_is_failure(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    if isinstance(exc, SystemExit):
        return exc.code not in (0, None)
    return True


def _dump_serial_logs() -> None:
    for entry in _SERIAL_LOGS:
        label, text, dumped = entry
        if not dumped:
            entry[2] = True
            print(serial_capture.format_tail(label, text), flush=True)


def _install_failure_hooks() -> None:
    """Make "failing" visible to the serial dump however a test fails: a non-zero
    sys.exit(), an uncaught exception, or bazel's SIGTERM on a test timeout (turned
    into SystemExit so `finally: res.release()` still fetches the log). Idempotent.

    Installed at IMPORT, not at acquire(): `sys.exit(main())` looks up `sys.exit`
    BEFORE calling main(), so patching it from inside main() is too late. With no
    captured logs the hooks are no-ops."""
    global _HOOKS_INSTALLED
    if _HOOKS_INSTALLED:
        return
    _HOOKS_INSTALLED = True
    orig_exit, orig_hook = sys.exit, sys.excepthook

    def _exit(code=0):
        if code not in (0, None):
            _dump_serial_logs()
        orig_exit(code)

    def _hook(tp, val, tb):
        orig_hook(tp, val, tb)
        _dump_serial_logs()

    sys.exit, sys.excepthook = _exit, _hook
    if threading.current_thread() is threading.main_thread():
        try:
            if signal.getsignal(signal.SIGTERM) in (signal.SIG_DFL, None):

                def _term(signum, _frame):
                    global _TERMINATING
                    _TERMINATING = True
                    print("[serial] SIGTERM (test timeout?) — releasing", flush=True)
                    raise SystemExit(128 + signum)

                signal.signal(signal.SIGTERM, _term)
        except (ValueError, OSError):
            pass


def _ap_holder_script(lock_dir: str, hb_timeout: float) -> str:
    """The in-container AP-lock holder that Reservation.ap_lock runs over ssh.

    No lock dir ⇒ print UNSERIALIZED and exit (best-effort: a rig not yet redeployed
    runs unserialized). Otherwise flock `lock_dir/ap.lock` (LOCK_EX) — announcing WAIT
    before the blocking acquire so the caller knows the link is up, HELD once acquired
    — then hold until stdin EOF (clean release at context exit) OR a heartbeat gap of
    `hb_timeout`s (the caller died and its heartbeat thread stopped). The fd closes on
    exit either way, so flock auto-releases and a crashed/killed test can't strand the
    rig's airtime. Kept as a builder so it can be unit-tested offline (the container
    has python3 but no flock(1), so the lock has to be taken in python)."""
    return (
        "import fcntl,os,select,sys\n"
        f"d = {lock_dir!r}\n"
        f"hb = {hb_timeout!r}\n"
        "if not os.path.isdir(d):\n"
        "    sys.stdout.write('UNSERIALIZED\\n'); sys.stdout.flush(); sys.exit(0)\n"
        "fd = os.open(d + '/ap.lock', os.O_CREAT | os.O_RDWR, 0o666)\n"
        "sys.stdout.write('WAIT\\n'); sys.stdout.flush()\n"
        "fcntl.flock(fd, fcntl.LOCK_EX)\n"
        "sys.stdout.write('HELD\\n'); sys.stdout.flush()\n"
        "while True:\n"
        "    r, _, _ = select.select([sys.stdin], [], [], hb)\n"
        "    if not r or not sys.stdin.readline():\n"
        "        break\n"  # heartbeat gap (caller gone) or EOF (clean release)
    )


def _free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_port(host: str, port: int, timeout: float) -> bool:
    """Block until host:port accepts a TCP connection, or timeout. Returns success."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            try:
                if s.connect_ex((host, port)) == 0:
                    return True
            except OSError:
                pass
        time.sleep(0.3)
    return False


def _wait_listen(port: int, timeout: float) -> bool:
    return _wait_port("127.0.0.1", port, timeout)


def queue_status(pool: list[str] | None = None) -> list[dict]:
    """Every pool host's cheap queue overview (GET /queue on a priority-aware
    daemon): depth per class, per unit type the ETA a new reservation of each class
    would face and the dev back-off hint. A host that can't answer appears as
    {"url": ..., "error": ...}. See AGENTS.md "Queue etiquette"."""
    out = []
    for base in pool if pool is not None else _pool():
        try:
            q = _get(base + "/queue", timeout=5)
            q["url"] = base
            out.append(q)
        except Exception as e:  # noqa: BLE001
            out.append({"url": base, "error": str(e)})
    return out


def _print_queue(summaries: list[dict]) -> None:
    for q in summaries:
        if "error" in q:
            print(f"{q['url']}  UNAVAILABLE ({q['error']})")
            continue
        maint = "  CORDONED" if q.get("cordoned") else ""
        print(f"{q['url']}  queued={q.get('queue_length', 0)}{maint}")
        for c in q.get("classes") or []:
            print(
                f"  class {c['class']:<12} queued={c['queued']:<3} "
                f"oldest={_fmt_s(c.get('oldest_wait_seconds', 0))}"
            )
        for t in q.get("types") or []:
            etas = " ".join(
                f"{k}~{_fmt_s(v)}" for k, v in sorted((t.get("eta_new_seconds") or {}).items())
            )
            ra = t.get("retry_after_seconds") or 0
            hint = "dev: go ahead" if not ra else f"dev: back off {_fmt_s(ra)}"
            print(
                f"  type  {t['type']:<14} units={t['units']} free={t['free']} "
                f"queued={t['queued']} eta-new[{etas}]  {hint}"
            )


_install_failure_hooks()

if __name__ == "__main__":
    # `python3 hitl_client.py queue [--json]`: the cheap pre-reserve check.
    if len(sys.argv) >= 2 and sys.argv[1] == "queue":
        res = queue_status()
        if "--json" in sys.argv[2:]:
            print(json.dumps(res, indent=2))
        else:
            _print_queue(res)
    else:
        print("usage: hitl_client.py queue [--json]", file=sys.stderr)
        sys.exit(2)
