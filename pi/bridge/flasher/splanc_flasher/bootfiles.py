"""Render the per-card settings onto the freshly written card's FAT boot partition.

The host half of pi/bridge/image/splanc_image/bootconfig.py (which documents the
files and applies them on every boot). Pure filesystem + stdlib: no mounting, no
elevation, so it's unit-testable against a temp dir.

    splanc-bridge.conf                          KEY=VALUE settings
    system-connections/splanc-wifi.nmconnection NetworkManager WiFi profile
    authorized_keys                             optional SSH public key(s)

Adapted from td-deploy Studio (app/deploy_engine/flash_config.py, MIT), with the
NetworkManager keyfile escaping made exact:

  * the SSID is always written as NetworkManager's byte list (``ssid=77;121;``),
    which is unambiguous for every SSID — a plain ``ssid=`` string is not (``123``
    would be read as the single byte 123, ``;`` needs escaping, non-ASCII bytes
    are only representable as a list);
  * the PSK is a GLib key-file string: ``\\`` is doubled and a leading/trailing
    space becomes ``\\s`` (GLib would strip it).
"""

from __future__ import annotations

import os
import re
import uuid
from dataclasses import dataclass
from typing import List, Optional

CONF_NAME = "splanc-bridge.conf"
CONNECTIONS_DIR = "system-connections"
WIFI_FILE = "splanc-wifi.nmconnection"
AUTHORIZED_KEYS = "authorized_keys"

_HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_HEX64 = re.compile(r"^[0-9A-Fa-f]{64}$")
_URL_RE = re.compile(r"^(wss|ws|https|http)://[^\s\"'\\`$]+$")
_KEY_PREFIXES = (
    "ssh-ed25519 ",
    "ssh-rsa ",
    "ecdsa-sha2-",
    "sk-ssh-ed25519@openssh.com ",
    "sk-ecdsa-sha2-",
)


class InvalidSetting(ValueError):
    pass


@dataclass
class Wifi:
    ssid: str
    psk: str = ""  # empty: an open network
    hidden: bool = False


def check_ssid(ssid: str) -> None:
    n = len((ssid or "").encode("utf-8"))
    if n == 0:
        raise InvalidSetting("Enter the WiFi network name.")
    if n > 32:
        raise InvalidSetting("WiFi network names are at most 32 bytes long.")


def check_psk(psk: str) -> None:
    """WPA2/WPA3 personal: 8-63 printable ASCII characters, or 64 hex digits."""
    if psk == "" or _HEX64.match(psk):
        return
    if not 8 <= len(psk) <= 63:
        raise InvalidSetting("WiFi passwords are 8 to 63 characters long.")
    if any(not (32 <= ord(c) <= 126) for c in psk):
        raise InvalidSetting(
            "The WiFi password has a character WPA doesn't allow (only plain letters, "
            "digits, spaces and punctuation)."
        )


