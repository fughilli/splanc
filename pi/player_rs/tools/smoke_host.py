"""Live smoke test of //pi/player_rs:player_host (docs/host-player.md).

Starts the real binary with a DDP output aimed at a local UDP socket, drives the
app protocol over real WSS (stdlib ssl + a hand-rolled RFC 6455 client, so it
needs nothing beyond Python 3), and checks the pixels that come out: welcome,
submit_map, a submit_effect sharded into upload_chunks, live set_uniforms,
restore from the state dir after a restart, and the --start mapping pattern.
Uses WSS port 18443. No hardware needed.

    bazel build //pi/player_rs:player_host //fx_compiler:fx_compile
    python3 pi/player_rs/tools/smoke_host.py bazel-bin/pi/player_rs/player_host \
        bazel-bin/fx_compiler/fx_compile /tmp/smoke_host
"""

import base64
import os
import socket
import ssl
import struct
import subprocess
import sys
import time

host_bin, fxc, work = sys.argv[1:4]
os.makedirs(work, exist_ok=True)
state = os.path.join(work, "state")
subprocess.run(["rm", "-rf", state])


def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def key(f, w):
    return varint((f << 3) | w)


def ld(f, data):
    return key(f, 2) + varint(len(data)) + data


def vi(f, v):
    return key(f, 0) + varint(v)


open(os.path.join(work, "ramp.fx"), "w").write(
    "uniform float level : 0.0 .. 1.0 = 1.0;\n"
    "vec3 shade(Led led) { return vec3(led.pos.x * level, 0.0, 1.0 - led.pos.x); }\n"
)
fxb_path = os.path.join(work, "ramp.fxb")
subprocess.run([fxc, os.path.join(work, "ramp.fx"), fxb_path], check=True)
fxb = open(fxb_path, "rb").read()

N = 8
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind(("127.0.0.1", 0))
udp.settimeout(3)
ddp_port = udp.getsockname()[1]
WSS = 18443


def start(extra=()):
    return subprocess.Popen(
        [
            host_bin,
            "--output",
            f"ddp://127.0.0.1:{ddp_port}#{N}",
            "--fps",
            "30",
            "--serve-port",
            str(WSS),
            "--state-dir",
            state,
            "--name",
            "Smoke",
            *extra,
        ],
        stderr=open(os.path.join(work, "player.log"), "a"),
    )


def drain():
    udp.setblocking(False)
    while True:
        try:
            udp.recvfrom(2000)
        except BlockingIOError:
            break
    udp.settimeout(3)


def frame_px(timeout=3, fresh=True):
    if fresh:
        drain()
    end = time.time() + timeout
    while time.time() < end:
        p, _ = udp.recvfrom(2000)
        assert p[0] & 0xC0 == 0x40, "DDP v1"
        if p[0] & 1:  # PUSH: single-packet frame here (8 px)
            d = p[10:]
            return [tuple(d[i : i + 3]) for i in range(0, len(d), 3)]
    raise SystemExit("no DDP frame")


class WS:
    def __init__(self):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        for _ in range(50):
            try:
                raw = socket.create_connection(("127.0.0.1", WSS), timeout=5)
                break
            except OSError:
                time.sleep(0.2)
        self.s = ctx.wrap_socket(raw, server_hostname="localhost")
        k = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            (
                f"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {k}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        assert b" 101 " in buf.split(b"\r\n")[0], buf
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, payload):
        mask = os.urandom(4)
        n = len(payload)
        hdr = bytes([0x82]) + (
            bytes([0x80 | n])
            if n < 126
            else (
                bytes([0x80 | 126]) + struct.pack(">H", n)
                if n < 65536
                else bytes([0x80 | 127]) + struct.pack(">Q", n)
            )
        )
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _need(self, n):
        while len(self.buf) < n:
            self.buf += self.s.recv(65536)

    def recv(self):
        self._need(2)
        n = self.buf[1] & 0x7F
        off = 2
        if n == 126:
            self._need(4)
            n = struct.unpack(">H", self.buf[2:4])[0]
            off = 4
        elif n == 127:
            self._need(10)
            n = struct.unpack(">Q", self.buf[2:10])[0]
            off = 10
        self._need(off + n)
        data = self.buf[off : off + n]
        self.buf = self.buf[off + n :]
        return data

    def call(self, frame):
        self.send(frame)
        r = self.recv()
        v = sh = i = 0
        while True:
            b = r[i]
            v |= (b & 0x7F) << sh
            sh += 7
            i += 1
            if not b & 0x80:
                break
        return v >> 3, r


