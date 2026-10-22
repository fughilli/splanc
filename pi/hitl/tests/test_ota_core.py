"""The OTA client (harness/ota_core.py) against a simulated device: the app's handoff
to the loader, the stop-and-wait stream, resume after a reset, verification, the
health wait, a rollback, and refusals — the same protocol the firmware speaks
(firmware/ota wire.rs, docs/design/ota.md), so the HITL gate's client logic is proven
before it ever meets a rig."""

import asyncio
import hashlib
import struct

import ledmapper_pb2 as pb
import ota_core as oc
import pytest

PERSIST = 64 * 1024


def package(image: bytes, version: int, good_sig: bool = True) -> bytes:
    signed = (
        struct.pack("<II", version, len(image))
        + hashlib.sha256(image).digest()
        + struct.pack("<I", 0)
    )
    sig = (b"\x01" if good_sig else b"\xee") * 64
    return signed + sig + image


class Reset(Exception):
    pass


class FakeDevice:
    """App + loader + one slot, with the loader's resume record and rollback."""

    def __init__(self, slot_size: int = 600_000, legacy: bool = False) -> None:
        self.mode = "app"
        self.slot = bytearray(slot_size)
        self.slot_size = slot_size
        self.app_version = 0
        self.last = ""
        self.pending = None  # (version, image) installed, not yet proven
        self.job = None  # (manifest bytes, persisted offset)
        self.session = None  # [manifest, next]
        self.health_polls = 0
        self.legacy = legacy
        self.reason = ""
        self.boots = 0

    # -- what a reconnect finds --------------------------------------------------
    def boot(self) -> None:
        self.boots += 1
        if self.mode == "handoff":
            self.mode, self.reason = "loader", "update"
        elif self.mode == "installed":
            version, image = self.pending
            if b"CRASH" in image:
                self.mode, self.reason, self.last = "loader", "rolled_back", "rolled_back"
                self.pending = None
            else:
                self.mode, self.app_version, self.health_polls = "app", version, 0
        elif self.mode == "loader" and self.job:
            self.reason = "incomplete"
        self.session = None

    def welcome(self) -> bytes:
        w = pb.Welcome(fw_version="1.0", mac="AA:BB")
        if self.mode == "loader":
            w.ota.CopyFrom(pb.OtaStatus(mode=oc.MODE_LOADER, loader_reason=self.reason))
            w.features.extend(["ota", "loader"])
        return pb.ServerMessage(welcome=w).SerializeToString()

    def status(self, state=oc.IDLE, error="") -> bytes:
        st = pb.OtaStatus(state=state, error=error, max_chunk=4096, slot_size=self.slot_size)
        st.mode = oc.MODE_LOADER if self.mode == "loader" else oc.MODE_APP
        if self.legacy:
            st.error = "legacy_layout"
        st.last_result = self.last
        st.app_version = self.app_version
        st.loader_reason = self.reason if self.mode == "loader" else ""
        if self.session:
            st.version = struct.unpack_from("<I", self.session[0])[0]
            st.size = struct.unpack_from("<I", self.session[0], 4)[0]
            st.offset = self.session[1]
        return pb.ServerMessage(ota_status=st).SerializeToString()

    def handle(self, raw: bytes) -> bytes:
        m = pb.ClientMessage.FromString(raw)
        arm = m.WhichOneof("msg")
        if arm == "get_ota_status":
            if self.mode == "app" and self.pending and self.health_polls >= 1:
                self.last, self.pending = "ok", None
            self.health_polls += 1
            return self.status()
        if arm == "ota_begin":
            man = m.ota_begin.manifest
            if self.mode == "app":
                self.mode = "handoff"
                return self.status(oc.REBOOTING)
            if man[44] == 0xEE:
                return self.status(oc.FAILED, "bad_signature")
            off = 0
            if self.job and self.job[0] == man:
                off = self.job[1] // 4096 * 4096
            self.session = [man, off]
            self.job = (man, off)
            return self.status(oc.RECEIVING)
        if arm == "ota_chunk":
            c = m.ota_chunk
            if self.session is None:
                return self.status(oc.FAILED, "no_session")
            if c.offset != self.session[1]:
                return self.status(oc.FAILED, "out_of_order")
            self.slot[c.offset : c.offset + len(c.data)] = c.data
            self.session[1] += len(c.data)
            size = struct.unpack_from("<I", self.session[0], 4)[0]
            if self.session[1] // PERSIST > self.job[1] // PERSIST or self.session[1] == size:
                self.job = (self.session[0], self.session[1])
            return self.status(oc.RECEIVING)
        if arm == "ota_finish":
            man = self.session[0]
            version, size = struct.unpack_from("<II", man)
            if self.session[1] != size:
                return self.status(oc.FAILED, "incomplete")
            image = bytes(self.slot[:size])
            if hashlib.sha256(image).digest() != man[8:40]:
                self.job = None
                return self.status(oc.FAILED, "verify_failed")
            self.pending = (version, image)
            self.job = None
            self.last = "installed"
            self.mode = "installed"
            return self.status(oc.INSTALLED)
        return pb.ServerMessage(error=pb.Error(code="unsupported")).SerializeToString()


