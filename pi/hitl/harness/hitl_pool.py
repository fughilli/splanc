"""HITL runner-pool orchestration — pick a free rig from a pool.

The rig is a single-DUT bench: one ESP32-C6, one active reservation at a time
(see pi/hitl/DESIGN.md). To scale past one board we run several rigs and pool
them. Each rig runs its own `hitl-managerd` and is reachable at its own base
URL over the tailnet; this module holds the small bit of extra orchestration
the issue calls for — "find a free runner" — that a single-rig CLI doesn't need.

Pool membership is an environment variable, HITL_SERVERS: a list of base URLs
(or bare hostnames, defaulted to http://<host>:8087), comma- or whitespace-
separated. Example:

    export HITL_SERVERS="hitl-rig-1, hitl-rig-2, http://hitl-rig-3:8087"

`pick()` queries every rig's /status concurrently and returns the best free
one: idle rigs first (shortest queue as the tiebreak), skipping any that don't
answer. It's the reservation client's (hitl_client.py) server selector, and is
exposed as a CLI for humans/agents:

    python3 hitl_pool.py status          # one line per rig
    python3 hitl_pool.py pick            # print the chosen base URL (for $HITL_SERVER)
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_PORT = 8087
STATUS_TIMEOUT = 4.0  # seconds per /status probe


def normalize_base(entry: str) -> str:
    """A pool entry -> a base URL. Bare hostnames get http:// and the daemon port."""
    e = entry.strip().rstrip("/")
    if not e:
        return ""
    if "://" not in e:
        e = f"http://{e}"
    # Add the default daemon port if the caller gave only a scheme+host.
    rest = e.split("://", 1)[1]
    if ":" not in rest.split("/", 1)[0]:
        e = f"{e}:{DEFAULT_PORT}"
    return e


def parse_servers(value: str | None) -> list[str]:
    """Parse HITL_SERVERS (comma/whitespace-separated) into normalized base URLs."""
    if not value:
        return []
    raw = value.replace(",", " ").split()
    seen: dict[str, None] = {}  # dedupe, preserve order
    for entry in raw:
        base = normalize_base(entry)
        if base:
            seen.setdefault(base, None)
    return list(seen)


def servers_from_env() -> list[str]:
    """Pool from HITL_SERVERS, or the single HITL_SERVER as a one-rig pool."""
    pool = parse_servers(os.environ.get("HITL_SERVERS"))
    if pool:
        return pool
    return parse_servers(os.environ.get("HITL_SERVER"))


class RigStatus:
    """A rig's reachability + queue state, as seen by a /status probe."""

    def __init__(self, base: str, status: dict | None, error: str | None):
        self.base = base
        self.status = status
        self.error = error

    @property
    def reachable(self) -> bool:
        return self.status is not None

    @property
    def busy(self) -> bool:
        """True if a reservation currently holds the rig."""
        return bool(self.status and self.status.get("active"))

    @property
    def queue_length(self) -> int:
        return int((self.status or {}).get("queue_length", 0))

    @property
    def load(self) -> int:
        """Waiters ahead of a new reservation: queue + (1 if the rig is held)."""
        return self.queue_length + (1 if self.busy else 0)

    def line(self) -> str:
        if not self.reachable:
            return f"{self.base}\tUNREACHABLE\t{self.error}"
        rig = self.status.get("rig", "?")
        state = "busy" if self.busy else "idle"
        return f"{self.base}\t{rig}\t{state}\tqueue={self.queue_length}"


def probe(base: str, timeout: float = STATUS_TIMEOUT) -> RigStatus:
    """GET base/status; never raises — failures come back as an unreachable rig."""
    try:
        with urllib.request.urlopen(base + "/status", timeout=timeout) as resp:
            return RigStatus(base, json.load(resp), None)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as e:
        return RigStatus(base, None, f"{type(e).__name__}: {e}")


def probe_all(bases: list[str], timeout: float = STATUS_TIMEOUT) -> list[RigStatus]:
    """Probe every rig concurrently; results keep the input order."""
    if not bases:
        return []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(bases)) as ex:
        return list(ex.map(lambda b: probe(b, timeout), bases))


def choose(statuses: list[RigStatus]) -> RigStatus | None:
    """Best free rig: reachable, then least-loaded (idle before queued), stable.

    Ties break toward the earlier pool entry (Python's sort is stable), so a
    fixed pool order gives deterministic, sticky selection.
    """
    reachable = [s for s in statuses if s.reachable]
    if not reachable:
        return None
    return min(reachable, key=lambda s: s.load)


def pick(bases: list[str] | None = None, timeout: float = STATUS_TIMEOUT) -> str:
    """Return the base URL of the best free rig, or raise if none is reachable."""
    bases = bases if bases is not None else servers_from_env()
    if not bases:
        raise RuntimeError("no HITL runners configured (set HITL_SERVERS or HITL_SERVER)")
    best = choose(probe_all(bases, timeout))
    if best is None:
        raise RuntimeError(f"no reachable HITL runner in pool: {', '.join(bases)}")
    return best.base


def _main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "pick"
    bases = servers_from_env()
    if not bases:
        print("no HITL runners configured (set HITL_SERVERS or HITL_SERVER)", file=sys.stderr)
        return 2
    if cmd == "status":
        for s in probe_all(bases):
            print(s.line())
        return 0
    if cmd == "pick":
        best = choose(probe_all(bases))
        if best is None:
            print(f"no reachable HITL runner in pool: {', '.join(bases)}", file=sys.stderr)
            return 1
        print(best.base)
        return 0
    print(f"usage: {argv[0]} [pick|status]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
