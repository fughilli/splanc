"""Build the privileged command that runs the raw-write worker as root/admin.

Adapted from td-deploy Studio (app/deploy_engine/flasher/elevate.py, MIT).

The worker is this same program re-invoked: the frozen sidecar with a
``--raw-write`` flag (so the elevated process is the code the user already runs,
no external interpreter), or ``python -m splanc_flasher.rawwrite`` from source.
One OS prompt (Touch ID / password on macOS, UAC on Windows, polkit on Linux)
covers the whole write.
"""

from __future__ import annotations

import base64
import os
import shlex
import sys
from typing import Optional


def worker_argv(image: str, device: str, progress_file: str, verify: bool = True) -> list:
    """Unprivileged form of the worker command (before elevation wrapping)."""
    args = [image, device, progress_file] + ([] if verify else ["--no-verify"])
    if getattr(sys, "frozen", False):
        return [sys.executable, "--raw-write", *args]
    pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return [sys.executable, "-c", _DEV_BOOT.format(path=pkg_parent), *args]


# From source: run the worker with the package importable (python -m would need
# the cwd/PYTHONPATH, which pkexec/sudo scrub).
_DEV_BOOT = (
    "import sys; sys.path.insert(0, {path!r}); from splanc_flasher import rawwrite; "
    "raise SystemExit(rawwrite.main(sys.argv[1:]))"
)


def _applescript_quote(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def elevated_macos(argv: list, unmount_disk: Optional[str]) -> list:
    """osascript -> one Touch ID / password prompt runs the whole thing as root.

    ``unmount_disk`` (/dev/diskN) is force-unmounted first: writing the raw node
    fails while its volumes are mounted."""
    inner = ""
    if unmount_disk:
        inner += f"/usr/sbin/diskutil unmountDisk force {shlex.quote(unmount_disk)} >/dev/null; "
    inner += " ".join(shlex.quote(a) for a in argv)
    prompt = "Splanc Bridge Flasher needs your password to write the SD card."
    script = (
        f'do shell script "{_applescript_quote(inner)}" with prompt '
        f'"{_applescript_quote(prompt)}" with administrator privileges'
    )
    return ["osascript", "-e", script]


def _ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def elevated_windows(argv: list, disk_number: Optional[str]) -> list:
    """A UAC-elevated PowerShell that takes the card offline (so Windows lets go of
    its volumes), runs the worker, then brings the card back online and gives its
    FAT boot partition a drive letter (so the settings can be written onto it)."""
    exe, rest = argv[0], argv[1:]
    inner = ""
    if disk_number is not None:
        n = int(disk_number)
        inner += (
            f"Set-Disk -Number {n} -IsReadOnly $false -ErrorAction SilentlyContinue; "
            f"Set-Disk -Number {n} -IsOffline $true -ErrorAction SilentlyContinue; "
        )
    inner += f"$w = Start-Process -FilePath {_ps_quote(exe)} -ArgumentList " + ",".join(
        _ps_quote('"' + a + '"') for a in rest
    )
    inner += " -WindowStyle Hidden -Wait -PassThru; $rc = $w.ExitCode; "
    if disk_number is not None:
        n = int(disk_number)
        inner += (
            f"Set-Disk -Number {n} -IsOffline $false -ErrorAction SilentlyContinue; "
            "Update-HostStorageCache -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; "
            f"$p = Get-Partition -DiskNumber {n} -ErrorAction SilentlyContinue | "
            "Where-Object { $_.PartitionNumber -eq 1 } | Select-Object -First 1; "
            "if ($p -and -not $p.DriveLetter) { $p | Add-PartitionAccessPath "
            "-AssignDriveLetter -ErrorAction SilentlyContinue }; "
        )
    inner += "exit $rc"
    # The outer (unelevated) PowerShell starts the elevated one and returns its exit
    # code. -EncodedCommand (UTF-16LE base64) carries the script without any of
    # Windows' command-line quoting getting a chance to mangle paths.
    encoded = base64.b64encode(inner.encode("utf-16-le")).decode("ascii")
    outer = (
        "$e = Start-Process -FilePath powershell -Verb RunAs -WindowStyle Hidden -Wait "
        f"-PassThru -ArgumentList '-NoProfile','-EncodedCommand','{encoded}'; exit $e.ExitCode"
    )
    return ["powershell", "-NoProfile", "-Command", outer]


def elevated_linux(argv: list, _disk: Optional[str]) -> list:
    """pkexec (a graphical polkit prompt); sudo -n as a fallback for headless dev."""
    from shutil import which

    if which("pkexec"):
        return ["pkexec", *argv]
    return ["sudo", "-n", *argv]


def elevated_command(argv: list, device_hint: Optional[str]) -> list:
    if sys.platform == "darwin":
        return elevated_macos(argv, device_hint)
    if sys.platform.startswith("win"):
        return elevated_windows(argv, device_hint)
    return elevated_linux(argv, device_hint)
