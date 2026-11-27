"""Full-system over-the-air updates for the Splanc bridge image.

The agent bundle has its own fast path (selfupdate.py). This updates everything
else: the NixOS system closure (kernel, systemd units, the display code, any new
service), the way `nixos-rebuild boot` + reboot would, from releases CI signs and
publishes as GitHub release assets (nixcache.py has the layout).

    run       (timer, every 15 min) check the channel when due and record what
              it names ("available": version + download size, from the manifest
              and the store paths this bridge lacks). Never downloads a payload
              or installs anything on its own: the bridge's screen shows the
              update and the user confirms it there (the display drops a request
              into /run/splanc-update-request; nix/bridge.nix starts `install`).
              A confirmed update that is waiting for the bridge to be idle is
              applied here once no app is connected.
    install   (confirmed on the screen, or `splanc-system-update install`)
              download the store paths of the available release this bridge
              doesn't have, check every narinfo's signature against the keys
              baked into the image, import them ("staged"); then, once no app is
              connected, apply: set the system profile, install the boot entry,
              reboot. `apply` = the same, even if an app is connected.
    confirm   (every boot) if an update is pending and this is the new system:
              wait for the health check (the health units active and stable,
              the network back if it was up), then commit (make it the default
              boot entry, keep current + previous generation, GC) or roll back
              (previous generation back as the boot default, reboot). Booted the
              OLD system with an update pending (the Pi 5's one-shot tryboot
              fell back, power was lost mid-apply): roll back without a reboot.
    status    print the state; `check` = check the channel now (still only
              discovers).

Boot modes (from the image's config, /etc/splanc-bridge/system-update.json):
  reboot    `<new>/bin/switch-to-configuration boot` makes the new generation
            the boot default before the reboot. Rollback needs the new system to
            reach `confirm`; one that can't boot at all loops (no bootloader
            fallback on U-Boot/extlinux boards).
  tryboot   Every Raspberry Pi (nixos-raspberrypi's "kernel" loader: the
            firmware boots nixos/default/ straight from the FAT partition,
            config.txt has os_prefix=nixos/default/). The default entry stays the
            OLD system; the new generation's directory is installed next to it
            and tryboot.txt (= the new config.txt with os_prefix pointing at it)
            is used for ONE boot (`reboot "0 tryboot"`). Any reset before the
            commit (kernel panic -> panic=10, watchdog, power cut) boots the old
            system. The trial's cmdline.txt also turns hangs into panics
            (TRIAL_KERNEL_PARAMS). A card still on U-Boot is migrated by its
            first such release as a trial too (nix/system-update-rpi.nix).

Nothing touches the running system until a release is fully downloaded and
verified; any failure before the reboot puts the previous profile + boot entry
back. A store path that failed (verification aside) is remembered as bad and
never retried; a later release is.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import random
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from splanc_image import nixcache as nc

CONFIG_PATH = "/etc/splanc-bridge/system-update.json"
STATE_DIR = "/var/lib/splanc-system-update"
PROFILE = "/nix/var/nix/profiles/system"
CURRENT = "/run/current-system"
BOOTED = "/run/booted-system"
BRIDGE_STATUS = "/run/splanc-bridge/status.json"
STATUS_OUT = "/run/splanc-system-update/status.json"
STORE = "/nix/store"

MAX_POINTER_BYTES = 64 << 10
MAX_MANIFEST_BYTES = 16 << 20
MAX_NAR_BYTES = 2 << 30
SPACE_MARGIN = 256 << 20
MAX_BAD = 20
MAX_BOOT_ATTEMPTS = 3
NIX = ["nix", "--extra-experimental-features", "nix-command"]
# Appended to a trial boot's cmdline.txt only (nixos/<N>-default/, which the
# commit leaves as it is and only tryboot.txt boots): a soft lockup, a task hung
# for 2 minutes or an RCU stall panics, and panic=10 resets the board into the
# old system, instead of hanging with the watchdog still being petted.
TRIAL_KERNEL_PARAMS = (
    "softlockup_panic=1",
    "hung_task_panic=1",
    "rcupdate.rcu_cpu_stall_panic=1",
)

_GEN_RE = re.compile(r"^system-([0-9]+)-link$")


class UpdateError(Exception):
    pass


@dataclass
class Config:
    channel_url: str = ""
    board: str = ""
    public_keys: List[str] = field(default_factory=list)
    boot_mode: str = "reboot"  # reboot | tryboot
    health_units: List[str] = field(default_factory=list)
    health_timeout: float = 300
    health_stable: float = 30
    check_interval: float = 6 * 3600
    check_jitter: float = 3600
    retry_interval: float = 3600
    max_defer: float = 3 * 86400
    firmware_dir: str = "/boot/firmware"
    allow_http: bool = False
    gc: bool = True

    @classmethod
    def load(cls, path: str) -> "Config":
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError) as e:
            raise UpdateError(f"can't read {path}: {e}") from e
        known = {k: v for k, v in doc.items() if k in cls.__dataclass_fields__}
        c = cls(**known)
        if c.boot_mode not in ("reboot", "tryboot"):
            raise UpdateError(f"{path}: unknown boot_mode {c.boot_mode!r}")
        for k in c.public_keys:
            if not nc.is_public_key(k):
                raise UpdateError(f"{path}: bad public key {k!r}")
        return c


class Host:
    """Everything with a side effect outside the state dir (tests fake it)."""

    def boot_id(self) -> str:
        try:
            with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as f:
                return f.read().strip()
        except OSError:
            return ""

    def run(self, argv: List[str]) -> str:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if p.returncode != 0:
            tail = " | ".join((p.stderr or "").strip().splitlines()[-4:])
            raise UpdateError(f"{' '.join(argv[:4])}... failed ({p.returncode}): {tail}")
        return p.stdout

    def _open(self, url: str):
        req = urllib.request.Request(url, headers={"User-Agent": "splanc-bridge-image"})
        return urllib.request.urlopen(
            req, timeout=60, context=ssl.create_default_context()
        )  # noqa: S310

    def fetch(self, url: str, limit: int) -> bytes:
        with self._open(url) as r:
            data = r.read(limit + 1)
        if len(data) > limit:
            raise UpdateError(f"{url} is larger than {limit} bytes")
        return data

    def download(self, url: str, dest: str, limit: int) -> bytes:
        """Stream ``url`` into ``dest``; return its sha256 digest."""
        h = hashlib.sha256()
        n = 0
        with self._open(url) as r, open(dest, "wb") as out:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                n += len(chunk)
                if n > limit:
                    raise UpdateError(f"{url} is larger than {limit} bytes")
                h.update(chunk)
                out.write(chunk)
        return h.digest()

    def now(self) -> float:
        return time.time()

    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, s: float) -> None:
        time.sleep(s)

    def free_bytes(self, path: str) -> int:
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize

    def has_default_route(self) -> bool:
        try:
            with open("/proc/net/route", encoding="ascii") as f:
                if any(ln.split()[1:2] == ["00000000"] for ln in f.readlines()[1:]):
                    return True
        except OSError:
            pass
        try:
            with open("/proc/net/ipv6_route", encoding="ascii") as f:
                return any(
                    ln.split()[:2] == ["0" * 32, "00"] and ln.split()[-1] != "lo" for ln in f
                )
        except OSError:
            return False

    def unit_health(self, unit: str) -> Tuple[bool, float]:
        """(active, seconds since it last became active)."""
        out = self.run(
            ["systemctl", "show", "-p", "ActiveState", "-p", "ActiveEnterTimestampMonotonic", unit]
        )
        props = dict(ln.split("=", 1) for ln in out.splitlines() if "=" in ln)
        active = props.get("ActiveState") == "active"
        try:
            since = int(props.get("ActiveEnterTimestampMonotonic", "0")) / 1e6
        except ValueError:
            since = 0
        return active, (self.monotonic() - since) if active and since else 0.0

    def booting(self) -> bool:
        p = subprocess.run(["systemctl", "is-system-running"], stdout=subprocess.PIPE, text=True)
        return p.stdout.strip() in ("initializing", "starting")

    def reboot(self, tryboot: bool) -> None:
        os.sync()
        argv = ["systemctl", "reboot"]
        if tryboot:
            argv.append("--reboot-argument=0 tryboot")
        self.run(argv)


def _log(*a) -> None:
    print("splanc-system-update:", *a, file=sys.stderr, flush=True)


def _write_atomic(path: str, data: bytes, fsync: bool = True) -> None:
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        if fsync:
            f.flush()
            os.fsync(f.fileno())
    os.replace(tmp, path)


def tryboot_config(config_txt: str, gen_dir: str) -> str:
    """config.txt -> tryboot.txt: the same settings, booting ``gen_dir``."""
    out, n = re.subn(
        r"(?m)^(\s*os_prefix\s*=).*$", lambda m: m.group(1) + gen_dir + "/", config_txt
    )
    if n == 0:
        raise UpdateError(
            "config.txt has no os_prefix line (not the generational 'kernel' loader?)"
        )
    return out


class Updater:
    def __init__(
        self,
        cfg: Config,
        host: Optional[Host] = None,
        *,
        state_dir: str = STATE_DIR,
        profile: str = PROFILE,
        current: str = CURRENT,
        booted: str = BOOTED,
        bridge_status: str = BRIDGE_STATUS,
        status_out: str = STATUS_OUT,
        store: str = STORE,
        config_path: str = CONFIG_PATH,
    ):
        self.cfg = cfg
        self.host = host or Host()
        self.state_dir = state_dir
        self.profile = profile
        self.current = current
        self.booted = booted
        self.bridge_status = bridge_status
        self.status_out = status_out
        self.store = store
        self.config_path = config_path
        self.cache_dir = os.path.join(state_dir, "cache")
        self.staged_root = os.path.join(state_dir, "staged-system")
        # For the boot splash (pi/bridge/splash), which reads them from the
        # initrd's side of the root switch, so plain text: the update being tried
        # (a boot of anything else is the rollback: "Recovering…") and the
        # rollback to show ("Rolled back to <version>") on the next boot.
        self.trial_file = os.path.join(state_dir, "trial")
        self.notice_file = os.path.join(state_dir, "splash-notice")
        self._st: Optional[dict] = None  # the state the last status() describes

    # ---- state -------------------------------------------------------------

    @property
    def _state_file(self) -> str:
        return os.path.join(self.state_dir, "state.json")

    def load_state(self) -> dict:
        try:
            with open(self._state_file, encoding="utf-8") as f:
                st = json.load(f)
            if isinstance(st, dict) and st.get("v") == 1:
                st.setdefault("bad", [])
                st.setdefault("available", None)
                self._st = st
                return st
        except (OSError, ValueError):
            pass
        self._st = {
            "v": 1,
            "next_check": 0,
            "available": None,
            "staged": None,
            "pending": None,
            "bad": [],
            "last_result": None,
        }
        return self._st

    def save_state(self, st: dict) -> None:
        os.makedirs(self.state_dir, exist_ok=True)
        _write_atomic(self._state_file, (json.dumps(st, indent=1, sort_keys=True) + "\n").encode())
        self._st = st

    def _current_rev(self) -> Optional[str]:
        """The running image's source revision (image.json next to the config)."""
        try:
            path = os.path.join(os.path.dirname(self.config_path), "image.json")
            with open(path, encoding="utf-8") as f:
                rev = json.load(f).get("rev")
        except (OSError, ValueError, AttributeError):
            return None
        return rev if isinstance(rev, str) and rev and rev != "unknown" else None

    def facts(self, st: Optional[dict]) -> dict:
        """What the screens show next to the state: the running version, the
        available update (version, download size) and when the channel was read."""
        if st is None:
            return {}
        cur = st.get("current") or {}
        av = st.get("available")
        staged = st.get("staged")
        return {
            "current_version": (
                cur.get("version") if cur.get("toplevel") == self._realpath(self.current) else None
            ),
            "current_rev": self._current_rev(),
            "available": (
                {k: av.get(k) for k in ("version", "bytes", "unpacked", "paths", "total_paths")}
                if av
                else None
            ),
            "staged": (
                {"version": staged.get("version"), "confirmed": bool(staged.get("confirmed"))}
                if staged
                else None
            ),
            "checked_at": st.get("checked_at"),
        }

    def status(self, state: str, message: str = "", quiet: bool = False, **extra) -> None:
        """/run/splanc-system-update/status.json: for the screens and the CLI."""
        doc = {
            "v": 1,
            **self.facts(self._st),
            "state": state,
            "message": message,
            "updated_at": self.host.now(),
            **extra,
        }
        try:
            os.makedirs(os.path.dirname(self.status_out), exist_ok=True)
            _write_atomic(self.status_out, json.dumps(doc).encode(), fsync=False)
        except OSError:
            pass
        if message and not quiet:
            _log(message)

    def _result(self, st: dict, result: str, message: str, **extra) -> None:
        st["last_result"] = {"at": self.host.now(), "result": result, "message": message, **extra}

    def _mark_bad(self, st: dict, toplevel: str) -> None:
        bad = [b for b in st.get("bad", []) if b != toplevel] + [toplevel]
        st["bad"] = bad[-MAX_BAD:]

    # ---- system profile ------------------------------------------------------

    def _realpath(self, p: str) -> str:
        return os.path.realpath(p)

    def generations(self) -> Dict[int, str]:
        d = os.path.dirname(self.profile)
        gens = {}
        for name in os.listdir(d):
            m = _GEN_RE.match(name)
            if m:
                gens[int(m.group(1))] = os.path.realpath(os.path.join(d, name))
        return gens

    def current_generation(self) -> Optional[int]:
        try:
            m = _GEN_RE.match(os.readlink(self.profile))
        except OSError:
            return None
        return int(m.group(1)) if m else None

    def _nix_env(self, *args: str) -> None:
        self.host.run(["nix-env", "-p", self.profile, *args])

    def _install_boot(self, toplevel: str) -> None:
        self.host.run([os.path.join(toplevel, "bin", "switch-to-configuration"), "boot"])

    def _prune(self, keep: List[int]) -> None:
        drop = sorted(g for g in self.generations() if g not in keep)
        if drop:
            self._nix_env("--delete-generations", *map(str, drop))

    def _gc(self) -> None:
        if self.cfg.gc:
            self.host.run(["nix-store", "--gc"])

    @property
    def _tryboot_txt(self) -> str:
        return os.path.join(self.cfg.firmware_dir, "tryboot.txt")

    def _remove_tryboot(self) -> None:
        try:
            os.unlink(self._tryboot_txt)
        except FileNotFoundError:
            pass

    def _unlink(self, path: str) -> None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    def _write_notice(self, version: Optional[str], this_boot: bool) -> None:
        """ "Rolled back to <version>" for the splash: on this boot (the old system
        is already running), or on the next one (we're about to reboot into it)."""
        boot = (self.host.boot_id() or "next") if this_boot else "next"
        try:
            _write_atomic(self.notice_file, f"rolled_back {version or '-'}\n{boot}\n".encode())
        except OSError as e:
            _log(f"splash notice: {e}")

    def age_notice(self) -> None:
        """Every boot: a notice for "the next boot" is now for this one; one from an
        earlier boot is gone (the splash showed it then)."""
        try:
            with open(self.notice_file, encoding="utf-8") as f:
                kind, version, boot = (f.read().split() + ["", "", ""])[:3]
        except OSError:
            return
        if boot == "next":
            cur = self.host.boot_id()
            if cur:
                _write_atomic(self.notice_file, f"{kind} {version}\n{cur}\n".encode())
        elif boot != self.host.boot_id():
            self._unlink(self.notice_file)

    def _drop_staged_root(self) -> None:
        try:
            os.unlink(self.staged_root)
        except FileNotFoundError:
            pass

    # ---- idle / health -------------------------------------------------------

    def bridge_busy(self) -> bool:
        """An app is connected through the bridge (status.json `clients`)."""
        try:
            with open(self.bridge_status, encoding="utf-8") as f:
                clients = json.load(f).get("clients", 0)
            return isinstance(clients, int) and clients > 0
        except (OSError, ValueError, AttributeError):
            return False

    def unhealthy_units(self, units: List[str]) -> List[str]:
        bad = []
        for u in units:
            try:
                active, up_for = self.host.unit_health(u)
            except UpdateError:
                active, up_for = False, 0.0
            if not active or up_for < self.cfg.health_stable:
                bad.append(u)
        return bad

    def health_problems(self, pending: dict) -> List[str]:
        exempt = set(pending.get("baseline_unhealthy") or [])
        units = [u for u in self.cfg.health_units if u not in exempt]
        problems = [f"{u} not up" for u in self.unhealthy_units(units)]
        if pending.get("had_default_route") and not self.host.has_default_route():
            problems.append("no network (no default route)")
        if self.host.booting():
            problems.append("still booting")
        return problems

    # ---- check + stage -------------------------------------------------------

    def _write_cache_skeleton(self, man: nc.Manifest, keep_nars: set) -> None:
        os.makedirs(os.path.join(self.cache_dir, "nar"), exist_ok=True)
        _write_atomic(
            os.path.join(self.cache_dir, "nix-cache-info"),
            f"StoreDir: {self.store}\nWantMassQuery: 0\nPriority: 50\n".encode(),
            fsync=False,
        )
        for name in os.listdir(self.cache_dir):
            if name.endswith(".narinfo"):
                os.unlink(os.path.join(self.cache_dir, name))
        for ni in man.narinfos.values():
            with open(
                os.path.join(self.cache_dir, ni.hash + ".narinfo"), "w", encoding="utf-8"
            ) as f:
                f.write(ni.text)
        nar_dir = os.path.join(self.cache_dir, "nar")
        for name in os.listdir(nar_dir):
            if name not in keep_nars:
                os.unlink(os.path.join(nar_dir, name))

    def _have_nar(self, ni: nc.NarInfo) -> bool:
        p = os.path.join(self.cache_dir, "nar", ni.nar_file)
        try:
            if os.path.getsize(p) != ni.file_size:
                return False
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            return nc.nix32(h.digest()) == ni.file_hash
        except OSError:
            return False

    def _download_nar(self, man: nc.Manifest, ni: nc.NarInfo) -> None:
        dest = os.path.join(self.cache_dir, "nar", ni.nar_file)
        tmp = dest + ".part"
        url = f"{man.nar_base_url}/{ni.nar_file}"
        try:
            digest = self.host.download(url, tmp, min(MAX_NAR_BYTES, ni.file_size))
        except UpdateError:
            raise
        except Exception as e:  # urllib/socket errors
            raise UpdateError(f"download {url}: {e}") from e
        if os.path.getsize(tmp) != ni.file_size or nc.nix32(digest) != ni.file_hash:
            os.unlink(tmp)
            raise UpdateError(f"{ni.nar_file} does not match its narinfo (FileHash/FileSize)")
        os.replace(tmp, dest)

    def _missing(self, paths: List[str]) -> List[str]:
        out = self.host.run(["nix-store", "--check-validity", "--print-invalid", *paths])
        return [ln for ln in out.splitlines() if ln.strip()]

    def _ensure_space(self, need: int, current_gen: Optional[int]) -> None:
        if self.host.free_bytes(self.store) >= need:
            return
        _log(f"need {need >> 20} MB free; dropping old generations and collecting garbage")
        self._prune([g for g in (current_gen,) if g is not None])
        if current_gen is not None:
            # Rewrite the boot entries for the generations that are left.
            self._install_boot(self._realpath(self.current))
        self.host.run(["nix-store", "--gc"])
        free = self.host.free_bytes(self.store)
        if free < need:
            raise UpdateError(f"not enough space: {free >> 20} MB free, {need >> 20} MB needed")

    def _pointer(self, channel_url: Optional[str]) -> nc.Pointer:
        url = channel_url or self.cfg.channel_url
        allow_http = self.cfg.allow_http
        if not (url.startswith("https://") or (allow_http and url.startswith("http://"))):
            raise UpdateError(f"refusing channel URL {url!r}")
        try:
            ptr = nc.parse_pointer(self.host.fetch(url, MAX_POINTER_BYTES), allow_http=allow_http)
        except nc.CacheError as e:
            raise UpdateError(str(e)) from e
        if ptr.board != self.cfg.board:
            raise UpdateError(f"channel is for board {ptr.board!r}, this is {self.cfg.board!r}")
        return ptr

    def _manifest(self, ptr: nc.Pointer):
        """The pointer's manifest (sha256-checked) and the closure it lists."""
        data = self.host.fetch(ptr.manifest_url, MAX_MANIFEST_BYTES)
        if hashlib.sha256(data).hexdigest() != ptr.manifest_sha256:
            raise UpdateError("manifest failed its sha256 check")
        try:
            man = nc.parse_manifest(data, allow_http=self.cfg.allow_http)
            paths = man.closure()
        except nc.CacheError as e:
            raise UpdateError(str(e)) from e
        if (man.board, man.toplevel, man.version) != (ptr.board, ptr.toplevel, ptr.version):
            raise UpdateError("manifest and channel pointer disagree")
        return man, paths

    def discover(self, st: dict, channel_url: Optional[str] = None) -> Optional[dict]:
        """Read the channel and record what it offers in ``st["available"]`` (None:
        up to date / nothing to offer). Metadata only: the pointer, the manifest
        (narinfos, ~0.5 MB) and which of its store paths this bridge lacks -- the
        download size the screen shows. No NAR is fetched, nothing is imported."""
        self.status("checking", "checking for a system update", quiet=True)
        ptr = self._pointer(channel_url)
        st["checked_at"] = self.host.now()
        current = self._realpath(self.current)
        if ptr.toplevel == current:
            shutil.rmtree(self.cache_dir, ignore_errors=True)
            st["current"] = {"toplevel": current, "version": ptr.version}
            st["available"] = None
            self.status("idle", f"up to date ({ptr.version})", version=ptr.version)
            return None
        if ptr.toplevel in st.get("bad", []):
            st["available"] = None
            self.status(
                "idle",
                f"skipping {ptr.version}: it failed on this bridge before",
                version=ptr.version,
            )
            return None
        man, paths = self._manifest(ptr)
        missing = set(self._missing([ni.store_path for ni in paths]))
        todo = [ni for ni in paths if ni.store_path in missing]
        prev = st.get("available") or {}
        found = prev.get("found_at") if prev.get("toplevel") == ptr.toplevel else None
        av = {
            "version": ptr.version,
            "toplevel": ptr.toplevel,
            "board": ptr.board,
            "manifest_url": ptr.manifest_url,
            "manifest_sha256": ptr.manifest_sha256,
            "paths": len(todo),
            "total_paths": len(paths),
            "bytes": sum(ni.file_size for ni in todo),
            "unpacked": sum(ni.nar_size for ni in todo),
            "found_at": found or self.host.now(),
        }
        st["available"] = av
        self.status(
            "available",
            f"{ptr.version} available ({av['bytes'] / 1e6:.1f} MB to download); "
            "confirm it on the bridge's screen or run `splanc-system-update install`",
            version=ptr.version,
        )
        return av

    def stage(self, st: dict) -> dict:
        """Download, verify and import the available release (the user confirmed
        it). Returns the staged record."""
        av = st["available"]
        staged = st.get("staged")
        if staged and staged.get("toplevel") == av["toplevel"] and self._valid(av["toplevel"]):
            staged["confirmed"] = True
            return staged
        ptr = nc.Pointer(
            board=av["board"],
            version=av["version"],
            toplevel=av["toplevel"],
            manifest_url=av["manifest_url"],
            manifest_sha256=av["manifest_sha256"],
        )
        man, paths = self._manifest(ptr)
        missing = set(self._missing([ni.store_path for ni in paths]))
        todo = [ni for ni in paths if ni.store_path in missing]
        dl = sum(ni.file_size for ni in todo)
        unpacked = sum(ni.nar_size for ni in todo)
        self.status(
            "downloading",
            f"{man.version}: {len(todo)} of {len(paths)} store paths to fetch "
            f"({dl / 1e6:.1f} MB, {unpacked / 1e6:.1f} MB unpacked)",
            version=man.version,
            paths=len(todo),
            bytes_total=dl,
            bytes_done=0,
        )
        self._ensure_space(dl + unpacked + SPACE_MARGIN, self.current_generation())

        keep = {ni.nar_file for ni in todo}
        self._write_cache_skeleton(man, keep)
        done = 0
        for i, ni in enumerate(todo):
            if not self._have_nar(ni):
                self._download_nar(man, ni)
            done += ni.file_size
            if i % 10 == 9 or i == len(todo) - 1:
                self.status(
                    "downloading",
                    "",
                    version=man.version,
                    paths=len(todo),
                    bytes_total=dl,
                    bytes_done=done,
                )

        # Signatures: every narinfo of the closure (also the paths this bridge
        # already has) must carry a valid signature by a key baked into the
        # image -- and only those keys count.
        cache = f"file://{self.cache_dir}"
        keys = " ".join(self.cfg.public_keys)
        self.status("verifying", f"{man.version}: checking signatures", version=man.version)
        try:
            self.host.run(
                NIX
                + [
                    "store", "verify", "--store", cache, "--no-contents", "--recursive",
                    "--sigs-needed", "1", "--option", "trusted-public-keys", keys, man.toplevel,
                ]
            )  # fmt: skip
        except UpdateError as e:
            shutil.rmtree(self.cache_dir, ignore_errors=True)
            raise UpdateError(f"{man.version} is not signed by a trusted key: {e}") from e
        # Import: Nix checks every NAR against its signed NarHash on the way in.
        self.host.run(
            NIX
            + [
                "copy", "--from", cache, "--option", "require-sigs", "true", "--option", "trusted-public-keys", keys,
                man.toplevel,
            ]
        )  # fmt: skip
        self.host.run(["nix-store", "--add-root", self.staged_root, "--realise", man.toplevel])
        shutil.rmtree(self.cache_dir, ignore_errors=True)
        self._check_system(man.toplevel)
        record = {
            "toplevel": man.toplevel,
            "version": man.version,
            "staged_at": self.host.now(),
            "fetched_paths": len(todo),
            "total_paths": len(paths),
            "fetched_bytes": dl,
            "confirmed": True,
        }
        st["staged"] = record
        self._result(st, "staged", f"{man.version} downloaded and verified", version=man.version)
        self.status("staged", f"{man.version} downloaded and verified", version=man.version)
        return record

    def _valid(self, path: str) -> bool:
        try:
            return not self._missing([path])
        except UpdateError:
            return False

    def _check_system(self, toplevel: str) -> None:
        """The imported path is a bridge system for this board."""
        if not os.access(os.path.join(toplevel, "bin", "switch-to-configuration"), os.X_OK):
            raise UpdateError(f"{toplevel} is not a NixOS system")
        try:
            with open(
                os.path.join(toplevel, "etc", "splanc-bridge", "image.json"), encoding="utf-8"
            ) as f:
                board = json.load(f).get("board")
        except (OSError, ValueError, AttributeError) as e:
            raise UpdateError(f"{toplevel} is not a Splanc bridge system: {e}") from e
        if board != self.cfg.board:
            raise UpdateError(f"{toplevel} is for board {board!r}, this is {self.cfg.board!r}")

    # ---- apply ---------------------------------------------------------------

    def apply(self, st: dict) -> None:
        """Make the staged system the next boot and reboot into it."""
        staged = st["staged"]
        new = staged["toplevel"]
        old = self._realpath(self.current)
        if self._realpath(self.booted) != old:
            raise UpdateError("the running system was switched since boot; reboot first")
        old_gen = self.current_generation()
        if old_gen is None or self.generations().get(old_gen) != old:
            raise UpdateError(f"{self.profile} does not point at the running system")
        mode = self.cfg.boot_mode
        units = list(self.cfg.health_units)
        pending = {
            "old": old,
            "old_gen": old_gen,
            "new": new,
            "new_gen": None,
            "version": staged.get("version"),
            "mode": mode,
            "applied_at": self.host.now(),
            "attempts": 0,
            "fetched_paths": staged.get("fetched_paths"),
            "total_paths": staged.get("total_paths"),
            "old_version": (st.get("current") or {}).get("version"),
            "had_default_route": self.host.has_default_route(),
            # Units already failing on the old system don't fail the new one.
            "baseline_unhealthy": self.unhealthy_units(units),
        }
        # Record first: if we die half way, `confirm` on the next boot cleans up.
        st["pending"] = pending
        self.save_state(st)
        _write_atomic(self.trial_file, (new + "\n").encode())
        self.status("installing", f"installing {pending['version']}", version=pending["version"])
        try:
            self._nix_env("--set", new)
            new_gen = self.current_generation()
            if new_gen is None or new_gen == old_gen:
                raise UpdateError("nix-env did not create a new generation")
            pending["new_gen"] = new_gen
            self.save_state(st)
            if mode == "tryboot":
                # Default entry + config.txt stay the old system's; the old
                # system's installer also writes nixos/<new_gen>-default/.
                self._install_boot(old)
                self._write_tryboot(new, new_gen)
            else:
                self._install_boot(new)
        except Exception as e:
            _log(f"apply failed, restoring the previous system: {e}")
            self._restore(st, f"install failed: {e}")
            self.save_state(st)
            raise
        st["staged"] = None
        self.save_state(st)
        self.status("rebooting", f"rebooting into {pending['version']}", version=pending["version"])
        self.host.reboot(tryboot=(mode == "tryboot"))

    def _write_tryboot(self, new: str, new_gen: int) -> None:
        gen_dir = f"nixos/{new_gen}-default"
        d = os.path.join(self.cfg.firmware_dir, gen_dir)
        cmdline = os.path.join(d, "cmdline.txt")
        try:
            with open(cmdline, encoding="utf-8") as f:
                line = f.read()
        except OSError as e:
            raise UpdateError(f"the bootloader did not install {gen_dir}: {e}") from e
        # The builder boots a generation directory through its profile link
        # (init=/nix/var/nix/profiles/system-<N>-link/init) and records the
        # store path it resolved to in system-link.
        try:
            with open(os.path.join(d, "system-link"), encoding="utf-8") as f:
                resolved = f.read().strip()
        except OSError:
            resolved = None
        inits = [a[5:] for a in line.split() if a.startswith("init=")]
        boots = resolved == new or any(os.path.realpath(os.path.dirname(i)) == new for i in inits)
        if not boots:
            raise UpdateError(f"{gen_dir}/cmdline.txt does not boot {new}")
        args = line.split()
        extra = [p for p in TRIAL_KERNEL_PARAMS if p not in args]
        if extra:
            _write_atomic(cmdline, (" ".join(args + extra) + "\n").encode())
        for name in ("kernel.img", "initrd"):
            if not os.path.isfile(os.path.join(d, name)):
                raise UpdateError(f"{gen_dir}/{name} missing")
        src = os.path.join(new, "splanc-rpi-config.txt")
        if not os.path.isfile(src):
            src = os.path.join(self.cfg.firmware_dir, "config.txt")
        with open(src, encoding="utf-8") as f:
            text = tryboot_config(f.read(), gen_dir)
        _write_atomic(self._tryboot_txt, text.encode())

    def _restore(self, st: dict, reason: str, notice: Optional[str] = None) -> None:
        """Put the old generation back as the profile + boot default. ``notice``
        ("this" or "next" boot): tell the boot splash it was rolled back."""
        p = st["pending"]
        gens = self.generations()
        try:
            if p.get("old_gen") in gens and gens[p["old_gen"]] == p["old"]:
                self._nix_env("--switch-generation", str(p["old_gen"]))
            else:
                self._nix_env("--set", p["old"])
            # The new generation (also when we died before recording its number).
            drop = [
                g
                for g, target in self.generations().items()
                if g != self.current_generation() and (g == p.get("new_gen") or target == p["new"])
            ]
            if drop:
                self._nix_env("--delete-generations", *map(str, sorted(drop)))
        finally:
            self._remove_tryboot()
            self._install_boot(p["old"])
        self._mark_bad(st, p["new"])
        if (st.get("available") or {}).get("toplevel") == p["new"]:
            st["available"] = None  # never offered again
        self._drop_staged_root()
        self._unlink(self.trial_file)
        if notice:
            self._write_notice(p.get("old_version"), this_boot=notice == "this")
        self._result(st, "rolled_back", reason, version=p.get("version"), toplevel=p["new"])
        st["pending"] = None
        st["staged"] = None

    # ---- confirm (every boot) ----------------------------------------------

    def confirm(self) -> int:
        self.age_notice()
        st = self.load_state()
        p = st.get("pending")
        if not p:
            self._unlink(self.trial_file)
            return 0
        booted = self._realpath(self.booted)
        if booted == p["new"]:
            p["attempts"] = int(p.get("attempts", 0)) + 1
            self.save_state(st)
            if p["attempts"] > MAX_BOOT_ATTEMPTS:
                return self._rollback(
                    st, f"{p['attempts'] - 1} boots without passing the health check"
                )
            self.status(
                "confirming", f"checking {p.get('version')} is healthy", version=p.get("version")
            )
            deadline = self.host.monotonic() + self.cfg.health_timeout
            while True:
                problems = self.health_problems(p)
                if not problems:
                    return self._commit(st)
                if self.host.monotonic() >= deadline:
                    return self._rollback(st, "health check failed: " + "; ".join(problems))
                self.host.sleep(5)
        if booted == p["old"]:
            why = (
                "the new system did not come up (tryboot fell back to the old one)"
                if p.get("mode") == "tryboot"
                else "the update was interrupted before the new system booted"
            )
            _log(why)
            self._restore(st, why, notice="this")
            self.save_state(st)
            self.status("rolled_back", why, version=p.get("version"))
            return 1
        _log(f"booted {booted}, which the pending update doesn't know; forgetting it")
        st["pending"] = None
        self.save_state(st)
        self._unlink(self.trial_file)
        return 0

    def _commit(self, st: dict) -> int:
        p = st["pending"]
        self.status(
            "committing",
            f"{p.get('version')} is healthy; making it the default",
            version=p.get("version"),
        )
        # Keep current + previous; then the boot entries for exactly those.
        self._prune([p["new_gen"], p["old_gen"]])
        self._install_boot(p["new"])
        self._remove_tryboot()
        self._drop_staged_root()
        self._unlink(self.trial_file)
        st["pending"] = None
        st["staged"] = None
        st["current"] = {"toplevel": p["new"], "version": p.get("version")}
        if (st.get("available") or {}).get("toplevel") == p["new"]:
            st["available"] = None
        self._result(
            st,
            "committed",
            f"updated to {p.get('version')}",
            version=p.get("version"),
            toplevel=p["new"],
            fetched_paths=p.get("fetched_paths"),
            total_paths=p.get("total_paths"),
        )
        self.save_state(st)
        try:
            self._gc()
        except UpdateError as e:
            _log(f"garbage collection failed (harmless): {e}")
            st["last_result"]["gc_error"] = str(e)
            self.save_state(st)
        self.status("idle", f"updated to {p.get('version')}", version=p.get("version"))
        return 0

    def _rollback(self, st: dict, reason: str) -> int:
        p = st["pending"]
        _log(f"rolling back {p.get('version')}: {reason}")
        self.status("rolling_back", reason, version=p.get("version"))
        self._restore(st, reason, notice="next")
        self.save_state(st)
        self.host.reboot(tryboot=False)
        return 1

    # ---- run (timer) / install (confirmed) -------------------------------------

    def _drop_stale_staged(self, st: dict) -> None:
        staged = st.get("staged")
        if staged and (
            staged["toplevel"] == self._realpath(self.current)
            or not self._valid(staged["toplevel"])
        ):
            st["staged"] = None

    def publish(self, st: dict) -> None:
        """Re-announce what the state says (status.json lives in /run: after a
        reboot the screens only know about an update once this has run)."""
        staged, av = st.get("staged"), st.get("available")
        if staged and staged.get("confirmed"):
            self.status(
                "staged",
                f"{staged['version']} ready; restarts when no app is connected",
                quiet=True,
                version=staged["version"],
            )
        elif av:
            self.status(
                "available", f"{av['version']} available", quiet=True, version=av["version"]
            )
        else:
            last = st.get("last_result") or {}
            if last.get("result") == "failed":
                self.status("failed", last.get("message", ""), quiet=True)
            else:
                self.status("idle", "", quiet=True)

    def _apply_when_idle(self, st: dict, staged: dict, force: bool) -> int:
        """Apply a confirmed, staged update -- now, or once no app is connected."""
        now = self.host.now()
        if self.bridge_busy() and not force:
            since = float(st.get("defer_since") or now)
            st["defer_since"] = since
            if now - since < self.cfg.max_defer:
                self.save_state(st)
                self.status(
                    "staged",
                    f"{staged['version']} ready; restarts when no app is connected",
                    version=staged["version"],
                )
                return 0
            _log(f"an app has been connected for {(now - since) / 3600:.0f} h; installing anyway")
        st["defer_since"] = None
        self.apply(st)
        return 0

    def run(self, *, check_now: bool = False, channel_url: Optional[str] = None) -> int:
        """The timer: check the channel when due (discover only), and apply an
        update the user already confirmed once the bridge is idle."""
        if not self.cfg.public_keys:
            self.status("disabled", "no update signing key in this image: system updates are off")
            return 0
        st = self.load_state()
        if st.get("pending"):
            _log("an update is waiting for its health check (splanc-system-update-confirm)")
            return 0
        self._drop_stale_staged(st)
        now = self.host.now()
        checked = False
        if check_now or now >= float(st.get("next_check") or 0):
            checked = True
            try:
                self.discover(st, channel_url)
                st["next_check"] = (
                    now + self.cfg.check_interval + random.uniform(0, self.cfg.check_jitter)
                )
            except (UpdateError, OSError) as e:
                st["next_check"] = now + self.cfg.retry_interval
                self._result(st, "failed", f"update check failed: {e}")
                self.save_state(st)
                self.status("failed", f"update check failed: {e}")
                return 1
            self.save_state(st)
        staged = st.get("staged")
        if staged and staged.get("confirmed"):
            try:
                return self._apply_when_idle(st, staged, force=False)
            except (UpdateError, OSError) as e:
                self.status("failed", f"install failed: {e}")
                return 1
        if not checked:
            self.publish(st)
        return 0

    def install(self, *, apply_now: bool = False, channel_url: Optional[str] = None) -> int:
        """The user confirmed (on the screen, or `splanc-system-update install`):
        download + verify + import the available release, then apply it (once no
        app is connected, unless ``apply_now``). With nothing recorded as
        available yet (or a ``channel_url``), checks the channel first."""
        if not self.cfg.public_keys:
            self.status("disabled", "no update signing key in this image: system updates are off")
            return 1
        st = self.load_state()
        if st.get("pending"):
            _log("an update is waiting for its health check (splanc-system-update-confirm)")
            return 1
        self._drop_stale_staged(st)
        try:
            staged = st.get("staged") if (st.get("staged") or {}).get("confirmed") else None
            if channel_url or (not st.get("available") and not staged):
                self.discover(st, channel_url)
                self.save_state(st)
            av = st.get("available")
            if av and not (staged and staged["toplevel"] == av["toplevel"]):
                staged = self.stage(st)
                st["defer_since"] = None
                self.save_state(st)
            if not staged:
                self.save_state(st)
                return 0  # up to date (discover() said so)
            return self._apply_when_idle(st, staged, force=apply_now)
        except (UpdateError, OSError) as e:
            self._result(st, "failed", f"install failed: {e}")
            self.save_state(st)
            self.status("failed", f"install failed: {e}")
            return 1


