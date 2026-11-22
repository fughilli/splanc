"""hitl_ble_player's BLE link-loss handling (the ble_capture_e2e / ble_player_e2e driver).

On hitl-rig-2 the central drops a connected BLE link (DUT `disc=0x08`) about once per
40 s; bleak then fails the in-flight write with "ATT error: 0x0e (Unlikely Error)" (or
"Service Discovery has not been performed yet"). The driver rides out a bounded number
of such drops the way the app's client does — reconnect, hello, resend — and must NOT
mistake a device that refuses or ignores a request on a live link for a drop. bleak is
stubbed with a fake client; the exchange logic runs offline.
"""

import asyncio
import importlib
import struct
import sys
import types


def _install_bleak_stub():
    if "bleak" in sys.modules:  # another test module's stub; we patch what we use below
        return
    bleak = types.ModuleType("bleak")
    bleak.BleakClient = object
    bleak.BleakScanner = object
    exc = types.ModuleType("bleak.exc")

    class BleakError(Exception):
        pass

    exc.BleakError = BleakError
    bleak.exc = exc
    sys.modules["bleak"] = bleak
    sys.modules["bleak.exc"] = exc


_install_bleak_stub()
player = importlib.import_module("hitl_ble_player")
BleakError = player.BleakError  # whichever stub bound first; it is in _TRANSPORT_ERRORS
ATT_0E = "[org.bluez.Error.Failed] Operation failed with ATT error: 0x0e (Unlikely Error)"


class _Dev:
    address = "CC:FD:49:00:3F:0A"
    name = "Led Widget 31687A"


class _FakeLink:
    """One BLE link. `plan` (shared across links) maps the Nth request written (0-based,
    counting re-hellos) to an action: "reply" (default), "drop_write" (the link dies
    under the write: 0x0e), "drop_wait" (the write lands, then the link dies before the
    reply), "refuse" (the device answers the write with an ATT error, link stays up),
    "silent" (no reply on a live link)."""

    def __init__(self, world, disconnected_callback):
        self.world = world
        self.cb = disconnected_callback
        self.is_connected = True
        self.notify = None
        self.buf = bytearray()

    async def start_notify(self, _uuid, cb):
        self.notify = cb

    async def disconnect(self):
        self.is_connected = False

    def _drop(self):
        self.is_connected = False
        if self.cb:
            self.cb(self)

    async def write_gatt_char(self, _uuid, data, response=True):
        if not self.is_connected:
            raise BleakError("Service Discovery has not been performed yet")
        self.buf.extend(data)
        n = struct.unpack_from(">I", self.buf, 0)[0]
        if len(self.buf) < 4 + n:
            return
        payload = bytes(self.buf[4 : 4 + n])
        self.buf.clear()
        k = self.world.requests
        self.world.requests += 1
        action = self.world.plan.get(k, "reply")
        self.world.sent.append(payload)
        if action == "drop_write":
            self.world.sent.pop()  # never reached the device
            self._drop()
            raise BleakError(ATT_0E)
        if action == "refuse":
            raise BleakError("[org.bluez.Error.Failed] Operation failed with ATT error: 0x0d")
        if action == "drop_wait":
            asyncio.get_running_loop().call_later(0.01, self._drop)
            return
        if action == "silent":
            return
        reply = b"R:" + payload
        wire = struct.pack(">I", len(reply)) + reply
        loop = asyncio.get_running_loop()
        for off in range(0, len(wire), 7):  # several notifications, like the MTU chunks
            loop.call_soon(self.notify, None, wire[off : off + 7])


class _World:
    def __init__(self, plan=None):
        self.plan = plan or {}
        self.sent = []
        self.requests = 0  # every request written, incl. ones a dropped link swallowed
        self.connects = 0


def _run(world, frames, **kw):
    async def fake_find(address, name_filter, scan_seconds):
        return _Dev(), _Dev.name

    async def fake_connect(dev, tries, timeout, disconnected_callback=None):
        world.connects += 1
        return _FakeLink(world, disconnected_callback)

    player.find = fake_find
    player._connect = fake_connect
    args = dict(
        address=_Dev.address,
        name_filter="",
        scan_seconds=1,
        timeout=kw.pop("timeout", 2.0),
        connect_tries=1,
        connect_timeout=1,
    )
    args.update(kw)
    return asyncio.run(player.exchange(frames, **args))


FRAMES = [b"hello", b"start", b"stage1", b"timing", b"w0", b"w1", b"w2"]
UPLOAD = 4  # frames[4:] are the sharded map windows


def _replies(res):
    import base64

    return [base64.b64decode(r) for r in res["replies_b64"]]