def slug_hostname(name: str) -> Optional[str]:
    """A device name -> its .local hostname ("Living Room" -> "living-room")."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")[:63].rstrip("-")
    return s if _HOSTNAME_RE.match(s) else None


def check_country(code: str) -> str:
    c = (code or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{2}", c):
        raise InvalidSetting("The WiFi country is a two-letter code such as US or DE.")
    return c


def check_relay(url: str) -> str:
    u = (url or "").strip()
    if u and not _URL_RE.match(u):
        raise InvalidSetting("The relay must be a wss:// or https:// URL.")
    return u


def ssh_key_lines(text: str) -> List[str]:
    lines = [k.strip() for k in (text or "").splitlines() if k.strip()]
    bad = [k for k in lines if not k.startswith(_KEY_PREFIXES)]
    if bad:
        raise InvalidSetting("That doesn't look like an SSH public key (ssh-ed25519 AAAA...).")
    return lines


def _kf_string(value: str) -> str:
    """Escape a GLib key-file string value."""
    out = value.replace("\\", "\\\\")
    if out.startswith(" "):
        out = "\\s" + out[1:]
    if out.endswith(" ") and len(out) > 0:
        out = out[:-1] + "\\s"
    return out


def _comment_safe(s: str) -> str:
    return "".join(c if c.isprintable() else "?" for c in s)


def render_nmconnection(
    wifi: Wifi, *, conn_uuid: Optional[str] = None, conn_id: str = "splanc-wifi"
) -> str:
    """A NetworkManager keyfile for one WiFi network (WPA-PSK, or open).

    Also the bridge's Improv-over-BLE path (pi/bridge/image/splanc_image/
    wifi_profiles.py) renders through here, so a network sent from the phone app
    is stored exactly like one written at flash time; it passes ``conn_id`` (and
    the file name) for the networks it adds next to ``splanc-wifi``.
    """
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", conn_id):
        raise InvalidSetting(f"bad connection id {conn_id!r}")
    check_ssid(wifi.ssid)
    check_psk(wifi.psk)
    ssid_bytes = ";".join(str(b) for b in wifi.ssid.encode("utf-8")) + ";"
    lines = [
        f"# Splanc bridge WiFi: {_comment_safe(wifi.ssid)}",
        "# (written by the Splanc Bridge Flasher; the Pi moves it into NetworkManager",
        "# on boot and deletes it from this card)",
        "[connection]",
        f"id={conn_id}",
        f"uuid={conn_uuid or uuid.uuid4()}",
        "type=wifi",
        "autoconnect=true",
        "",
        "[wifi]",
        "mode=infrastructure",
        f"ssid={ssid_bytes}",
    ]
    if wifi.hidden:
        lines.append("hidden=true")
    if wifi.psk:
        lines += ["", "[wifi-security]", "key-mgmt=wpa-psk", f"psk={_kf_string(wifi.psk)}"]
    lines += [
        "",
        "[ipv4]",
        "method=auto",
        "",
        "[ipv6]",
        "method=auto",
        "addr-gen-mode=stable-privacy",
    ]
    return "\n".join(lines) + "\n"


def render_conf(
    *, hostname: Optional[str] = None, country: Optional[str] = None, relay: Optional[str] = None
) -> str:
    lines = [
        "# Splanc bridge settings, read by the Pi on every boot. You can edit this file",
        "# on any computer; see https://github.com/fughilli/splanc/blob/main/docs/pi-bridge.md",
        "#",
        "#   HOSTNAME=splanc-bridge     the Pi's name on the network (<name>.local)",
        "#   WIFI_COUNTRY=US            two-letter country code for WiFi channels",
        "#   SPLANC_RELAY=              relay URL (empty: the bridge's default)",
        "#   OLED=auto                  OLED HAT: auto | spi | i2c | off",
        "#   OLED_ROTATE=2              0-3 (x90 degrees)",
        "#   SPLANC_DISPLAY_HDMI=auto   HDMI status page: auto | off",
        "#   SPLANC_AUTO_UPDATE=1       look for updates in the background: 1 | 0 (installing",
        "#                              always asks first, on the screen; 0 = check by hand only)",
        "",
    ]
    if hostname:
        if not _HOSTNAME_RE.match(hostname):
            raise InvalidSetting(f"bad hostname {hostname!r}")
        lines.append(f"HOSTNAME={hostname}")
    if country:
        lines.append(f"WIFI_COUNTRY={check_country(country)}")
    if relay:
        lines.append(f"SPLANC_RELAY={check_relay(relay)}")
    return "\n".join(lines) + "\n"


def _write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())


def write_boot_config(
    mount_dir: str,
    *,
    wifi: Optional[Wifi] = None,
    hostname: Optional[str] = None,
    country: Optional[str] = None,
    relay: Optional[str] = None,
    ssh_keys: Optional[List[str]] = None,
) -> List[str]:
    """Write the settings files under the mounted boot partition; return their paths."""
    if not os.path.isfile(os.path.join(mount_dir, "config.txt")):
        raise FileNotFoundError(f"{mount_dir} is not a Raspberry Pi boot partition (no config.txt)")
    written = []
    path = os.path.join(mount_dir, CONF_NAME)
    _write(path, render_conf(hostname=hostname, country=country, relay=relay))
    written.append(path)
    if wifi is not None:
        d = os.path.join(mount_dir, CONNECTIONS_DIR)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, WIFI_FILE)
        _write(path, render_nmconnection(wifi))
        written.append(path)
    if ssh_keys:
        path = os.path.join(mount_dir, AUTHORIZED_KEYS)
        _write(path, "\n".join(ssh_keys) + "\n")
        written.append(path)
    return written
