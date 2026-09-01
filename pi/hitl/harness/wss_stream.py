#!/usr/bin/env python3
"""Pure-stdlib rig-side wss video-stream load generator. Runs INSIDE the reservation
container (network-local to the device) so the high-rate TLS flood never crosses the
this-container<->rig tunnel (which stalls a proxied TLS stream). Speaks just enough of the
LED Mapper §7 wire protocol — hand-encoded protobuf over hand-rolled RFC6455 over ssl — to
flood raw (uncompressed, flags=0) SetTexture frames and barrier on get_effect_uniforms, then
prints a RESULT line the harness parses. The effect + its WxH texture are set up beforehand by
the harness over the (low-rate, working) control connection; this only streams into it.

Usage: wss_stream.py <dev_ip> <port> <tex_index> <width> <height> <format> <seconds> <sync_every> <min_fps>
  format: 1 = RGB565 (2 B/px)
"""
import os
import socket
import ssl
import struct
import sys
import time

dev_ip, port = sys.argv[1], int(sys.argv[2])
tex_index, width, height = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
fmt, seconds, sync_every, min_fps = (
    int(sys.argv[6]),
    float(sys.argv[7]),
    int(sys.argv[8]),
    float(sys.argv[9]),
)


# --- protobuf wire helpers (varint + length-delimited only) -----------------
def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _tag(field, wt):
    return _varint((field << 3) | wt)


def f_varint(field, val):
    return _tag(field, 0) + _varint(val)


def f_bytes(field, data):
    return _tag(field, 2) + _varint(len(data)) + data


def f_str(field, s):
    return f_bytes(field, s.encode())


def client_hello(client, app):
    inner = f_str(1, client) + f_str(2, app)
    return f_bytes(1, inner)  # ClientMessage.hello = 1


def client_get_uniforms():
    return f_bytes(24, b"")  # ClientMessage.get_effect_uniforms = 24 (empty msg)


def client_set_texture(idx, fmt, w, h, data):
    inner = (
        f_varint(1, idx)
        + f_varint(2, fmt)
        + f_varint(3, w)
        + f_varint(4, h)
        + f_varint(5, 0)  # flags: 0 = raw (no DELTA, no RLE)
        + f_bytes(6, data)
    )
    return f_bytes(28, inner)  # ClientMessage.set_texture = 28


# --- RFC6455 (client side: mask frames; parse unmasked server frames) -------
def ws_send(sock, payload):
    hdr = bytearray([0x82])  # FIN + binary
    n = len(payload)
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126)
        hdr += struct.pack(">H", n)
    else:
        hdr.append(0x80 | 127)
        hdr += struct.pack(">Q", n)
    mask = os.urandom(4)
    hdr += mask
    masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    sock.sendall(bytes(hdr) + masked)


def _recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        d = sock.recv(n - len(buf))
        if not d:
            raise ConnectionError("closed")
        buf += d
    return bytes(buf)


def ws_recv(sock):
    b0, b1 = _recv_exact(sock, 2)
    ln = b1 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    if b1 & 0x80:  # server shouldn't mask, but handle it
        mask = _recv_exact(sock, 4)
        data = _recv_exact(sock, ln)
        return bytes(x ^ mask[i & 3] for i, x in enumerate(data))
    return _recv_exact(sock, ln)


def is_msg(payload, field):
    return payload[: len(_tag(field, 2))] == _tag(field, 2)


def read_until(sock, field, budget=16):
    for _ in range(budget):
        p = ws_recv(sock)
        if is_msg(p, field):
            return True
        if is_msg(p, 9):  # ServerMessage.error = 9 -> a device error ends the barrier
            return True
    return False


def main():
    raw = socket.create_connection((dev_ip, port), timeout=8)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    s = ctx.wrap_socket(raw, server_hostname=dev_ip)
    s.settimeout(10)
    key = os.urandom(16)
    import base64

    req = (
        "GET /ws HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
        % (dev_ip, base64.b64encode(key).decode())
    )
    s.sendall(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += s.recv(1)
    if b"101" not in resp.split(b"\r\n", 1)[0]:
        print("RESULT verdict=ERROR ws-upgrade-failed", flush=True)
        return 3

    ws_send(s, client_hello("wss_stream", "1"))
    if not read_until(s, 1):  # welcome
        print("RESULT verdict=ERROR no-welcome", flush=True)
        return 3

    bpp = 2 if fmt == 1 else 3
    npix = width * height
    base = bytearray(npix * bpp)
    applied = 0
    t0 = time.monotonic()
    frame = 0
    try:
        while time.monotonic() - t0 < seconds:
            for _ in range(max(1, sync_every)):
                # scrolling-ish pattern: rotate a byte so the texture actually changes
                shift = frame % max(1, npix)
                for p in range(npix):
                    v = (p + shift) & 0xFF
                    base[p * bpp] = v
                    if bpp > 1:
                        base[p * bpp + 1] = (v * 5) & 0xFF
                ws_send(s, client_set_texture(tex_index, fmt, width, height, bytes(base)))
                frame += 1
            # barrier: force the device to apply the batch before replying
            ws_send(s, client_get_uniforms())
            if not read_until(s, 16):  # effect_uniforms
                print(f"RESULT verdict=FAIL no-barrier-reply applied={applied}", flush=True)
                return 3
            applied += max(1, sync_every)
    except (OSError, ConnectionError) as e:
        print(f"RESULT verdict=ERROR {type(e).__name__}:{e} applied={applied}", flush=True)
        return 3
    elapsed = time.monotonic() - t0
    fps = applied / elapsed if elapsed > 0 else 0.0
    verdict = "PASS" if fps >= min_fps else "FAIL"
    print(
        f"RESULT verdict={verdict} fps={fps:.1f} applied={applied} elapsed={elapsed:.2f} "
        f"min={min_fps} tex={width}x{height}",
        flush=True,
    )
    return 0 if verdict == "PASS" else 1


sys.exit(main())
