"""Write an image to a removable disk, then put the per-card settings on it.

Adapted from td-deploy Studio (app/deploy_engine/flasher/__init__.py, MIT).

Safety model:
  * only disks from ``disks.list_disks()`` (removable/external) can be targeted;
  * ``flash()`` re-checks the target right before writing (``require_removable``)
    and that the image fits, so a stale id can never reach another disk;
  * the byte copy runs in the minimal elevated worker (rawwrite.py), which also
    reads the card back and compares; this module stays unprivileged and tails
    the worker's progress file.

After the write, the card's FAT boot partition is mounted as the user (macOS
``diskutil``, Windows drive letter, Linux ``udisksctl``) and the settings are
written (bootfiles.py). Unlike td-deploy, failing to write the WiFi settings IS
an error here: a bridge card without its WiFi is not what the user asked for.
"""

from __future__ import annotations

import os
import plistlib
import re
import subprocess
import sys
import tempfile
import time
from typing import Callable, List, Optional

from . import bootfiles
from .disks import Disk, find_disk
from .elevate import elevated_command, worker_argv

OnProgress = Callable[[str, float, str], None]  # (stage, fraction, message)


class FlashError(RuntimeError):
    pass


def require_removable(disk_id: str) -> Disk:
    disk = find_disk(disk_id)
    if disk is None:
        raise FlashError("That card is no longer connected (or isn't removable). Pick it again.")
    return disk


def _device_hint(disk: Disk) -> Optional[str]:
    if sys.platform == "darwin":
        return disk.id.replace("/dev/r", "/dev/")  # rdiskN -> diskN for unmountDisk
    if sys.platform.startswith("win"):
        m = re.search(r"(\d+)$", disk.id)
        return m.group(1) if m else None
    return None


def tail_progress(path: str, proc, on_progress: OnProgress, poll: float = 0.2) -> None:
    """Follow the worker's progress file until it finishes; raise on ERROR."""
    seen = 0
    error = None
    done = False
    while True:
        alive = proc.poll() is None
        try:
            with open(path) as f:
                lines = f.read().splitlines()
        except OSError:
            lines = []
        for line in lines[seen:]:
            parts = line.split(" ", 1)
            if parts[0] == "ERROR":
                error = parts[1] if len(parts) > 1 else "unknown error"
            elif parts[0] == "DONE":
                done = True
            elif parts[0] in ("W", "V"):
                try:
                    d, t = (int(x) for x in parts[1].split())
                except (IndexError, ValueError):
                    continue
                stage = "write" if parts[0] == "W" else "check"
                verb = "Writing" if stage == "write" else "Checking the card"
                on_progress(stage, d / t if t else 0.0, f"{verb}: {d >> 20} of {t >> 20} MB")
        seen = len(lines)
        if error:
            raise FlashError(error)
        if done or not alive:
            break
        time.sleep(poll)
    rc = proc.wait()
    if not done:
        if rc != 0:
            raise FlashError("Writing was cancelled (the password prompt was dismissed) or failed.")
        raise FlashError("The writer stopped before finishing.")


# --------------------------------------------------------------- boot partition --
def _macos_boot_mount(base: str) -> Optional[str]:
    out = subprocess.run(
        ["diskutil", "list", "-plist", base], capture_output=True, check=True, timeout=60
    ).stdout
    top = plistlib.loads(out)
    for dev in top.get("AllDisksAndPartitions", []):
        for p in dev.get("Partitions", []):
            mp = p.get("MountPoint")
            if mp and os.path.isfile(os.path.join(mp, "config.txt")):
                return mp
    return None


def _windows_boot_mount(disk: Disk) -> Optional[str]:
    m = re.search(r"(\d+)$", disk.id)
    if not m:
        return None
    ps = (
        f"Get-Partition -DiskNumber {int(m.group(1))} | Where-Object {{ $_.DriveLetter }} | "
        "Select-Object -ExpandProperty DriveLetter"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60
    ).stdout
    for letter in out.split():
        root = f"{letter.strip()}:\\"
        if os.path.isfile(os.path.join(root, "config.txt")):
            return root
    return None


