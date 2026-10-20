"""The privileged raw-write worker — the ONLY code that runs as root/admin.

Adapted from td-deploy Studio (app/deploy_engine/flasher/rawwrite.py, MIT).

Deliberately tiny and stdlib-only: open the image, open the whole device, copy in
large chunks, read it back and compare, and append progress lines to a plain
text file the (unprivileged) parent tails. The parent does all disk selection
and confirmation; this only writes the bytes it is told to, where it is told.

Progress file lines:
    W <done> <total>     writing
    V <done> <total>     verifying (reading the card back)
    DONE <total>
    ERROR <message>

Entry points:
  * the frozen sidecar re-invoked elevated with ``--raw-write`` (the same binary
    the user already runs: no external interpreter);
  * ``python -m splanc_flasher.rawwrite <image> <device> <progress> [--no-verify]``.
"""

from __future__ import annotations

import errno
import hashlib
import os
import sys

CHUNK = 8 << 20  # 8 MiB: a multiple of every sector size
SECTOR = 4096  # raw devices (Windows, macOS rdisk) want sector-aligned I/O


def _open_help(device: str, e: OSError) -> str:
    """An actionable message for EPERM/EACCES on the raw device.

    On recent macOS, raw access to removable media is gated by Full Disk Access
    even for root: the elevated write is attributed to the app, so opening
    /dev/rdiskN fails until the app is allowed. No code can bypass that."""
    if sys.platform == "darwin" and e.errno in (errno.EPERM, errno.EACCES):
        return (
            f"macOS blocked raw disk access to {device}. Open System Settings > Privacy & "
            "Security > Full Disk Access, turn on 'Splanc Bridge Flasher' (add it with + "
            "if it isn't listed), quit and reopen the app, and flash again. "
            f"[{e.strerror}]"
        )
    if sys.platform.startswith("win") and e.errno in (errno.EPERM, errno.EACCES):
        return (
            f"Windows refused to open {device} ({e.strerror}). Close any window showing the "
            "card, then try again."
        )
    return f"cannot open {device} for writing: {e.strerror}"


def _pad(chunk: bytes) -> bytes:
    rem = len(chunk) % SECTOR
    return chunk if rem == 0 else chunk + b"\0" * (SECTOR - rem)


def _drop_caches(fd: int) -> None:
    """Linux: make the read-back hit the card, not the page cache."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import fcntl

        fcntl.ioctl(fd, 0x1261)  # BLKFLSBUF
    except OSError:
        pass
    try:
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    except (OSError, AttributeError):
        pass


def _reread_partitions(device: str) -> None:
    """Linux: have the kernel see the new partition table (for the boot-config mount)."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import fcntl

        fd = os.open(device, os.O_RDONLY)
        try:
            fcntl.ioctl(fd, 0x125F)  # BLKRRPART
        finally:
            os.close(fd)
    except OSError:
        pass


def raw_write(image: str, device: str, progress_file: str, verify: bool = True) -> int:
    total = os.path.getsize(image)
    flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_SYNC", 0)
    try:
        dst = os.open(device, flags)
    except OSError as e:
        raise OSError(_open_help(device, e)) from e
    want = hashlib.sha256()
    try:
        with open(image, "rb") as src, open(progress_file, "a") as pf:
            pf.write(f"W 0 {total}\n")
            pf.flush()
            done = 0
            while True:
                chunk = src.read(CHUNK)
                if not chunk:
                    break
                chunk = _pad(chunk)
                want.update(chunk)
                view = memoryview(chunk)
                off = 0
                while off < len(chunk):
                    off += os.write(dst, view[off:])
                done += len(chunk)
                pf.write(f"W {min(done, total)} {total}\n")
                pf.flush()
            os.fsync(dst)
            if verify:
                _drop_caches(dst)
                os.lseek(dst, 0, os.SEEK_SET)
                got = hashlib.sha256()
                left = done
                read = 0
                pf.write(f"V 0 {total}\n")
                pf.flush()
                while left > 0:
                    buf = os.read(dst, min(CHUNK, left))
                    if not buf:
                        raise OSError(f"the card ended after {read} bytes (fake capacity?)")
                    got.update(buf)
                    left -= len(buf)
                    read += len(buf)
                    pf.write(f"V {min(read, total)} {total}\n")
                    pf.flush()
                if got.digest() != want.digest():
                    raise OSError(
                        "what was read back from the card differs from the image: the card or "
                        "the reader is faulty (or the card is a fake-capacity one)"
                    )
    finally:
        os.close(dst)
    _reread_partitions(device)
    with open(progress_file, "a") as pf:
        pf.write(f"DONE {total}\n")
    return 0


def main(argv: list) -> int:
    verify = "--no-verify" not in argv
    args = [a for a in argv if a != "--no-verify"]
    if len(args) != 3:
        sys.stderr.write("usage: rawwrite <image> <device> <progress_file> [--no-verify]\n")
        return 2
    try:
        return raw_write(args[0], args[1], args[2], verify=verify)
    except Exception as e:  # noqa: BLE001 - report to the progress file for the parent
        try:
            with open(args[2], "a") as pf:
                pf.write(f"ERROR {e}\n")
        except OSError:
            pass
        sys.stderr.write(f"rawwrite failed: {e}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
