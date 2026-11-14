"""Apply the flash-time settings on the card's FAT boot partition (every boot).

The image is one fixed build for every user, so per-card settings can't be baked
in. The Splanc Bridge Flasher (pi/bridge/flasher) writes them onto the boot
partition right after the raw image write, where any computer can also read and
edit them:

    /boot/firmware/splanc-bridge.conf        KEY=VALUE settings (below)
    /boot/firmware/system-connections/*.nmconnection
                                             NetworkManager WiFi profiles
    /boot/firmware/authorized_keys           optional SSH public keys (root)

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
    starts when that file exists — there is no password login).

Settings (unknown keys and bad values are ignored, with a log line):

    HOSTNAME=splanc-bridge          RFC 1123 label (a-z 0-9 -, 1-63 chars)
    WIFI_COUNTRY=US                 two letters
    SPLANC_RELAY=wss://...          relay URL (empty: the bridge's built-in default)
    OLED=auto                       auto | spi | i2c | off
    OLED_ROTATE=2                   0-3 (x90 degrees)
    SPLANC_DISPLAY_HDMI=auto        auto | off
    SPLANC_AUTO_UPDATE=1            1 | 0 (background checks for agent + system updates;
                                    installing always needs a confirmation)

Nothing here can fail the boot: every step is guarded and logged.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

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
}
# Passed on to the services' environment (bridge.env).
ENV_KEYS = ("SPLANC_RELAY", "OLED", "OLED_ROTATE", "SPLANC_DISPLAY_HDMI", "SPLANC_AUTO_UPDATE")

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
    return s


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="splanc-flash-config")
    ap.add_argument("--boot", default="/boot/firmware")
    a = ap.parse_args(argv)
    if not os.path.isdir(a.boot):
        print(f"{a.boot} is not mounted; nothing to apply")
        return 0
    try:
        apply(Paths(boot=a.boot), log=lambda m: print(f"splanc-flash-config: {m}", flush=True))
    except Exception as e:  # noqa: BLE001 - never fail the boot
        print(f"splanc-flash-config: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
