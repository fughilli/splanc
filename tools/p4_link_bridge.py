"""Host bridge for the P4 player (docs/design/p4-c6-split.md §3.3): plays the C6's part.

Serves ws://<host>:<port>/ws. Each WebSocket client is a link session: its binary
messages go to the P4 as PLAYER frames (MORE-fragmented past the MTU), and the P4's
REPLY / PUSH frames for that session come back as WebSocket messages. LOG frames and
any plain console text (the ROM, the bootloader, a panic) are printed.

    python3 tools/p4_link_bridge.py --port /dev/cu.usbmodem… [--reset]

OSC datagrams to udp/<--osc-port> (9000) go to the P4 as OSC frames, as the C6 front end
forwards them: point an OSC sender (e.g. the lighthouse demo's --fixture) at this host.
    bazel run //tools:player_probe -- ws://127.0.0.1:8081/ws

Needs pyserial and websockets.
"""

from __future__ import annotations

import argparse
import asyncio
import struct
import sys
import threading
import time

import serial
import websockets

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import p4_link as L  # noqa: E402


class Bridge:
    def __init__(self, port: str, baud: int, reset: bool, verbose: bool):
        self.ser = serial.Serial()
        self.ser.port = port
        self.ser.baudrate = baud
        self.ser.timeout = 0.05
        # Opening a CH34x port toggles DTR/RTS, which is the board's auto-reset:
        # hold both released unless a reset was asked for.
        self.ser.dtr = False
        self.ser.rts = False
        self.ser.open()
        if reset:
            self.ser.rts = True
            time.sleep(0.1)
            self.ser.rts = False
        self.verbose = verbose
        self.tx_lock = threading.Lock()
        self.seq = 0
        self.sessions: dict[int, websockets.WebSocketServerProtocol] = {}
        self.inbox: dict[int, asyncio.Queue] = {}
        self.next_session = 1
        self.reasm = L.Reassembler()
        self.p4_seen = 0.0
        self.stats = {"rx": 0, "tx": 0, "noise": 0}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.log_buf = ""
        self.osc_out = None  # the udp/9000 endpoint
        self.osc_peer = None  # the last OSC sender

    # -- serial side -------------------------------------------------------------
    def send(self, frame: L.Frame) -> None:
        with self.tx_lock:
            frame.seq = self.seq
            self.seq = (self.seq + 1) & 0xFFFF
            self.ser.write(L.encode(frame))
            self.stats["tx"] += 1

    def send_link(self, op: int, body: bytes = b"") -> None:
        self.send(L.Frame(L.LINK, bytes([op]) + body))

    def reader(self) -> None:
        dec = L.StreamDecoder()
        while True:
            data = self.ser.read(4096)
            if not data:
                continue
            for item in dec.feed(data):
                if isinstance(item, bytes):
                    self.stats["noise"] += 1
                    text = item.decode("utf-8", "replace").rstrip()
                    if text and (self.verbose or text.isprintable() or "\n" in text):
                        print(f"[p4 raw] {text}", flush=True)
                    continue
                self.stats["rx"] += 1
                self.p4_seen = time.monotonic()
                self.loop.call_soon_threadsafe(self.on_frame, item)

    def on_frame(self, f: L.Frame) -> None:
        if f.type == L.LOG:
            # LOG frames cut the console stream anywhere; print whole lines.
            self.log_buf += f.payload.decode("utf-8", "replace").replace("\r\n", "\n")
            *lines, self.log_buf = self.log_buf.split("\n")
            for line in lines:
                print("[p4] " + line, flush=True)
        elif f.type == L.LINK and f.payload:
            op = f.payload[0]
            if op == L.OP_HELLO:
                ver, minor, mtu = (
                    f.payload[1],
                    f.payload[2],
                    struct.unpack_from("<H", f.payload, 3)[0],
                )
                print(f"[bridge] P4 link up: v{ver}.{minor}, MTU {mtu}", flush=True)
            elif op == L.OP_RESET and len(f.payload) >= 3:
                s = struct.unpack_from("<H", f.payload, 1)[0]
                ws = self.sessions.get(s)
                print(f"[bridge] P4 dropped session {s}", flush=True)
                if ws is not None:
                    asyncio.ensure_future(ws.close(1011, "player dropped the session"))
        elif f.type == L.OSC:
            if self.osc_out is not None and self.osc_peer is not None:
                self.osc_out.sendto(f.payload, self.osc_peer)
        elif f.type in (L.REPLY, L.PUSH):
            msg = self.reasm.push(f)
            if msg is None:
                return
            ws = self.sessions.get(f.session)
            if ws is None and f.type == L.PUSH and self.sessions:
                ws = next(reversed(self.sessions.values()))
            if ws is not None:
                asyncio.ensure_future(self._ws_send(ws, msg))

    async def _ws_send(self, ws, msg: bytes) -> None:
        try:
            await ws.send(msg)
        except websockets.ConnectionClosed:
            pass

    async def heartbeat(self) -> None:
        was_up = False
        while True:
            await asyncio.sleep(0.1)
            self.send_link(L.OP_HEARTBEAT)
            up = time.monotonic() - self.p4_seen < 0.35
            if up != was_up:
                if not up:
                    print("[bridge] P4 link down (no frames for 350 ms)", flush=True)
                was_up = up

    # -- WebSocket side ----------------------------------------------------------
    async def client(self, ws) -> None:
        path = getattr(getattr(ws, "request", None), "path", None) or getattr(ws, "path", "/ws")
        if path.split("?")[0] != "/ws":
            await ws.close(1008, "path must be /ws")
            return
        s = self.next_session
        self.next_session = self.next_session % 0xFFFF + 1
        self.sessions[s] = ws
        print(f"[bridge] client {ws.remote_address} is session {s}", flush=True)
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    continue  # the player protocol is binary only
                for f in L.fragments(L.PLAYER, msg, session=s):
                    self.send(f)
        except websockets.ConnectionClosed:
            pass
        finally:
            del self.sessions[s]
            self.send_link(L.OP_RESET, struct.pack("<H", s))
            print(f"[bridge] session {s} closed", flush=True)

    async def run(self, host: str, port: int, osc_port: int = 0) -> None:
        self.loop = asyncio.get_running_loop()
        if osc_port:
            bridge = self

            class OscIn(asyncio.DatagramProtocol):
                def connection_made(self, transport):
                    bridge.osc_out = transport

                def datagram_received(self, data, addr):
                    bridge.osc_peer = addr  # the P4's OSC out goes back here, as the C6 does
                    if len(data) <= L.MTU:
                        bridge.send(L.Frame(L.OSC, data))

            await self.loop.create_datagram_endpoint(OscIn, local_addr=(host, osc_port))
            print(f"[bridge] OSC udp://{host}:{osc_port} -> the P4", flush=True)
        threading.Thread(target=self.reader, daemon=True).start()
        self.send_link(L.OP_HELLO, bytes([L.VERSION, 0]) + struct.pack("<H", L.MTU))
        asyncio.ensure_future(self.heartbeat())
        async with websockets.serve(self.client, host, port, max_size=1 << 20):
            print(
                f"[bridge] serving ws://{host}:{port}/ws -> {self.ser.port} @ {self.ser.baudrate}",
                flush=True,
            )
            await asyncio.Future()


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--port", required=True, help="the P4 board's USB serial port")
    ap.add_argument(
        "--baud", type=int, default=2000000, help="link baud rate (link_transport.cpp kBaud)"
    )
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--ws-port", type=int, default=8081)
    ap.add_argument("--reset", action="store_true", help="reset the board first (RTS)")
    ap.add_argument(
        "--osc-port",
        type=int,
        default=9000,
        help="forward OSC datagrams from this UDP port (0: off)",
    )
    ap.add_argument("-v", "--verbose", action="store_true", help="print undecodable bytes too")
    a = ap.parse_args()
    try:
        asyncio.run(Bridge(a.port, a.baud, a.reset, a.verbose).run(a.host, a.ws_port, a.osc_port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
