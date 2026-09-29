"""Unit guards for the per-rig AP-EXCLUSIVE bandwidth lock (airtime isolation).

Every DUT on a rig shares ONE AP on ONE 2.4 GHz channel with no airtime-fairness
lever, so under concurrent multi-DUT load a sibling's traffic starves the channel
and breaks cross-DUT isolation (provision-phase DHCP-OFFER timeouts; throughput /
TLS-latency starvation). Two flock-based holders take the air exclusively for only
the airtime-critical phase:

  * hitl_improv._ap_lock  — the in-container provision DHCP-join window.
  * hitl_client.ap_lock   — the runner-side bandwidth-heavy test bodies, held on the
    rig over ssh (the traffic is driven from the runner, so its lock must live on the
    rig, like the flash lock).

Both are best-effort (no lock dir ⇒ unserialized) and rely on flock's auto-release
on fd-close/process-exit as the unconditional guard. These run offline — no rig, no
ssh: the runner-side holder is exercised by running its real holder script LOCALLY
(the same python the container runs), and the ssh transport is stubbed out.
"""

import asyncio
import fcntl
import importlib
import os
import shlex
import subprocess
import sys
import types


def _install_bleak_stub() -> None:
    """hitl_improv imports bleak at module load; stub it so we can import offline.

    This file's tests only exercise _ap_lock (no BLE scan/connect), so a bare stub is
    enough here. test_improv_find re-points hitl_improv's bleak bindings to its own
    functional stub in its module body, so no matter which file imports hitl_improv
    first, the BLE tests there still get their stub (import order can't poison them)."""
    if "bleak" not in sys.modules:
        bleak = types.ModuleType("bleak")

        class _Stub:  # placeholder BleakClient/BleakScanner
            pass

        bleak.BleakClient = _Stub
        bleak.BleakScanner = _Stub
        exc = types.ModuleType("bleak.exc")

        class BleakError(Exception):
            pass

        exc.BleakError = BleakError
        bleak.exc = exc
        sys.modules["bleak"] = bleak
        sys.modules["bleak.exc"] = exc


_install_bleak_stub()
# importlib (not a top-level `import hitl_improv`) so isort can't reorder these ahead of
# the stub install above — hitl_improv's `from bleak import ...` needs the stub present.
hitl_improv = importlib.import_module("hitl_improv")
hitl_client = importlib.import_module("hitl_client")


def _held_elsewhere(path: str) -> bool:
    """True if `path`'s flock is currently held: an independent LOCK_NB acquire fails.

    flock treats file descriptors from separate open() calls independently and they
    DO conflict, so this reports a lock held via any other fd — including one held in
    this same process by the code under test."""
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o666)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        os.close(fd)


# --- hitl_improv._ap_lock (in-container provision DHCP-join window) -----------------


def test_improv_ap_lock_best_effort_when_absent(monkeypatch, tmp_path):
    # No lock dir (rig not yet redeployed) ⇒ the context yields, no error, nothing held.
    monkeypatch.setattr(hitl_improv, "_AP_LOCK_PATH", str(tmp_path / "absent" / "ap.lock"))

    async def go():
        async with hitl_improv._ap_lock("join"):
            return "ran"

    assert asyncio.run(go()) == "ran"


def test_improv_ap_lock_holds_then_releases(monkeypatch, tmp_path):
    d = tmp_path / "ap-lock"
    d.mkdir()
    lock = str(d / "ap.lock")
    monkeypatch.setattr(hitl_improv, "_AP_LOCK_PATH", lock)

    async def go():
        assert not _held_elsewhere(lock)
        async with hitl_improv._ap_lock("join"):
            assert _held_elsewhere(lock)  # exclusive while inside
        assert not _held_elsewhere(lock)  # released on exit

    asyncio.run(go())


def test_improv_ap_lock_releases_on_exception(monkeypatch, tmp_path):
    d = tmp_path / "ap-lock"
    d.mkdir()
    lock = str(d / "ap.lock")
    monkeypatch.setattr(hitl_improv, "_AP_LOCK_PATH", lock)

    async def go():
        async with hitl_improv._ap_lock("join"):
            raise RuntimeError("boom")

    try:
        asyncio.run(go())
    except RuntimeError:
        pass
    assert not _held_elsewhere(lock)  # the finally released it even on error