def test_clean_exchange_has_no_link_losses():
    w = _World()
    res = _run(w, FRAMES, max_link_losses=3, upload_start=UPLOAD)
    assert res["ok"], res
    assert _replies(res) == [b"R:" + f for f in FRAMES]
    assert res["link_losses"] == [] and w.connects == 1 and w.sent == FRAMES


def test_att_0e_under_a_write_reconnects_rehellos_and_resends():
    w = _World({2: "drop_write"})  # stage1's write dies with 0x0e (the rig-2 failure)
    res = _run(w, FRAMES, max_link_losses=3, upload_start=UPLOAD)
    assert res["ok"], res
    assert _replies(res) == [b"R:" + f for f in FRAMES]  # one reply per frame, in order
    assert w.connects == 2
    # hello, start, [link lost], hello again on the new link, then stage1 resent.
    assert w.sent == [b"hello", b"start", b"hello", b"stage1", b"timing", b"w0", b"w1", b"w2"]
    (loss,) = res["link_losses"]
    assert loss["frame"] == 3 and "0x0e" in loss["error"]


def test_link_dropping_while_awaiting_the_reply_is_a_link_loss():
    w = _World({3: "drop_wait"})  # timing's write lands, the link dies before the reply
    res = _run(w, FRAMES, max_link_losses=3, upload_start=UPLOAD, timeout=5.0)
    assert res["ok"], res
    assert _replies(res) == [b"R:" + f for f in FRAMES]
    assert w.sent[3:6] == [b"timing", b"hello", b"timing"]
    assert res["link_losses"][0]["frame"] == 4


def test_loss_mid_upload_restarts_the_upload_from_window_0():
    w = _World({6: "drop_write"})  # w2's write dies; w0/w1 were already acked
    res = _run(w, FRAMES, max_link_losses=3, upload_start=UPLOAD)
    assert res["ok"], res
    assert _replies(res) == [b"R:" + f for f in FRAMES]
    assert w.sent == FRAMES[:6] + [b"hello", b"w0", b"w1", b"w2"]


def test_more_losses_than_the_budget_fail():
    w = _World({1: "drop_write", 3: "drop_write"})  # request 3 = frame 2 again, after the re-hello
    res = _run(w, FRAMES, max_link_losses=1, upload_start=UPLOAD)
    assert not res["ok"]
    assert "0x0e" in res["error"] and len(res["link_losses"]) == 2


def test_default_budget_zero_fails_on_the_first_loss_like_before():
    w = _World({2: "drop_write"})
    res = _run(w, FRAMES)
    assert not res["ok"] and "ATT error: 0x0e" in res["error"] and w.connects == 1


def test_device_refusing_a_write_on_a_live_link_is_not_resumed():
    w = _World({2: "refuse"})
    res = _run(w, FRAMES, max_link_losses=3, upload_start=UPLOAD)
    assert not res["ok"] and "0x0d" in res["error"]
    assert res["link_losses"] == [] and w.connects == 1


def test_no_reply_on_a_live_link_is_a_timeout_not_a_loss():
    w = _World({2: "silent"})
    res = _run(w, FRAMES, max_link_losses=3, upload_start=UPLOAD, timeout=0.2)
    assert not res["ok"] and "timed out" in res["error"]
    assert res["link_losses"] == [] and w.connects == 1


def test_is_link_loss_classification():
    assert player.is_link_loss(BleakError(ATT_0E), connected=True)
    assert player.is_link_loss(BleakError("Service Discovery has not been performed yet"), True)
    assert player.is_link_loss(EOFError(), True)
    assert player.is_link_loss(BleakError("anything"), connected=False)
    assert not player.is_link_loss(BleakError("Operation failed with ATT error: 0x0d"), True)
    assert not player.is_link_loss(OSError("permission denied"), True)


def test_resume_point():
    assert player.resume_point(3, None) == 3
    assert player.resume_point(3, 13) == 3  # a request before the upload: resend it
    assert player.resume_point(13, 13) == 13
    assert player.resume_point(20, 13) == 13  # mid-upload: restart at window 0


def test_link_loss_summary():
    core = importlib.import_module("ble_link_core")
    assert core.link_loss_summary([]) == "[ble-capture] link losses: 0"
    assert core.link_loss_summary([], tag="ble-e2e") == "[ble-e2e] link losses: 0"
    assert core.MAX_LINK_LOSSES >= 1
    s = core.link_loss_summary([{"frame": 10, "t_s": 17.2, "error": "BleakError: " + ATT_0E}])
    assert s.startswith("[ble-capture] link losses: 1 (frame 10 @17.2s: BleakError:")
