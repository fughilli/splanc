"""Enumerate the disks it is safe to flash: removable/external media only.

Adapted from td-deploy Studio's flasher (github.com/fughilli/td-deploy,
app/deploy_engine/flasher/disks.py, MIT, same author).

Flashing writes raw blocks to a whole device, so pointing it at the wrong disk
destroys data. The safety property: **only removable / external media is ever
offered**, never a system disk. Each OS backend filters before a device is shown,
and the parsers are split from command execution so they can be unit-tested
against captured `diskutil` / `Get-Disk` / `lsblk` output with no hardware.

Refused, beyond "not removable":
  * macOS: internal disks, virtual disks (disk images, APFS containers);
  * Windows: system/boot disks, read-only disks, buses other than USB/SD/MMC;
  * Linux: any disk with a partition mounted at a system path (/, /boot, /usr,
    /home, swap, ...), loop/zram devices;
  * everywhere: disks smaller than the image (`fits()`), and empty readers.
"""

from __future__ import annotations

import json
import plistlib
import subprocess
import sys
from dataclasses import asdict, dataclass
from typing import Optional

# Bigger than any SD card people use for a Pi: the UI asks twice for these
# (an external backup drive is "removable" too).
LARGE_DISK_BYTES = 256 * 10**9

_LINUX_SYSTEM_MOUNTS = ("/", "/boot", "/boot/efi", "/efi", "/usr", "/var", "/home", "[SWAP]")


@dataclass
class Disk:
    id: str  # device path to write: /dev/rdiskN, \\.\PhysicalDriveN, /dev/sdX
    name: str  # human label (model / media name)
    size: int  # bytes
    removable: bool  # always True for anything we surface
    bus: str = ""  # USB / SD / ...

    @property
    def size_gb(self) -> float:
        return self.size / 1e9

    @property
    def large(self) -> bool:
        return self.size >= LARGE_DISK_BYTES

    def fits(self, image_bytes: int) -> bool:
        return self.size >= image_bytes

    def to_dict(self) -> dict:
        d = asdict(self)
        d["size_gb"] = round(self.size_gb, 1)
        d["large"] = self.large
        return d


def _run(cmd: list) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30).stdout


# ---------------------------------------------------------------- macOS --------
def parse_macos(list_plist: bytes, info_plists: dict) -> list:
    """`diskutil list -plist external physical` + per-disk `diskutil info -plist`."""
    top = plistlib.loads(list_plist)
    out = []
    for dev in top.get("WholeDisks", []):
        raw = info_plists.get(dev)
        if raw is None:
            continue
        info = plistlib.loads(raw)
        if info.get("Internal", True):  # hard guard: never internal disks
            continue
        if not info.get("RemovableMediaOrExternalDevice", info.get("Ejectable", False)):
            continue
        if str(info.get("VirtualOrPhysical", "Physical")).lower() == "virtual":
            continue
        if str(info.get("BusProtocol", "")).lower() == "disk image":
            continue
        size = int(info.get("TotalSize") or info.get("Size") or 0)
        if size <= 0:  # card reader with no card
            continue
        name = info.get("MediaName") or info.get("IORegistryEntryName") or dev
        out.append(
            Disk(
                id=f"/dev/r{dev}",  # raw node = much faster writes
                name=str(name).strip(),
                size=size,
                removable=True,
                bus=str(info.get("BusProtocol", "")),
            )
        )
    return out


def _list_macos() -> list:
    list_plist = _run(["diskutil", "list", "-plist", "external", "physical"]).encode()
    top = plistlib.loads(list_plist)
    infos = {
        dev: _run(["diskutil", "info", "-plist", dev]).encode() for dev in top.get("WholeDisks", [])
    }
    return parse_macos(list_plist, infos)


# -------------------------------------------------------------- Windows --------
_WIN_BUSES = ("USB", "SD", "SDCard", "MMC")
_PS_LIST = (
    "Get-Disk | Where-Object { $_.BusType -in "
    + ",".join(f"'{b}'" for b in _WIN_BUSES)
    + " } | Select-Object Number,FriendlyName,Size,BusType,IsSystem,IsBoot,IsReadOnly "
    "| ConvertTo-Json -Depth 3"
)


def parse_windows(js: str) -> list:
    data = json.loads(js) if js.strip() else []
    if isinstance(data, dict):
        data = [data]
    out = []
    for d in data:
        if d.get("IsSystem") or d.get("IsBoot") or d.get("IsReadOnly"):  # hard guard
            continue
        if str(d.get("BusType", "")) not in _WIN_BUSES:
            continue
        size = int(d.get("Size") or 0)
        if size <= 0:
            continue
        out.append(
            Disk(
                id=f"\\\\.\\PhysicalDrive{int(d['Number'])}",
                name=str(d.get("FriendlyName") or f"Disk {d['Number']}").strip(),
                size=size,
                removable=True,
                bus=str(d.get("BusType", "")),
            )
        )
    return out


def _list_windows() -> list:
    return parse_windows(_run(["powershell", "-NoProfile", "-Command", _PS_LIST]))


# ---------------------------------------------------------------- Linux --------
def _mounts(dev: dict) -> list:
    """Every mountpoint of a device and its children (lsblk >= 2.37 MOUNTPOINTS)."""
    found = []
    for key in ("mountpoints", "mountpoint"):
        v = dev.get(key)
        if isinstance(v, list):
            found += [m for m in v if m]
        elif isinstance(v, str) and v:
            found.append(v)
    for child in dev.get("children") or []:
        found += _mounts(child)
    return found


def parse_linux(js: str) -> list:
    """`lsblk -J -b -o NAME,MODEL,SIZE,RM,TYPE,HOTPLUG,TRAN,RO,MOUNTPOINTS`."""
    data = json.loads(js)
    out = []
    for d in data.get("blockdevices", []):
        if d.get("type") != "disk":
            continue
        name = str(d.get("name", ""))
        if name.startswith(("loop", "zram", "ram", "nbd")):
            continue
        if not (d.get("rm") or d.get("hotplug")):  # hard guard: removable only
            continue
        if d.get("ro"):
            continue
        if any(m in _LINUX_SYSTEM_MOUNTS for m in _mounts(d)):
            continue  # never a disk the running system lives on
        size = int(d.get("size") or 0)
        if size <= 0:
            continue
        out.append(
            Disk(
                id=f"/dev/{name}",
                name=str(d.get("model") or name).strip(),
                size=size,
                removable=True,
                bus=str(d.get("tran") or ("usb" if d.get("hotplug") else "")),
            )
        )
    return out


def _list_linux() -> list:
    cols = "NAME,MODEL,SIZE,RM,TYPE,HOTPLUG,TRAN,RO,MOUNTPOINTS"
    try:
        js = _run(["lsblk", "-J", "-b", "-o", cols])
    except subprocess.CalledProcessError:  # util-linux < 2.37: no MOUNTPOINTS
        js = _run(["lsblk", "-J", "-b", "-o", cols.replace("MOUNTPOINTS", "MOUNTPOINT")])
    return parse_linux(js)


def list_disks() -> list:
    """Removable/external disks only, for the current OS."""
    if sys.platform == "darwin":
        return _list_macos()
    if sys.platform.startswith("win"):
        return _list_windows()
    return _list_linux()


def find_disk(disk_id: str) -> Optional[Disk]:
    """Re-enumerate and confirm ``disk_id`` is still a surfaced removable disk.

    Called right before writing: we never write to an id that isn't in the
    current removable set (e.g. the card was swapped for another disk)."""
    return next((d for d in list_disks() if d.id == disk_id), None)