# --- the runner-side holder script (hitl_client._ap_holder_script) ------------------


def _run_holder(lock_dir: str, hb_timeout: float, **popen_kw) -> subprocess.Popen:
    script = hitl_client._ap_holder_script(lock_dir, hb_timeout)
    return subprocess.Popen(
        ["python3", "-c", script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
        **popen_kw,
    )


def test_holder_unserialized_when_dir_absent(tmp_path):
    p = _run_holder(str(tmp_path / "absent"), 5.0)
    out, _ = p.communicate(input="", timeout=5)
    assert out.strip() == "UNSERIALIZED"
    assert p.returncode == 0


def test_holder_acquires_and_releases_on_eof(tmp_path):
    d = tmp_path / "ap-lock"
    d.mkdir()
    lock = str(d / "ap.lock")
    p = _run_holder(str(d), 5.0)
    assert p.stdout.readline().strip() == "WAIT"
    assert p.stdout.readline().strip() == "HELD"
    assert _held_elsewhere(lock)  # holder holds it
    p.stdin.close()  # EOF ⇒ clean release
    p.wait(timeout=5)
    assert not _held_elsewhere(lock)


def test_holder_releases_on_heartbeat_gap(tmp_path):
    # Crash-safety: with no heartbeats fed, the holder must self-release within ~hb
    # (this is what frees the lock when the driving test is killed).
    d = tmp_path / "ap-lock"
    d.mkdir()
    lock = str(d / "ap.lock")
    p = _run_holder(str(d), 1.0)
    assert p.stdout.readline().strip() == "WAIT"
    assert p.stdout.readline().strip() == "HELD"
    assert _held_elsewhere(lock)
    p.wait(timeout=5)  # no heartbeat over stdin ⇒ select() times out ⇒ exits
    assert not _held_elsewhere(lock)


def test_holder_mutual_exclusion(tmp_path):
    # Two holders on the same dir: the second blocks at WAIT until the first releases.
    d = tmp_path / "ap-lock"
    d.mkdir()
    first = _run_holder(str(d), 5.0)
    assert first.stdout.readline().strip() == "WAIT"
    assert first.stdout.readline().strip() == "HELD"
    second = _run_holder(str(d), 5.0)
    assert second.stdout.readline().strip() == "WAIT"
    # second is now blocked in flock(); it must NOT reach HELD while first holds it.
    try:
        second.wait(timeout=1.0)
        raise AssertionError("second holder should still be blocked on the flock")
    except subprocess.TimeoutExpired:
        pass
    first.stdin.close()  # release the first
    first.wait(timeout=5)
    assert second.stdout.readline().strip() == "HELD"  # second now acquires
    second.stdin.close()
    second.wait(timeout=5)


# --- Reservation.ap_lock end-to-end, with ssh stubbed to run the holder locally -----


def _local_ssh_popen(monkeypatch):
    """Make ap_lock's ssh run the holder LOCALLY: intercept the argv it builds and
    exec its last element (the remote 'python3 -c <holder>') on this host instead."""
    real_popen = subprocess.Popen

    def fake(argv, **kw):
        remote_cmd = argv[-1]  # 'python3 -c <shell-quoted holder>'
        return real_popen(shlex.split(remote_cmd), **kw)

    monkeypatch.setattr(hitl_client.subprocess, "Popen", fake)


def _mk_res() -> "hitl_client.Reservation":
    r = hitl_client.Reservation()
    r.user, r.host, r.port, r._keyfile = "u", "h", 22, "/dev/null"
    return r


def test_reservation_ap_lock_unserialized_when_absent(monkeypatch, tmp_path):
    _local_ssh_popen(monkeypatch)
    r = _mk_res()
    ran = []
    with r.ap_lock("x", lock_dir=str(tmp_path / "absent")):  # must not hang
        ran.append(True)
    assert ran == [True]


def test_reservation_ap_lock_holds_and_releases(monkeypatch, tmp_path):
    _local_ssh_popen(monkeypatch)
    d = tmp_path / "ap-lock"
    d.mkdir()
    lock = str(d / "ap.lock")
    r = _mk_res()
    with r.ap_lock("bench", heartbeat=1.0, lock_dir=str(d)):
        assert _held_elsewhere(lock)  # airtime held across the body
    assert not _held_elsewhere(lock)  # released on context exit
