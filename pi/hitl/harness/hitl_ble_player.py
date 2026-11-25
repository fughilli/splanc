"""Player-protocol-over-BLE transport driver — runs *inside* the rig container.

Proves the offline configuration path (firmware/player_app/improv_ble.cpp's
player GATT service + web/src/net/bleTransport.ts): with NO WiFi, NO TLS, and NO
cert-trust, exchange one player-protocol frame with the device over Bluetooth.
This is the transport a phone-hotspot user hits when the browser refuses to load
the device's https cert-accept page ("no internet") so wss:// never becomes
trustable.

    python3 hitl_ble_player.py exchange --frames-b64 <b64,b64,…> [--address A|--name N]

Scans for the device (same Improv-service advertisement as onboarding), connects
to the SECOND service — RX (app->device write) + TX (device->app notify),
carrying length-prefixed `[u32 BE len][payload]` frames — writes the given
(already protobuf-encoded) ClientMessage, reassembles the notify stream, and
prints one JSON line {ok, reply_b64, device, error} on stdout (logs to stderr).

The protobuf codec stays on the DRIVER side (hitl_ble_player_e2e.py, like
fx_bench) — this container has bleak but not the generated `server.proto_wire` —
so the wire here is purely the BLE transport + the bleFrame.ts framing, and the
driver encodes the hello / decodes the welcome. The BLE scan + connect-retry are
reused from hitl_improv.py (the same shared, deflaked dance onboarding uses).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import struct
import sys
import time

# The container has no /var/run/dbus; point dbus-fast at the mounted host socket
# (matches container.nix) before importing bleak.
os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")

from bleak.exc import BleakError  # noqa: E402 — after the D-Bus env is set

# Reuse the Improv scan filter + deflaked connect + adapter helpers so this test
# finds and links the SAME device the onboarding flow does.
from hitl_improv import _adapter_kwargs, _connect, find  # noqa: E402,F401

# Player-transport GATT UUIDs — must match improv_ble.cpp / bleTransport.ts.
PLAYER_SVC = "9f5b0000-8a2e-4c1d-9b3a-1f0e2d3c4b5a"
PLAYER_RX = "9f5b0001-8a2e-4c1d-9b3a-1f0e2d3c4b5a"  # app -> device (write)
PLAYER_TX = "9f5b0002-8a2e-4c1d-9b3a-1f0e2d3c4b5a"  # device -> app (notify)

WRITE_CHUNK = 180  # GATT write unit (MTU 247 negotiated; matches the firmware notify chunk)

_TRANSPORT_ERRORS = (BleakError, asyncio.TimeoutError, OSError, EOFError)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def frame_with_length(payload: bytes) -> bytes:
    """Prefix a payload with its u32 big-endian length (bleFrame.frameWithLength)."""
    return struct.pack(">I", len(payload)) + payload


class Reassembler:
    """Inbound notify reassembler — the Python twin of bleFrame.FrameReassembler."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def push(self, chunk: bytes) -> list[bytes]:
        self._buf.extend(chunk)
        out: list[bytes] = []
        while len(self._buf) >= 4:
            n = struct.unpack_from(">I", self._buf, 0)[0]
            if len(self._buf) < 4 + n:
                break
            out.append(bytes(self._buf[4 : 4 + n]))
            del self._buf[: 4 + n]
        return out


# Error text that means the BLE LINK went away under a request — as opposed to the
# firmware answering it with an error. BlueZ fails every ATT request still outstanding
# when the link drops with BT_ATT_ERROR_UNLIKELY, which reaches bleak as
# "Operation failed with ATT error: 0x0e (Unlikely Error)". The netstack GATT server
# (firmware/netstack/src/gatt.rs) never sends 0x0e itself (it only answers with
# invalid-handle / invalid-length / write-not-permitted / not-supported / not-found),
# so on these gates 0x0e is always the link, never the firmware. After BlueZ clears a
# dropped device's services, bleak raises "Service Discovery has not been performed
# yet"; a D-Bus stream closed under us surfaces as a message-less EOFError.
_LINK_LOSS_MARKERS = (
    "ATT error: 0x0e",
    "Unlikely Error",
    "Service Discovery has not been performed yet",
    "Not connected",
    "not connected",
)


class LinkLost(Exception):
    """The BLE link dropped while a frame was in flight (see is_link_loss)."""


def is_link_loss(exc: BaseException, connected: bool) -> bool:
    """Whether a transport failure is the LINK dropping (resumable) rather than the
    device refusing or never answering a request (a real failure)."""
    if isinstance(exc, LinkLost) or not connected:
        return True
    if isinstance(exc, EOFError):
        return True
    msg = str(exc)
    return any(m in msg for m in _LINK_LOSS_MARKERS)