class FakeLink:
    def __init__(self, dev: FakeDevice) -> None:
        self.dev = dev
        self.inbox: list[bytes] = []
        self.up = False
        self.opens = 0

    async def open(self, deadline: float) -> pb.Welcome:
        self.dev.boot() if not self.up and self.opens else None
        self.opens += 1
        self.up = True
        return pb.ServerMessage.FromString(self.dev.welcome()).welcome

    async def send(self, frame: bytes) -> None:
        if not self.up:
            raise oc.LinkDropped("down")
        self.inbox.append(self.dev.handle(frame))

    async def recv(self, timeout: float) -> bytes:
        if not self.inbox:
            raise TimeoutError()
        return self.inbox.pop(0)

    async def close(self) -> None:
        self.up = False
        self.inbox.clear()


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def fast_sleep(monkeypatch):
    async def nosleep(_s):
        return None

    monkeypatch.setattr(oc.asyncio, "sleep", nosleep)


def test_split_package_checks_the_image_against_its_manifest():
    img = bytes(range(256)) * 40
    man, image, m = oc.split_package(package(img, 7))
    assert (m.version, m.size, image) == (7, len(img), img)
    bad = bytearray(package(img, 7))
    bad[-1] ^= 1
    with pytest.raises(oc.OtaError):
        oc.split_package(bytes(bad))


def test_update_from_the_app_hands_over_streams_and_waits_for_health():
    dev = FakeDevice()
    img = bytes(i % 251 for i in range(300_000))
    seen = []
    r = run(oc.push(FakeLink(dev), package(img, 1_009_000), progress=lambda p, i: seen.append(p)))
    assert r.outcome == "ok"
    assert bytes(dev.slot[: len(img)]) == img
    assert dev.app_version == 1_009_000 and dev.last == "ok"
    assert r.handoff_s is not None and r.bytes_sent == len(img) and r.resumes == 0
    assert seen[0] == "handoff" and "installed" in seen and seen[-1] == "healthy"


def test_a_reset_mid_transfer_resumes_from_the_persisted_offset():
    dev = FakeDevice()
    img = bytes((i * 7) % 253 for i in range(400_000))
    cut = {"done": False}

    async def interrupt(offset):
        if not cut["done"] and offset >= 200_000:
            cut["done"] = True
            dev.mode = "loader"  # a reset lands back in the loader (job record kept)
            return True
        return False

    r = run(oc.push(FakeLink(dev), package(img, 5), interrupt=interrupt))
    assert r.outcome == "ok" and r.resumes == 1
    assert r.resumed_from == [196608], "the last 64 KiB boundary at or below the cut"
    assert bytes(dev.slot[: len(img)]) == img


def test_a_rolled_back_image_is_reported_not_retried():
    dev = FakeDevice()
    img = b"CRASH" + bytes(100_000)
    r = run(oc.push(FakeLink(dev), package(img, 9), expect_healthy=False))
    assert r.outcome == "rolled_back"
    assert r.final["mode"] == "MODE_LOADER" and r.final["last_result"] == "rolled_back"
    with pytest.raises(oc.OtaError) as e:
        run(oc.push(FakeLink(FakeDevice()), package(img, 9)))
    assert e.value.code == "rolled_back"


def test_the_loader_refuses_a_bad_signature():
    dev = FakeDevice()
    with pytest.raises(oc.OtaError) as e:
        run(oc.push(FakeLink(dev), package(bytes(50_000), 3, good_sig=False)))
    assert e.value.code == "bad_signature"
    assert dev.slot == bytearray(dev.slot_size), "nothing written"


def test_a_legacy_layout_needs_the_usb_migration():
    with pytest.raises(oc.OtaError) as e:
        run(oc.push(FakeLink(FakeDevice(legacy=True)), package(bytes(1000), 1)))
    assert e.value.code == "legacy_layout"


def test_gate_verdicts():
    C = oc.Check
    assert oc.verdict([C("a", True), C("b", True)]) == "PASS"
    assert oc.verdict([C("a", True), C("b", False)]) == "FAIL"
    assert oc.verdict([C("infra", None)]) == "SKIP"
    before = {"cert_sha256": "ab" * 32, "map_leds": 120, "map_sha": "x"}
    good = {
        "leased": True,
        "ip": "10.0.0.2",
        "cert_sha256": "ab" * 32,
        "map_leds": 120,
        "map_sha": "x",
        "migrated_files": 4,
    }
    assert oc.verdict(oc.migration_checks(before, good)) == "PASS"
    for broken in (
        {**good, "leased": False},
        {**good, "cert_sha256": "cd" * 32},
        {**good, "map_sha": "y"},
        {**good, "migrated_files": 0},
    ):
        assert oc.verdict(oc.migration_checks(before, broken)) == "FAIL", broken