@contextlib.contextmanager
def _locked(state_dir: str):
    """One updater at a time (the timer, an on-screen install, the CLI)."""
    os.makedirs(state_dir, exist_ok=True)
    with open(os.path.join(state_dir, ".lock"), "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="splanc-system-update", description=__doc__.split("\n")[0])
    ap.add_argument("--config", default=os.environ.get("SPLANC_SYSTEM_UPDATE_CONFIG", CONFIG_PATH))
    ap.add_argument(
        "--state-dir", default=os.environ.get("STATE_DIRECTORY", STATE_DIR).split(":")[0]
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser(
        "run", help="timer: check when due (discover only); apply a confirmed update"
    )
    r.add_argument("--auto", action="store_true", help="honour SPLANC_AUTO_UPDATE=0")
    r.add_argument("--channel", help="channel pointer URL (default: the image's)")
    c = sub.add_parser("check", help="check the channel now (discover only)")
    c.add_argument("--channel")
    i = sub.add_parser(
        "install", help="download, verify, install the update (once no app is connected)"
    )
    i.add_argument("--channel")
    a = sub.add_parser("apply", help="as install, even if an app is connected")
    a.add_argument("--channel")
    sub.add_parser("confirm", help="boot: health-check a pending update; commit or roll back")
    sub.add_parser("status", help="print the updater state")
    args = ap.parse_args(argv)

    if args.cmd == "status":
        try:
            cfg = Config.load(args.config)
        except UpdateError as e:
            print(e, file=sys.stderr)
            return 1
        u = Updater(cfg, state_dir=args.state_dir, config_path=args.config)
        st = u.load_state()
        try:
            with open(u.status_out, encoding="utf-8") as f:
                st["status"] = json.load(f)
        except (OSError, ValueError):
            pass
        st["running"] = os.path.realpath(CURRENT)
        st["channel"] = cfg.channel_url
        st["keys"] = cfg.public_keys
        print(json.dumps(st, indent=1, sort_keys=True))
        return 0

    try:
        cfg = Config.load(args.config)
    except UpdateError as e:
        _log(e)
        return 1
    u = Updater(cfg, state_dir=args.state_dir, config_path=args.config)
    try:
        if args.cmd == "confirm":
            return u.confirm()
        with _locked(args.state_dir):
            if args.cmd == "run":
                if args.auto and os.environ.get("SPLANC_AUTO_UPDATE", "1").strip() == "0":
                    print("automatic update checks are off (SPLANC_AUTO_UPDATE=0)")
                    return 0
                return u.run(channel_url=args.channel)
            if args.cmd == "check":
                return u.run(check_now=True, channel_url=args.channel)
            return u.install(apply_now=(args.cmd == "apply"), channel_url=args.channel)
    except (UpdateError, OSError) as e:
        _log(e)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
