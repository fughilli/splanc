"""The pull-device OTA client (harness/ota_core.py `pull`, Splanc MAX,
docs/design/max-ota.md) against a simulated Pi: player + root updater advanced one
step per status read, rebooting under the client into the trial and, when the new
system never proves healthy, back to the old one."""

import asyncio
import struct

import ledmapper_pb2 as pb
import ota_core as oc
import pytest


def manifest(version: int, size: int, sig: int = 1) -> bytes:
    return struct.pack("<II", version, size) + b"\0" * 32 + struct.pack("<I", 0) + bytes([sig]) * 64


class FakeMax:
    def __init__(self, healthy: bool = True, fail: str = "") -> None:
        self.healthy, self.fail = healthy, fail
        self.phase, self.last, self.error = "idle", "", ""
        self.version, self.size, self.fetched = 0, 0, 0
        self.app_version = 1_009_000
        self.up = True
        self.reboots = 0
        self.begins: list[pb.OtaBegin] = []

    def status(self, state, error="") -> pb.OtaStatus:
        return pb.OtaStatus(
            mode=pb.OtaStatus.MODE_APP,
            state=state,
            error=error,
            version=self.version,
            size=self.size,
            offset=self.fetched,
            app_version=self.app_version,
            last_result=self.last,
            board="pi3",
        )

    def reboot(self) -> None:
        self.up = False
        self.reboots += 1

    def handle(self, msg: pb.ClientMessage) -> pb.OtaStatus:
        arm = msg.WhichOneof("msg")
        if arm == "ota_begin":
            b = msg.ota_begin
            self.begins.append(b)
            if b.manifest[44] == 0xEE:
                return self.status(oc.FAILED, "bad_signature")
            self.version, self.size = struct.unpack_from("<II", b.manifest)
            self.phase, self.last, self.fetched = "downloading", "", 0
            return self.status(oc.DOWNLOADING)
        assert arm == "get_ota_status"
        if self.phase == "downloading":
            self.fetched = min(self.size, self.fetched + self.size // 2 + 1)
            if self.fail and self.fetched >= self.size // 2:
                self.phase, self.error = "failed", self.fail
                return self.status(oc.FAILED, self.fail)
            if self.fetched >= self.size:
                self.phase = "importing"
            return self.status(oc.DOWNLOADING)
        if self.phase == "importing":
            self.phase, self.last = "staged", "installed"
            return self.status(oc.VERIFYING)
        if self.phase == "staged":
            self.phase = "trial"
            st = self.status(oc.INSTALLED)
            self.reboot()
            return st
        if self.phase == "trial":
            if self.healthy:
                self.phase, self.last, self.app_version = "idle", "ok", self.version
            else:
                self.phase, self.last, self.error = (
                    "idle",
                    "rolled_back",
                    "unhealthy: no health file",
                )
                self.reboot()
                raise ConnectionError("rebooting")
        if self.phase == "failed":
            return self.status(oc.FAILED, self.error)
        return self.status(oc.IDLE, self.error)


class Link:
    def __init__(self, dev: FakeMax) -> None:
        self.dev = dev
        self.inbox: list[bytes] = []

    async def open(self, deadline):
        self.dev.up = True
        return pb.Welcome(features=["ota", "ota_pull"])

    async def send(self, frame):
        if not self.dev.up:
            raise oc.LinkDropped("down")
        msg = pb.ClientMessage.FromString(frame)
        try:
            st = self.dev.handle(msg)
        except ConnectionError as e:
            raise oc.LinkDropped(str(e))
        self.inbox.append(pb.ServerMessage(ota_status=st).SerializeToString())

    async def recv(self, timeout):
        if not self.inbox:
            raise TimeoutError("recv")
        return self.inbox.pop(0)

    async def close(self):
        pass


def run(coro):
    return asyncio.run(coro)


def test_pull_update_ok():
    dev = FakeMax()
    phases = []
    r = run(
        oc.pull(
            Link(dev),
            manifest(1_010_000, 1000),
            source_url="http://x/y",
            poll_s=0,
            progress=lambda p, i: phases.append(p),
        )
    )
    assert r.outcome == "ok" and dev.app_version == 1_010_000
    assert dev.begins[0].source_url == "http://x/y" and len(dev.begins[0].manifest) == 108
    assert dev.reboots == 1
    assert {"download", "installed", "healthy"} <= set(phases)


def test_pull_rolls_back():
    r = run(
        oc.pull(
            Link(FakeMax(healthy=False)), manifest(1_010_000, 1000), poll_s=0, expect_healthy=False
        )
    )
    assert r.outcome == "rolled_back"
    assert r.final["error"].startswith("unhealthy")
    with pytest.raises(oc.OtaError) as e:
        run(oc.pull(Link(FakeMax(healthy=False)), manifest(1_010_000, 1000), poll_s=0))
    assert e.value.code == "rolled_back"


def test_pull_refusals():
    with pytest.raises(oc.OtaError) as e:
        run(oc.pull(Link(FakeMax()), manifest(1_010_000, 1000, sig=0xEE), poll_s=0))
    assert e.value.code == "bad_signature"
    with pytest.raises(oc.OtaError) as e:
        run(oc.pull(Link(FakeMax(fail="verify_failed")), manifest(1_010_000, 1000), poll_s=0))
    assert e.value.code == "verify_failed"


def test_pulls_image():
    assert oc.pulls_image(pb.Welcome(features=["ota", "ota_pull"]))
    assert not oc.pulls_image(pb.Welcome(features=["ota"]))