def resume_point(failed: int, upload_start: int | None) -> int:
    """The frame index to resume at after a link loss while frame `failed` was in flight.

    A request/reply frame is resent as is (configure/start/timing are idempotent: the
    device applies the same options again). A sharded upload can NOT resume mid-stream:
    the firmware drops a repeated or skipped window as out of order and stays silent
    (main.cpp process_upload_chunk), while window 0 always restarts the upload — so a
    loss anywhere in the upload restarts it from its first window."""
    if upload_start is not None and failed >= upload_start:
        return upload_start
    return failed


def adapter_identity() -> dict:
    """Which BLE controller this container drives: {hci, path, usb_id} (best effort).

    Logged with every exchange so a rig's link-loss rate can be tied to its actual
    central (USB dongle vs the Pi's onboard controller, which hitl_improv only falls
    back to when no USB controller is up)."""
    hci = _adapter_kwargs().get("adapter") or "default"
    out = {"hci": hci, "path": "", "usb_id": ""}
    if hci == "default":
        return out
    try:
        dev = os.path.realpath(os.path.join("/sys/class/bluetooth", hci, "device"))
        out["path"] = dev
        d = dev
        for _ in range(4):  # the USB interface's parent device carries idVendor/idProduct
            vid, pid = os.path.join(d, "idVendor"), os.path.join(d, "idProduct")
            if os.path.exists(vid) and os.path.exists(pid):
                with open(vid) as fv, open(pid) as fp:
                    out["usb_id"] = f"{fv.read().strip()}:{fp.read().strip()}"
                break
            d = os.path.dirname(d)
    except OSError:
        pass
    return out


