"""The bridge's saved WiFi networks: NetworkManager keyfiles, written like the flasher's.

Networks reach the bridge two ways, and both end up stored the same way, as a
NetworkManager keyfile (root, 0600) in /etc/NetworkManager/system-connections:

  * at flash time: the Splanc Bridge Flasher renders ``splanc-wifi.nmconnection``
    onto the boot partition and ``bootconfig`` moves it into NetworkManager's
    store on first boot;
  * later, from the Splanc phone app over Improv-over-BLE (``splanc_image.improv``),
    which calls ``plan`` + ``write`` here. The keyfile is rendered by the
    flasher's own ``render_nmconnection`` (same SSID byte list, same PSK escaping),
    so for the same SSID/PSK the bytes are identical to a flash-time profile.

A network sent over Improv is ADDED next to the ones the bridge already knows
(NetworkManager then joins whichever known network is in range, preferring the
most recently used), deduplicated by SSID: a network with the same SSID as a saved
profile replaces that profile in place (same file, id and uuid), so a changed
password doesn't leave a stale duplicate behind. The first network is
``splanc-wifi`` (as the flasher names it), later ones ``splanc-wifi-2``, ``-3`` ...

Pure stdlib + the flasher's renderer: unit-tested against a temp dir.
"""

from __future__ import annotations

import os
import re
import uuid as uuidlib
from dataclasses import dataclass
from typing import Dict, List, Optional

from splanc_flasher import bootfiles

NM_DIR = "/etc/NetworkManager/system-connections"
BASE_ID = "splanc-wifi"
MAX_FILE_BYTES = 64 << 10

_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


@dataclass
class Profile:
    """A saved WiFi profile (the fields dedupe needs)."""

    path: str
    conn_id: str
    uuid: str
    ssid: Optional[bytes]


@dataclass
class Plan:
    """Where and what to write for one network."""

    path: str
    conn_id: str
    uuid: str
    body: str
    previous: Optional[str]  # the replaced profile's text (same SSID), for a rollback


def _unescape_kf(v: str) -> str:
    """GLib key-file string unescaping (\\s \\n \\t \\r \\\\)."""
    out, i = [], 0
    while i < len(v):
        c = v[i]
        if c == "\\" and i + 1 < len(v):
            out.append(
                {"s": " ", "n": "\n", "t": "\t", "r": "\r", "\\": "\\"}.get(v[i + 1], v[i + 1])
            )
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def keyfile_ssid(value: str) -> bytes:
    """A keyfile ``ssid=`` value -> the SSID bytes. NetworkManager accepts the
    byte-list form (``77;121;``, what the flasher writes) and a plain string."""
    v = value.strip()
    if re.fullmatch(r"(\d{1,3};)+\d{0,3}", v):
        parts = [p for p in v.split(";") if p != ""]
        if all(int(p) < 256 for p in parts):
            return bytes(int(p) for p in parts)
    return _unescape_kf(v).encode("utf-8")


def parse_keyfile(text: str) -> Dict[str, Dict[str, str]]:
    """Just enough of the GLib key-file format: groups of key=value lines."""
    groups: Dict[str, Dict[str, str]] = {}
    cur: Optional[Dict[str, str]] = None
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            cur = groups.setdefault(line[1:-1], {})
        elif cur is not None and "=" in line:
            k, v = line.split("=", 1)
            cur[k.strip()] = v.lstrip()
    return groups


def _read(path: str) -> Optional[str]:
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        with open(path, "rb") as f:
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def profiles(nm_dir: str = NM_DIR) -> List[Profile]:
    """The keyfile profiles in NetworkManager's store (ssid None for non-WiFi)."""
    out = []
    try:
        names = sorted(os.listdir(nm_dir))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".nmconnection"):
            continue
        path = os.path.join(nm_dir, name)
        text = _read(path)
        if text is None:
            continue
        kf = parse_keyfile(text)
        conn = kf.get("connection", {})
        wifi = kf.get("wifi", kf.get("802-11-wireless", {}))
        is_wifi = conn.get("type") in ("wifi", "802-11-wireless")
        ssid = keyfile_ssid(wifi["ssid"]) if is_wifi and "ssid" in wifi else None
        out.append(Profile(path, conn.get("id", ""), conn.get("uuid", ""), ssid))
    return out


def plan(wifi: bootfiles.Wifi, nm_dir: str = NM_DIR, *, new_uuid: Optional[str] = None) -> Plan:
    """Decide the file/id/uuid for ``wifi`` and render its keyfile (raises
    bootfiles.InvalidSetting for an SSID/PSK the flasher would also refuse)."""
    bootfiles.check_ssid(wifi.ssid)
    bootfiles.check_psk(wifi.psk)
    have = profiles(nm_dir)
    ids = {p.conn_id for p in have}
    files = {os.path.basename(p.path) for p in have}

    def free_id() -> str:
        n = 1
        while True:
            cid = BASE_ID if n == 1 else f"{BASE_ID}-{n}"
            if cid not in ids and f"{cid}.nmconnection" not in files:
                return cid
            n += 1

    want = wifi.ssid.encode("utf-8")
    same = next((p for p in have if p.ssid == want), None)
    if same is not None:
        # Same network: replace that profile in place (keep its file, id, uuid).
        path = same.path
        conn_id = same.conn_id if _ID_RE.match(same.conn_id) else free_id()
        conn_uuid = same.uuid if _UUID_RE.match(same.uuid) else (new_uuid or str(uuidlib.uuid4()))
        previous = _read(path)
    else:
        conn_id = free_id()
        path = os.path.join(nm_dir, f"{conn_id}.nmconnection")
        conn_uuid = new_uuid or str(uuidlib.uuid4())
        previous = None
    body = bootfiles.render_nmconnection(wifi, conn_uuid=conn_uuid, conn_id=conn_id)
    return Plan(path, conn_id, conn_uuid, body, previous)


def _atomic_write(path: str, data: str, *, chown_root: bool) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    if chown_root:
        os.chown(tmp, 0, 0)
    os.replace(tmp, path)


def write(p: Plan, *, chown_root: bool = True) -> None:
    """Store the profile (0600, root, atomically) — as bootconfig stores the
    flasher's."""
    _atomic_write(p.path, p.body, chown_root=chown_root)


def rollback(p: Plan, *, chown_root: bool = True) -> None:
    """Undo ``write``: restore the replaced profile, or remove the added one."""
    if p.previous is not None:
        _atomic_write(p.path, p.previous, chown_root=chown_root)
    else:
        try:
            os.remove(p.path)
        except FileNotFoundError:
            pass
