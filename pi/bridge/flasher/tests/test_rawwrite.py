"""The privileged worker, the progress protocol and the elevation wrappers."""

import base64
import os
import subprocess
import sys

import pytest
from splanc_flasher import elevate, flash, rawwrite


def test_write_and_verify_byte_parity(tmp_path):
    img, dev, prog = tmp_path / "a.img", tmp_path / "dev", tmp_path / "p"
    data = os.urandom(rawwrite.CHUNK + 12345)  # spans chunks, unaligned tail
    img.write_bytes(data)
    dev.write_bytes(b"")
    assert rawwrite.raw_write(str(img), str(dev), str(prog)) == 0
    written = dev.read_bytes()
    assert written[: len(data)] == data
    assert len(written) % rawwrite.SECTOR == 0 and set(written[len(data) :]) <= {0}
    lines = prog.read_text().splitlines()
    assert lines[0] == f"W 0 {len(data)}" and lines[-1] == f"DONE {len(data)}"
    assert any(ln.startswith("V ") for ln in lines)


def test_verify_catches_a_card_that_lies(tmp_path, monkeypatch):
    img, dev, prog = tmp_path / "a.img", tmp_path / "dev", tmp_path / "p"
    img.write_bytes(os.urandom(100_000))
    dev.write_bytes(b"")
    real_read = os.read
    monkeypatch.setattr(
        rawwrite.os, "read", lambda fd, n: bytes(len(real_read(fd, n)))
    )  # all zeros
    assert rawwrite.main([str(img), str(dev), str(prog)]) == 1
    assert "differs from the image" in prog.read_text()


def test_missing_device_reports_error(tmp_path):
    img, prog = tmp_path / "a.img", tmp_path / "p"
    img.write_bytes(b"x" * 10)
    assert rawwrite.main([str(img), str(tmp_path / "nope" / "dev"), str(prog)]) == 1
    assert prog.read_text().startswith("ERROR ")


class FakeProc:
    def __init__(self, rc=0, alive=False):
        self.rc, self.alive = rc, alive

    def poll(self):
        return None if self.alive else self.rc

    def wait(self):
        return self.rc


def test_tail_progress_stages_and_errors(tmp_path):
    p = tmp_path / "prog"
    p.write_text("W 0 100\nW 50 100\nV 100 100\nDONE 100\n")
    seen = []
    flash.tail_progress(str(p), FakeProc(), lambda s, f, m: seen.append((s, f)), poll=0)
    assert seen == [("write", 0.0), ("write", 0.5), ("check", 1.0)]
    p.write_text("W 0 100\nERROR macOS blocked raw disk access\n")
    with pytest.raises(flash.FlashError, match="blocked"):
        flash.tail_progress(str(p), FakeProc(), lambda *a: None, poll=0)
    p.write_text("")
    with pytest.raises(flash.FlashError, match="cancelled"):
        flash.tail_progress(str(p), FakeProc(rc=1), lambda *a: None, poll=0)


def test_worker_runs_from_source_as_a_subprocess(tmp_path):
    img, dev, prog = tmp_path / "a b.img", tmp_path / "dev", tmp_path / "p"
    img.write_bytes(b"hello" * 1000)
    dev.write_bytes(b"")
    argv = elevate.worker_argv(str(img), str(dev), str(prog))
    assert subprocess.run(argv, env={**os.environ, "PYTHONPATH": ""}).returncode == 0
    assert dev.read_bytes()[:5000] == b"hello" * 1000


def test_macos_wrapper_quotes_paths():
    cmd = elevate.elevated_macos(["/App/side car", "--raw-write", '/tmp/a "b".img'], "/dev/disk4")
    assert cmd[0] == "osascript"
    script = cmd[2]
    assert "with administrator privileges" in script
    assert "diskutil unmountDisk force /dev/disk4" in script
    assert '\\"b\\"' in script  # AppleScript-escaped


def test_windows_wrapper_onlines_the_disk_and_encodes_the_script():
    cmd = elevate.elevated_windows(
        [
            "C:\\Program Files\\x\\side.exe",
            "--raw-write",
            "C:\\a b\\i.img",
            "\\\\.\\PhysicalDrive3",
            "C:\\p",
        ],
        "3",
    )
    outer = cmd[-1]
    assert "-Verb RunAs" in outer and "-EncodedCommand" in outer
    b64 = outer.split("'-EncodedCommand','")[1].split("'")[0]
    inner = base64.b64decode(b64).decode("utf-16-le")
    assert "Set-Disk -Number 3 -IsOffline $true" in inner
    assert (
        inner.index("IsOffline $true")
        < inner.index("Start-Process")
        < inner.index("IsOffline $false")
    )
    assert "Add-PartitionAccessPath" in inner
    assert "'\"C:\\a b\\i.img\"'" in inner


@pytest.mark.skipif(sys.platform.startswith("win"), reason="pkexec/sudo are Unix")
def test_linux_wrapper(monkeypatch):
    import shutil

    monkeypatch.setattr(shutil, "which", lambda n: "/usr/bin/pkexec")
    assert elevate.elevated_linux(["a"], None) == ["pkexec", "a"]