def check(cond, what):
    print(("PASS " if cond else "FAIL ") + what)
    if not cond:
        raise SystemExit(1)


p = start()
try:
    ws = WS()
    tag, r = ws.call(ld(1, b""))  # hello
    check(
        b"effects" in r and b"Smoke" in r,
        f"hello -> welcome (arm {tag}) advertises effects + the name",
    )
    print("  dark while idle:", frame_px())

    # submit_map: 8 LEDs, x = i/7 (LED 3 left unmapped: interpolated)
    leds = b"".join(
        ld(6, vi(1, i) + ld(2, struct.pack("<3d", i / 7, 0, 0))) for i in range(N) if i != 3
    )
    tag, r = ws.call(ld(13, ld(1, ld(1, b"smoke-map") + vi(5, N) + leds)))
    check(tag == 8, f"submit_map -> result_ready (arm {tag})")

    # submit_effect, sharded into upload_chunks like the app does past 4 KB
    whole = ld(21, ld(1, b"ramp") + ld(2, fxb) + vi(3, 1))
    half = len(whole) // 2
    tag, r = ws.call(ld(29, vi(1, 77) + vi(2, 0) + vi(3, 0) + ld(5, whole[:half])))
    check(tag == 18, f"upload_chunk 0 -> chunk_ack (arm {tag})")
    tag, r = ws.call(ld(29, vi(1, 77) + vi(2, 1) + vi(3, 1) + ld(5, whole[half:])))
    check(tag == 8, f"upload_chunk 1 (last) -> result_ready (arm {tag})")
    time.sleep(0.3)
    px = frame_px()
    print("  effect frame:", px)
    check(
        px[0][0] == 0 and px[7][0] == 255 and px[0][2] == 255 and px[7][2] == 0,
        "DDP carries the ramp effect",
    )
    check(abs(px[3][0] - 109) <= 3, "unmapped LED 3 interpolated between its neighbours")

    tag, r = ws.call(ld(24, b""))
    check(
        tag == 16 and b"level" in r,
        f"get_effect_uniforms -> effect_uniforms with the manifest (arm {tag})",
    )

    tag, r = ws.call(ld(23, ld(1, vi(1, 0) + ld(2, struct.pack("<f", 0.0))) + vi(4, 5)))
    check(tag == 41, f"set_uniforms(seq=5) -> control_ack (arm {tag})")
    time.sleep(0.3)
    udp.settimeout(3)
    while True:  # drain stale frames
        udp.setblocking(False)
        try:
            udp.recvfrom(2000)
        except BlockingIOError:
            break
    udp.settimeout(3)
    px = frame_px()
    check(all(c[0] == 0 for c in px), "level=0 zeroes the red ramp live")
finally:
    p.terminate()
    p.wait()

# Restart: the map + effect come back from the state dir with no client.
p = start()
try:
    time.sleep(1.0)
    px = frame_px()
    check(px[7] == (255, 0, 0), f"after restart the persisted effect renders again: {px[7]}")
finally:
    p.terminate()
    p.wait()

# Bring-up mapping pattern (--start): frame 0 is the all-white sync frame.
subprocess.run(["rm", "-rf", state])
p = start(["--start", str(N)])
try:
    seen = [frame_px(fresh=False) for _ in range(40)]
    check(
        any(all(c == (255, 255, 255) for c in f) for f in seen),
        "mapping pattern drives DDP (white sync frame seen)",
    )
    check(len({tuple(f) for f in seen}) > 2, "mapping pattern advances frame to frame")
finally:
    p.terminate()
    p.wait()
print("ALL PASS")
