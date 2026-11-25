"""Apply the flash-time settings on the card's FAT boot partition (every boot).

The image is one fixed build for every user, so per-card settings can't be baked
in. The Splanc Bridge Flasher (pi/bridge/flasher) writes them onto the boot
partition right after the raw image write, where any computer can also read and
edit them:

    /boot/firmware/splanc-bridge.conf        KEY=VALUE settings (below)
    /boot/firmware/system-connections/*.nmconnection
                                             NetworkManager WiFi profiles
    /boot/firmware/authorized_keys           optional SSH public keys (root)
    /boot/firmware/splanc-restore/           optional restore bundle: the bridge's
                                             state from an earlier card
                                             (tools/bridge_migrate)

splanc-flash-config.service runs this before NetworkManager and avahi on every
boot (idempotent) and:

  * sets the hostname (HOSTNAME=, default splanc-bridge -> splanc-bridge.local);
  * sets the WiFi regulatory country (WIFI_COUNTRY=, ISO 3166 alpha-2);
  * MOVES the WiFi profiles into NetworkManager's store (root, 0600) and deletes
    them from the boot partition, so the WiFi password doesn't stay on a FAT
    partition anyone can read (as Raspberry Pi Imager does). Drop a new profile
    there later to change networks;
  * writes the bridge/display settings to /run/splanc-flash/bridge.env, which
    splanc-bridge.service and splanc-display.service read;
  * merges SSH public keys into /var/lib/splanc-ssh/authorized_keys (sshd only
    starts when that file exists — there is no password login);
  * imports a restore bundle (``splanc-restore/``, written by
    tools/bridge_migrate from a backup of the old card) into the bridge's state
    directory, before splanc-bridge.service first starts: the bridge then comes
    up with its old identity, so every paired client stays paired. See
    ``import_restore`` for the checks; the bundle is deleted from the FAT
    partition once imported (it holds the bridge's private key).

Settings (unknown keys and bad values are ignored, with a log line):

    HOSTNAME=splanc-bridge          RFC 1123 label (a-z 0-9 -, 1-63 chars)
    WIFI_COUNTRY=US                 two letters
    SPLANC_RELAY=wss://...          relay URL (empty: the bridge's built-in default)
    OLED=auto                       auto | spi | i2c | off
    OLED_ROTATE=2                   0-3 (x90 degrees)
    SPLANC_DISPLAY_HDMI=auto        auto | off
    SPLANC_AUTO_UPDATE=1            1 | 0 (daily agent bundle updates)
    SPLANC_MATTER=1                 1 | 0 (the Matter bridge: Apple Home, Home Assistant, ...)

Nothing here can fail the boot: every step is guarded and logged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

CONF_NAME = "splanc-bridge.conf"
CONNECTIONS_DIR = "system-connections"
AUTHORIZED_KEYS = "authorized_keys"
DEFAULT_HOSTNAME = "splanc-bridge"
MAX_FILE_BYTES = 64 << 10

_HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_URL_RE = re.compile(r"^(wss|ws|https|http)://[^\s\"'\\`$]+$")

# key -> validator(value) -> normalized value or None (rejected)
_VALIDATORS: Dict[str, Callable[[str], Optional[str]]] = {
    "HOSTNAME": lambda v: v.lower() if _HOSTNAME_RE.match(v.lower()) else None,
    "WIFI_COUNTRY": lambda v: v.upper() if re.fullmatch(r"[A-Za-z]{2}", v) else None,
    "SPLANC_RELAY": lambda v: v if (v == "" or _URL_RE.match(v)) else None,
    "OLED": lambda v: v.lower() if v.lower() in ("auto", "spi", "i2c", "off") else None,
    "OLED_ROTATE": lambda v: v if v in ("0", "1", "2", "3") else None,
    "SPLANC_DISPLAY_HDMI": lambda v: v.lower() if v.lower() in ("auto", "off") else None,
    "SPLANC_AUTO_UPDATE": lambda v: v if v in ("0", "1") else None,
    "SPLANC_MATTER": lambda v: v if v in ("0", "1") else None,
}
# Passed on to the services' environment (bridge.env).
ENV_KEYS = (
    "SPLANC_RELAY",
    "OLED",
    "OLED_ROTATE",
    "SPLANC_DISPLAY_HDMI",
    "SPLANC_AUTO_UPDATE",
    "SPLANC_MATTER",
)

_KEY_PREFIXES = (
    "ssh-ed25519 ",
    "ssh-rsa ",
    "ecdsa-sha2-",
    "sk-ssh-ed25519@openssh.com ",
    "sk-ecdsa-sha2-",
)


@dataclass
class Settings:
    values: Dict[str, str] = field(default_factory=dict)
    ignored: List[str] = field(default_factory=list)

    @property
    def hostname(self) -> str:
        return self.values.get("HOSTNAME") or DEFAULT_HOSTNAME


def _read_text(path: str) -> Optional[str]:
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    # Notepad may add a UTF-8 BOM; tolerate CRLF too.
    return raw.decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def parse_conf(text: str) -> Settings:
    """Parse splanc-bridge.conf. Never raises; bad lines land in ``ignored``."""
    s = Settings()
    for n, line in enumerate(text.lstrip("\ufeff").split("\n"), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            s.ignored.append(f"line {n}: not KEY=VALUE")
            continue
        key, value = (p.strip() for p in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        check = _VALIDATORS.get(key)
        if check is None:
            s.ignored.append(f"line {n}: unknown setting {key}")
            continue
        norm = check(value)
        if norm is None:
            s.ignored.append(f"line {n}: bad value for {key}")
            continue
        s.values[key] = norm
    return s


def render_env(s: Settings) -> str:
    """bridge.env for the services (values are validated: no quoting needed)."""
    lines = ["# Generated at boot from /boot/firmware/splanc-bridge.conf"]
    lines += [f"{k}={s.values[k]}" for k in ENV_KEYS if k in s.values]
    return "\n".join(lines) + "\n"


def valid_keyfile(text: str) -> bool:
    """A plausible NetworkManager keyfile: has a [connection] group and a type."""
    return "[connection]" in text and re.search(r"(?m)^type=\S+", text) is not None


def _atomic_write(path: str, data: str, mode: int) -> None:
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


@dataclass
class Paths:
    boot: str = "/boot/firmware"
    nm: str = "/etc/NetworkManager/system-connections"
    run: str = "/run/splanc-flash"
    ssh: str = "/var/lib/splanc-ssh"
    state: str = "/var/lib/splanc-bridge"


def _run(cmd: List[str]) -> bool:
    try:
        subprocess.run(cmd, check=True, timeout=30, capture_output=True)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def apply(
    paths: Paths = Paths(),
    *,
    set_hostname: Callable[[str], bool] = lambda h: _run(["hostname", h]),
    set_country: Callable[[str], bool] = lambda c: _run(["iw", "reg", "set", c]),
    chown_root: bool = True,
    state_owner: Optional[Tuple[int, int]] = None,
    log: Callable[[str], None] = print,
) -> Settings:
    text = _read_text(os.path.join(paths.boot, CONF_NAME))
    s = parse_conf(text) if text is not None else Settings()
    for msg in s.ignored:
        log(f"{CONF_NAME}: {msg}")

    # --- hostname ----------------------------------------------------------
    cur = ""
    try:
        with open("/proc/sys/kernel/hostname") as f:
            cur = f.read().strip()
    except OSError:
        pass
    if s.hostname != cur:
        log(f"hostname {cur or '?'} -> {s.hostname}")
        if not set_hostname(s.hostname):
            log("could not set the hostname")

    # --- WiFi country -------------------------------------------------------
    country = s.values.get("WIFI_COUNTRY")
    if country:
        log(f"WiFi country {country}")
        if not set_country(country):
            log("could not set the WiFi country")

    # --- service settings ---------------------------------------------------
    try:
        os.makedirs(paths.run, mode=0o755, exist_ok=True)
        _atomic_write(os.path.join(paths.run, "bridge.env"), render_env(s), 0o644)
    except OSError as e:
        log(f"could not write bridge.env: {e}")

    # --- WiFi profiles: move into NetworkManager's store ---------------------
    src = os.path.join(paths.boot, CONNECTIONS_DIR)
    if os.path.isdir(src):
        for name in sorted(os.listdir(src)):
            path = os.path.join(src, name)
            if not name.endswith(".nmconnection") or not os.path.isfile(path):
                continue
            body = _read_text(path)
            if body is None or not valid_keyfile(body):
                log(f"ignoring {name}: not a NetworkManager keyfile")
                continue
            try:
                os.makedirs(paths.nm, mode=0o700, exist_ok=True)
                dst = os.path.join(paths.nm, name)
                _atomic_write(dst, body, 0o600)
                if chown_root:
                    os.chown(dst, 0, 0)
                os.remove(path)
                log(f"installed WiFi profile {name}")
            except OSError as e:
                log(f"could not install {name}: {e}")
        try:
            if not os.listdir(src):
                os.rmdir(src)
        except OSError:
            pass

    # --- SSH keys -------------------------------------------------------------
    keys_text = _read_text(os.path.join(paths.boot, AUTHORIZED_KEYS))
    if keys_text:
        keys = [k.strip() for k in keys_text.split("\n") if k.strip().startswith(_KEY_PREFIXES)]
        if keys:
            try:
                os.makedirs(paths.ssh, mode=0o700, exist_ok=True)
                target = os.path.join(paths.ssh, "authorized_keys")
                have = (_read_text(target) or "").split("\n")
                merged = [k for k in have if k.strip()] + [k for k in keys if k not in have]
                _atomic_write(target, "\n".join(merged) + "\n", 0o600)
                log(f"{len(merged)} SSH key(s) trusted")
            except OSError as e:
                log(f"could not install SSH keys: {e}")

    # --- restore bundle (tools/bridge_migrate) ---------------------------------
    if os.path.isdir(os.path.join(paths.boot, RESTORE_DIR)):
        owner = state_owner
        if owner is None and chown_root:
            owner = _lookup_owner(STATE_USER)
        try:
            import_restore(paths, owner=owner, log=log)
        except Exception as e:  # noqa: BLE001 - never fail the boot
            log(f"restore: {e}")
    return s


# --- restore bundle ----------------------------------------------------------------
#
# tools/bridge_migrate/bridge_migrate.py (`restore --card`) writes, on a freshly
# flashed card:
#
#     splanc-restore/manifest.json
#         {"format": "splanc-bridge-restore", "v": 1, "created_at": <unix s>,
#          "bridge_ids": {"<relay>": "<id>"},
#          "files": [{"path": "bridge.json", "size": N, "sha256": "<hex>"}, ...]}
#     splanc-restore/state/<path>     the files, relative to the state directory
#
# and this imports them into /var/lib/splanc-bridge (owner splanc, 0700 dirs /
# 0600 files) before the bridge first runs. All or nothing: every path, size and
# checksum is checked before anything is written, and bridge.json must be a
# usable identity. Files it replaces are kept in <state>/pre-restore-<time>/. The
# bundle is then deleted from the FAT partition (it holds the bridge's private
# key) and splanc-restore-result.txt says what happened (no secrets). A bundle
# that fails a check stays on the card (nothing is written) so the cause can be
# seen; the digest of an imported manifest is remembered, so a bundle that could
# not be deleted is never imported twice (it would roll newer state back).

RESTORE_DIR = "splanc-restore"
RESTORE_FORMAT = "splanc-bridge-restore"
RESTORE_RESULT = "splanc-restore-result.txt"
RESTORE_MARK = ".restore-imported"
STATE_USER = "splanc"
RESTORE_MAX_FILES = 256
RESTORE_MAX_FILE_BYTES = 16 << 20
RESTORE_MAX_TOTAL_BYTES = 32 << 20
_REL_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")


class RestoreError(Exception):
    pass


def _lookup_owner(user: str) -> Optional[Tuple[int, int]]:
    try:
        import pwd

        pw = pwd.getpwnam(user)
        return pw.pw_uid, pw.pw_gid
    except (ImportError, KeyError):
        return None


def safe_rel_path(rel: str) -> bool:
    """A plain relative path: 1-4 components of [A-Za-z0-9._-] not starting with '.'
    or '-' (no '..', no hidden files, no absolute paths, no backslashes)."""
    if not isinstance(rel, str) or not rel or len(rel) > 512:
        return False
    parts = rel.split("/")
    return 1 <= len(parts) <= 4 and all(_REL_RE.match(p) for p in parts)


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def check_restore(bundle: str) -> Tuple[dict, List[Tuple[str, str]]]:
    """Validate a restore bundle directory. Returns (manifest, [(rel, source path)]).
    Raises RestoreError with a reason (never containing file contents)."""
    mpath = os.path.join(bundle, "manifest.json")
    try:
        if os.path.getsize(mpath) > 1 << 20:
            raise RestoreError("manifest.json is too large")
        with open(mpath, "rb") as f:
            manifest = json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise RestoreError(f"unreadable manifest.json ({type(e).__name__})") from None
    if not isinstance(manifest, dict) or manifest.get("format") != RESTORE_FORMAT:
        raise RestoreError("not a Splanc bridge restore bundle")
    if manifest.get("v") != 1:
        raise RestoreError(f"unsupported restore bundle version {manifest.get('v')!r}")
    files = manifest.get("files")
    if not isinstance(files, list) or not files or len(files) > RESTORE_MAX_FILES:
        raise RestoreError("the manifest lists no files (or too many)")
    out: List[Tuple[str, str]] = []
    seen = set()
    total = 0
    for ent in files:
        rel = ent.get("path") if isinstance(ent, dict) else None
        if not safe_rel_path(rel) or rel in seen:
            raise RestoreError(f"bad or repeated path in the manifest: {rel!r}")
        seen.add(rel)
        src = os.path.join(bundle, "state", *rel.split("/"))
        if os.path.islink(src) or not os.path.isfile(src):
            raise RestoreError(f"{rel} is missing from the bundle")
        size = os.path.getsize(src)
        if size != ent.get("size") or size > RESTORE_MAX_FILE_BYTES:
            raise RestoreError(f"{rel}: wrong size")
        total += size
        if total > RESTORE_MAX_TOTAL_BYTES:
            raise RestoreError("the bundle is too large")
        if _sha256_file(src) != ent.get("sha256"):
            raise RestoreError(f"{rel}: checksum mismatch (the copy on the card is damaged)")
        out.append((rel, src))
    if "bridge.json" not in seen:
        raise RestoreError("the bundle has no bridge.json (the bridge identity)")
    try:
        with open(os.path.join(bundle, "state", "bridge.json"), "rb") as f:
            ident = json.loads(f.read().decode("utf-8"))
        ok = (
            isinstance(ident, dict)
            and isinstance(ident.get("key"), dict)
            and isinstance(ident["key"].get("private_pkcs8"), str)
            and isinstance(ident["key"].get("public_raw"), str)
            and isinstance(ident.get("bridges"), dict)
        )
    except (OSError, ValueError):
        ok = False
    if not ok:
        raise RestoreError("bridge.json is not a usable bridge identity")
    return manifest, out


def _manifest_digest(bundle: str) -> str:
    return _sha256_file(os.path.join(bundle, "manifest.json"))


def _owned(path: str, owner: Optional[Tuple[int, int]]) -> None:
    if owner is not None:
        os.chown(path, owner[0], owner[1])


def _makedirs_owned(path: str, stop: str, owner: Optional[Tuple[int, int]]) -> None:
    """mkdir -p path (0700), chowning every directory it creates below ``stop``."""
    if os.path.isdir(path):
        return
    parent = os.path.dirname(path)
    if parent != path and os.path.abspath(path) != os.path.abspath(stop):
        _makedirs_owned(parent, stop, owner)
    os.mkdir(path, 0o700)
    os.chmod(path, 0o700)
    _owned(path, owner)


def _write_result(paths: Paths, text: str, log: Callable[[str], None]) -> None:
    try:
        _atomic_write(os.path.join(paths.boot, RESTORE_RESULT), text, 0o644)
    except OSError as e:
        log(f"restore: could not write {RESTORE_RESULT}: {e}")


def import_restore(
    paths: Paths,
    *,
    owner: Optional[Tuple[int, int]] = None,
    log: Callable[[str], None] = print,
    now: Callable[[], float] = time.time,
) -> bool:
    """Import ``<boot>/splanc-restore`` into ``paths.state``. True when imported."""
    bundle = os.path.join(paths.boot, RESTORE_DIR)
    if not os.path.isdir(bundle):
        return False
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now()))
    try:
        manifest, files = check_restore(bundle)
    except RestoreError as e:
        log(f"restore: NOT imported: {e}")
        _write_result(paths, f"failed {stamp}: {e}\nNothing was changed.\n", log)
        return False
    digest = _manifest_digest(bundle)
    mark = os.path.join(paths.state, RESTORE_MARK)
    if (_read_text(mark) or "").strip() == digest:
        log("restore: this bundle was already imported; removing it from the boot partition")
        shutil.rmtree(bundle, ignore_errors=True)
        return False

    os.makedirs(os.path.dirname(paths.state), mode=0o755, exist_ok=True)
    _makedirs_owned(paths.state, os.path.dirname(paths.state), owner)
    os.chmod(paths.state, 0o700)
    _owned(paths.state, owner)
    saved = os.path.join(paths.state, f"pre-restore-{stamp}")
    for rel, src in files:
        dst = os.path.join(paths.state, *rel.split("/"))
        if os.path.lexists(dst):
            keep = os.path.join(saved, *rel.split("/"))
            _makedirs_owned(os.path.dirname(keep), paths.state, owner)
            os.replace(dst, keep)
        _makedirs_owned(os.path.dirname(dst), paths.state, owner)
        tmp = dst + ".restore-tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as out, open(src, "rb") as inp:
            shutil.copyfileobj(inp, out)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, 0o600)
        _owned(tmp, owner)
        os.replace(tmp, dst)
    _atomic_write(mark, digest + "\n", 0o600)
    _owned(mark, owner)
    ids = manifest.get("bridge_ids") if isinstance(manifest.get("bridge_ids"), dict) else {}
    id_txt = ", ".join(str(v) for v in ids.values() if isinstance(v, str)) or "?"
    log(f"restore: imported {len(files)} file(s) into {paths.state} (bridge {id_txt})")
    if os.path.isdir(saved):
        log(f"restore: the files it replaced are in {saved}")
    shutil.rmtree(bundle, ignore_errors=True)
    if os.path.isdir(bundle):
        log("restore: could not remove the bundle from the boot partition")
    _write_result(
        paths,
        f"ok {stamp}: restored {len(files)} file(s), bridge {id_txt}\n",
        log,
    )
    return True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="splanc-flash-config")
    ap.add_argument("--boot", default="/boot/firmware")
    ap.add_argument("--state", default="/var/lib/splanc-bridge")
    a = ap.parse_args(argv)
    if not os.path.isdir(a.boot):
        print(f"{a.boot} is not mounted; nothing to apply")
        return 0
    try:
        apply(
            Paths(boot=a.boot, state=a.state),
            log=lambda m: print(f"splanc-flash-config: {m}", flush=True),
        )
    except Exception as e:  # noqa: BLE001 - never fail the boot
        print(f"splanc-flash-config: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