async def exchange(
    frames,
    address,
    name_filter,
    scan_seconds,
    timeout,
    connect_tries,
    connect_timeout,
    gap_ms=0.0,
    max_link_losses=0,
    upload_start=None,
):
    """Send each (already protobuf-encoded) frame in order, awaiting one reply per
    frame — the player protocol is strictly request/reply, so a multi-frame
    sequence (e.g. a hello then a sharded map/effect upload) drives cleanly.

    Up to `max_link_losses` times, a dropped BLE link is ridden out the way the app's
    LedMapperClient does it over BLE: reconnect, say hello again, and carry on from
    the frame that was in flight (or the upload's first window, see resume_point).
    Each loss is recorded in the result's `link_losses` (frame, error, seconds into
    the exchange), so the gate reports them. A request the device refuses or never
    answers on a live link is NOT a link loss and still fails at once."""
    dev, nm = await find(address, name_filter, scan_seconds)
    if dev is None:
        return {"ok": False, "error": "no player device found in scan"}
    device = {"name": nm, "address": dev.address}
    adapter = adapter_identity()
    log(f"[ble-player] using {nm} ({dev.address}) via central {adapter}")

    t_start = time.monotonic()
    losses: list[dict] = []
    replies: list[str] = []
    rtts_ms: list[float] = []
    state: dict = {}

    def base(ok: bool, **kw) -> dict:
        return {"ok": ok, "device": device, "adapter": adapter, "link_losses": losses, **kw}

    async def open_link():
        """Connect + subscribe; returns (client, reply queue, link-lost event)."""
        lost = asyncio.Event()
        got: asyncio.Queue = asyncio.Queue()
        reasm = Reassembler()  # fresh per link: never splice a dead link's partial frame

        def on_tx(_sender, data):
            for frame in reasm.push(bytes(data)):
                log(f"[ble-player] <- frame {len(frame)}B")
                got.put_nowait(frame)

        client = await _connect(
            dev, connect_tries, connect_timeout, disconnected_callback=lambda _c: lost.set()
        )
        state["client"] = client
        log(f"[ble-player] connected={client.is_connected}")
        # Subscribe to TX BEFORE writing so the reply is never missed.
        await client.start_notify(PLAYER_TX, on_tx)
        return client, got, lost

    async def request(client, got, lost, payload: bytes) -> bytes:
        wire = frame_with_length(payload)
        for off in range(0, len(wire), WRITE_CHUNK):
            await client.write_gatt_char(PLAYER_RX, wire[off : off + WRITE_CHUNK], response=True)
        reply_t = asyncio.ensure_future(got.get())
        lost_t = asyncio.ensure_future(lost.wait())
        try:
            done, _ = await asyncio.wait(
                {reply_t, lost_t}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for t in (reply_t, lost_t):
                if not t.done():
                    t.cancel()
        if reply_t in done:
            return reply_t.result()
        if lost_t in done:
            raise LinkLost("BLE link dropped while awaiting the reply")
        raise asyncio.TimeoutError()

    i = 0
    link = None
    try:
        while i < len(frames):
            try:
                if link is None:
                    link = await open_link()
                    if losses and i > 0:
                        # A fresh link is a fresh session for the app: hello first.
                        log("[ble-player] re-hello on the new link")
                        await request(*link, frames[0])
                if i > 0 and gap_ms > 0:
                    # Paced sequences (e.g. a capture's phase rotation) — the device
                    # keeps rendering between requests, as it does for the app.
                    await asyncio.sleep(gap_ms / 1000.0)
                t0 = time.monotonic()
                log(
                    f"[ble-player] -> frame {i + 1}/{len(frames)} "
                    f"{len(frames[i]) + 4}B ({len(frames[i])}B payload)"
                )
                reply = await request(*link, frames[i])
            except asyncio.TimeoutError as e:
                if link is None:  # bleak's message-less connect timeout (after _connect's retries)
                    return base(
                        False, error=f"BLE transport failed: {type(e).__name__}: (connect timeout)"
                    )
                if not link[0].is_connected:
                    err: BaseException = LinkLost("BLE link dropped (reply wait timed out)")
                else:
                    return base(False, error="timed out waiting for a reply over BLE")
            except (LinkLost, *_TRANSPORT_ERRORS) as e:
                if link is None:
                    # The (re)connect itself failed — _connect already retried it; a
                    # board that will not take a link is not a dropped link.
                    return base(
                        False,
                        error=f"BLE transport failed: {type(e).__name__}: {e or '(no message)'}",
                    )
                err = e
            else:
                rtts_ms.append(round((time.monotonic() - t0) * 1000.0, 1))
                replies.append(base64.b64encode(reply).decode("ascii"))
                i += 1
                continue
            # A transport failure: resumable only if it is the link and budget remains.
            connected = bool(link[0].is_connected)
            msg = f"{type(err).__name__}: {err or '(no message)'}"
            if not is_link_loss(err, connected):
                return base(False, error=f"BLE transport failed: {msg}")
            losses.append(
                {"frame": i + 1, "error": msg, "t_s": round(time.monotonic() - t_start, 1)}
            )
            log(f"[ble-player] LINK LOST at frame {i + 1}/{len(frames)} ({msg})")
            if len(losses) > max_link_losses:
                return base(False, error=f"BLE transport failed: {msg}")
            resume = resume_point(i, upload_start)
            del replies[resume:]
            del rtts_ms[resume:]
            log(
                f"[ble-player] reconnecting; resuming at frame {resume + 1} "
                f"(link loss {len(losses)}/{max_link_losses})"
            )
            try:
                if link is not None:
                    await link[0].disconnect()
            except Exception:  # noqa: BLE001 — the link is already gone
                pass
            link = None
            i = resume
        return base(True, replies_b64=replies, rtts_ms=rtts_ms)
    except _TRANSPORT_ERRORS as e:  # a reconnect that never came up
        return base(False, error=f"BLE transport failed: {type(e).__name__}: {e or '(no message)'}")
    finally:
        client = state.get("client")
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass


def main() -> int:
    ap = argparse.ArgumentParser(prog="hitl_ble_player")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("exchange")
    ex.add_argument(
        "--frames-b64",
        required=True,
        help="comma-separated base64 ClientMessage frames, sent in order (one reply each)",
    )
    ex.add_argument("--address", help="target this BLE address (else scan for the Improv service)")
    ex.add_argument("--name", default="", help="only match devices whose name contains this")
    ex.add_argument("--scan-seconds", type=float, default=8.0)
    ex.add_argument("--timeout", type=float, default=30.0)
    ex.add_argument("--connect-tries", type=int, default=5)
    ex.add_argument("--connect-timeout", type=float, default=12.0)
    ex.add_argument("--gap-ms", type=float, default=0.0, help="pause between frames")
    ex.add_argument(
        "--max-link-losses",
        type=int,
        default=0,
        help="BLE link drops to ride out by reconnecting + resuming (0 = fail on the first)",
    )
    ex.add_argument(
        "--upload-start",
        type=int,
        default=None,
        help="0-based index of the first sharded-upload window (a loss in the upload restarts it)",
    )
    a = ap.parse_args()
    try:
        frames = [base64.b64decode(f) for f in a.frames_b64.split(",") if f]
        result = asyncio.run(
            exchange(
                frames,
                a.address,
                a.name,
                a.scan_seconds,
                a.timeout,
                a.connect_tries,
                a.connect_timeout,
                a.gap_ms,
                a.max_link_losses,
                a.upload_start,
            )
        )
    except Exception as e:  # noqa: BLE001 — report to the harness as a failed result
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