def _linux_boot_mount(disk: Disk) -> tuple:
    """(mountpoint, we_mounted_it) via udisks (no root needed), else (None, False)."""
    part = disk.id + ("p1" if re.search(r"\d$", disk.id) else "1")
    # Already auto-mounted by the desktop?
    try:
        mps = subprocess.run(
            ["lsblk", "-n", "-o", "MOUNTPOINT", part], capture_output=True, text=True, timeout=30
        ).stdout.split()
        for mp in mps:
            if os.path.isfile(os.path.join(mp, "config.txt")):
                return mp, False
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        out = subprocess.run(
            ["udisksctl", "mount", "--no-user-interaction", "-b", part],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None, False
    m = re.search(r" at (.+?)\.?$", out.strip())
    return (m.group(1), True) if m else (None, False)


def apply_settings(disk: Disk, settings: dict, log: Callable[[str], None]) -> List[str]:
    """Mount the new card's boot partition, write the settings, unmount/eject."""
    deadline = time.time() + 45  # the OS needs a moment to notice the new partitions
    if sys.platform == "darwin":
        base = disk.id.replace("/dev/r", "/dev/")
        mount = None
        while mount is None and time.time() < deadline:
            subprocess.run(["diskutil", "mountDisk", base], capture_output=True, timeout=60)
            mount = _macos_boot_mount(base)
            if mount is None:
                time.sleep(2)
        if mount is None:
            raise FlashError("The card was written, but its boot partition didn't appear.")
        try:
            return bootfiles.write_boot_config(mount, **settings)
        finally:
            subprocess.run(["diskutil", "eject", base], capture_output=True, timeout=60)
    if sys.platform.startswith("win"):
        mount = None
        while mount is None and time.time() < deadline:
            mount = _windows_boot_mount(disk)
            if mount is None:
                time.sleep(2)
        if mount is None:
            raise FlashError(
                "The card was written, but Windows didn't give its boot partition a drive letter."
            )
        return bootfiles.write_boot_config(mount, **settings)
    mount, ours = None, False
    while mount is None and time.time() < deadline:
        mount, ours = _linux_boot_mount(disk)
        if mount is None:
            time.sleep(2)
    if mount is None:
        raise FlashError("The card was written, but its boot partition couldn't be mounted.")
    try:
        return bootfiles.write_boot_config(mount, **settings)
    finally:
        if ours:
            part = disk.id + ("p1" if re.search(r"\d$", disk.id) else "1")
            subprocess.run(["udisksctl", "unmount", "-b", part], capture_output=True, timeout=60)


# ------------------------------------------------------------------------ flash --
def flash(
    image: str,
    disk_id: str,
    settings: dict,
    *,
    on_progress: OnProgress = lambda s, f, m: None,
    log: Callable[[str], None] = lambda m: None,
    verify: bool = True,
) -> Disk:
    """Raw-write ``image`` to removable ``disk_id`` (elevated), then write the
    settings (bootfiles.write_boot_config kwargs) onto its boot partition."""
    if not os.path.isfile(image):
        raise FileNotFoundError(image)
    disk = require_removable(disk_id)
    size = os.path.getsize(image)
    if not disk.fits(size):
        raise FlashError(
            f"{disk.name} ({disk.size_gb:.1f} GB) is smaller than the image "
            f"({size / 1e9:.1f} GB). Use a card of 4 GB or more."
        )
    on_progress("write", 0.0, f"Waiting for permission to write {disk.name}")
    fd, progress_file = tempfile.mkstemp(prefix="splanc-flash-", suffix=".progress")
    os.close(fd)
    try:
        cmd = elevated_command(
            worker_argv(image, disk.id, progress_file, verify), _device_hint(disk)
        )
        log("elevated: " + " ".join(cmd[:2]) + " ...")
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=sys.stderr)
        tail_progress(progress_file, proc, on_progress)
    finally:
        try:
            os.remove(progress_file)
        except OSError:
            pass
    on_progress("configure", 0.5, "Saving your WiFi and settings to the card")
    written = apply_settings(disk, settings, log)
    for p in written:
        log(f"wrote {p}")
    on_progress("configure", 1.0, "Done")
    return disk
