#!/usr/bin/env python3
"""Pure-stdlib rig-side wss video LATENCY probe. Runs INSIDE the reservation container
(network-local to the DUT, like wss_stream.py) and streams paced SetTexture frames for
minutes, timing every frame end to end:

  * each frame is followed by a TimeSyncPing whose t0 is the host time the frame was
    queued. The player handles messages strictly in order on one task, and the ping's
    device timestamp (t1 = millis() when the ping is dispatched) is taken right after
    set_texture finished applying the frame (including any wait for the render task's
    player_mutex), so t1 is the device-side frame-applied time. The frame shows at the
    next render after that (<= one render period later).
  * idle ping bursts before and after the stream estimate the device clock offset +
    drift (min-RTT, NTP style), so t1 maps onto the host clock.
  * every frame also samples the sender's kernel TCP state (TCP_INFO + SIOCOUTQ):
    retransmits, lost/unacked segments, RTT, cwnd, the time spent receive-window-limited,
    and the unsent backlog. That is what attributes a stall to TCP loss, to a full device
    window (the device not draining), or to sender backlog.

It prints raw rows (parsed + judged on the harness host by video_latency_core):

  CAL <phase> <t0_ms> <t1_dev_ms> <t3_ms>
  F <seq> <t_sched_ms> <t_enq_ms> <app_q_bytes> <kern_q_bytes> <bytes> <skipped_before>
  P <t0_ms> <t1_dev_ms> <t3_ms>
  T <t_ms> <total_retrans> <lost> <unacked> <rtt_us> <rttvar_us> <cwnd> <rwnd_limited_us>
    <snd_wnd> <bytes_retrans> <rto_us>
  TB <epoch_dev_ms> <host_to_dev_offset_ms> <present_delay_ms>   (--present-delay-ms only)
  A <seq> <t3_ms> <shown_seq> <shown_late_ms> <shown_at_effect_ms> <dropped> <queued>
  E <t_ms> <text>
  END <reason>

Sender modes: `fifo` queues every frame (what the web app does today: fire-and-forget
ws.send with no bufferedAmount check), `latest` mirrors web/src/net/videoSender.ts: at most
--max-inflight frames unconfirmed (a frame counts until its trailing ping's pong is back),
newer frames skipped (drop-stale) while the bound is hit, so the probe can A/B the policy.

Frames are raw RGB565 (flags=0, worst-case wire size) whose columns encode the frame
sequence number in binary (2 columns per bit), so a logic-analyzer capture of the LED
strip can read back which frame is on the wire.

Usage: wss_video_latency.py --host IP --port 443 --width 24 --height 24 --fps 30 --seconds 120
"""
import argparse
import base64
import fcntl
import os
import select
import socket
import ssl
import struct
import sys
import time

TIOCOUTQ = 0x5411


def now_ms():
    return time.time() * 1000.0


# --- protobuf wire helpers ---------------------------------------------------
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


def f_double(field, v):
    return _tag(field, 1) + struct.pack("<d", v)


def client_hello():
    return f_bytes(1, f_bytes(1, b"wss_video_latency") + f_bytes(2, b"1"))


def client_ping(t0):
    return f_bytes(2, f_double(1, t0))  # ClientMessage.time_sync_ping = 2


def client_set_texture(idx, w, h, data, seq=0, present_at=0):
    inner = (
        f_varint(1, idx)
        + f_varint(2, 1)  # RGB565
        + f_varint(3, w)
        + f_varint(4, h)
        + f_varint(5, 0)  # raw keyframe (no DELTA/RLE)
        + f_bytes(6, data)
    )
    if seq:
        inner += f_varint(8, seq)  # texture_ack: device answers TextureAck{seq}
    if present_at:
        inner += f_varint(9, present_at)  # show at this effect time (ms)
    return f_bytes(28, inner)  # ClientMessage.set_texture = 28


def client_set_time_base(epoch_ms):
    return f_bytes(38, f_varint(1, epoch_ms))  # ClientMessage.set_time_base = 38


def _read_varint(b, i):
    v = 0
    shift = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7F) << shift
        if not c & 0x80:
            return v, i
        shift += 7


def parse_fields(b):
    """{field: value} for one protobuf message (last wins; nested left as bytes)."""
    out = {}
    i = 0
    while i < len(b):
        key, i = _read_varint(b, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _read_varint(b, i)
        elif wt == 1:
            v = struct.unpack_from("<d", b, i)[0]
            i += 8
        elif wt == 2:
            ln, i = _read_varint(b, i)
            v = bytes(b[i : i + ln])
            i += ln
        elif wt == 5:
            v = struct.unpack_from("<f", b, i)[0]
            i += 4
        else:
            raise ValueError("wire type %d" % wt)
        out[fn] = v
    return out


# --- RFC6455 -----------------------------------------------------------------
def ws_frame(payload):
    hdr = bytearray([0x82])
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
    m = (mask * (n // 4 + 1))[:n]
    masked = (
        (int.from_bytes(payload, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big") if n else b""
    )
    return bytes(hdr) + masked


class WsReader:
    """Incremental server-frame parser over a byte buffer."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        self.buf += data
        out = []
        while True:
            b = self.buf
            if len(b) < 2:
                break
            ln = b[1] & 0x7F
            off = 2
            if ln == 126:
                if len(b) < 4:
                    break
                ln = struct.unpack_from(">H", b, 2)[0]
                off = 4
            elif ln == 127:
                if len(b) < 10:
                    break
                ln = struct.unpack_from(">Q", b, 2)[0]
                off = 10
            masked = b[1] & 0x80
            if masked:
                off += 4
            if len(b) < off + ln:
                break
            payload = bytes(b[off : off + ln])
            if masked:
                mk = b[off - 4 : off]
                payload = bytes(x ^ mk[i & 3] for i, x in enumerate(payload))
            out.append((b[0] & 0x0F, payload))
            del self.buf[: off + ln]
        return out


def tcp_info(sock):
    raw = sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 256)
    raw = raw + bytes(max(0, 232 - len(raw)))
    u32 = lambda o: struct.unpack_from("<I", raw, o)[0]  # noqa: E731
    u64 = lambda o: struct.unpack_from("<Q", raw, o)[0]  # noqa: E731
    return {
        "rto": u32(8),
        "unacked": u32(24),
        "lost": u32(32),
        "rtt": u32(68),
        "rttvar": u32(72),
        "cwnd": u32(80),
        "total_retrans": u32(100),
        "rwnd_limited": u64(176),
        "bytes_retrans": u64(208),
        "snd_wnd": u32(228),
    }


def tcp_row(t, ti):
    return "T %.3f %d %d %d %d %d %d %d %d %d %d" % (
        t,
        ti["total_retrans"],
        ti["lost"],
        ti["unacked"],
        ti["rtt"],
        ti["rttvar"],
        ti["cwnd"],
        ti["rwnd_limited"],
        ti["snd_wnd"],
        ti["bytes_retrans"],
        ti["rto"],
    )


def outq(sock):
    try:
        return struct.unpack("i", fcntl.ioctl(sock.fileno(), TIOCOUTQ, b"\0\0\0\0"))[0]
    except OSError:
        return -1


def frame_pixels(seq, w, h):
    """RGB565 raw texture: column c is white iff bit (c // 2) of seq is set."""
    row = bytearray()
    for c in range(w):
        on = (seq >> (c // 2)) & 1
        row += b"\xff\xff" if on else b"\x00\x00"
    return bytes(row) * h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=443)
    ap.add_argument("--tex-index", type=int, default=0)
    ap.add_argument("--width", type=int, default=24)
    ap.add_argument("--height", type=int, default=24)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--seconds", type=float, default=120.0)
    ap.add_argument("--mode", choices=["fifo", "latest"], default="fifo")
    ap.add_argument("--max-inflight", type=int, default=2, help="latest mode: unconfirmed frames")
    ap.add_argument(
        "--noise-pps",
        type=float,
        default=0.0,
        help="stress: also send this many 200-byte UDP datagrams/s to the DUT (discard port 9) "
        "during the stream — extra frames the device must pull through its 16-slot RX ring, "
        "a stand-in for a busy channel",
    )
    ap.add_argument(
        "--present-delay-ms",
        type=float,
        default=0.0,
        help="> 0 (firmware feature texture_ack): set a time base and stamp every frame with "
        "present_at = capture time + this, on the device clock; the device's TextureAck rows "
        "(A ...) then report when each frame was actually SHOWN",
    )
    ap.add_argument("--calib", type=int, default=40, help="idle pings before + after")
    ap.add_argument("--drain", type=float, default=8.0, help="seconds to wait for late pongs")
    a = ap.parse_args()
    out = sys.stdout

    def emit(line):
        out.write(line + "\n")

    def emit_tcp(t, ti):
        emit(tcp_row(t, ti))

    raw = socket.create_connection((a.host, a.port), timeout=10)
    raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    s = ctx.wrap_socket(raw, server_hostname=a.host)
    s.settimeout(10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall(
        (
            "GET /ws HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (a.host, key)
        ).encode()
    )
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = s.recv(1)
        if not c:
            emit("END upgrade-closed")
            return 3
        resp += c
    if b" 101" not in resp.split(b"\r\n", 1)[0]:
        emit("END upgrade-failed")
        return 3
    rd = WsReader()

    def recv_msgs(timeout):
        """Block up to `timeout` s for at least one server message (blocking socket)."""
        s.settimeout(timeout)
        try:
            data = s.recv(65536)
        except (socket.timeout, ssl.SSLWantReadError):
            return []
        if not data:
            raise ConnectionError("closed")
        return rd.feed(data)

    s.sendall(ws_frame(client_hello()))
    deadline = time.monotonic() + 10
    welcomed = False
    while not welcomed and time.monotonic() < deadline:
        for op, p in recv_msgs(1.0):
            if op == 2 and parse_fields(p).get(1) is not None:
                welcomed = True
    if not welcomed:
        emit("END no-welcome")
        return 3

    cal_rows = []

    def calibrate(phase):
        for _ in range(a.calib):
            t0 = now_ms()
            s.sendall(ws_frame(client_ping(t0)))
            end = time.monotonic() + 2.0
            got = False
            while not got and time.monotonic() < end:
                for op, p in recv_msgs(0.5):
                    t3 = now_ms()
                    pong = parse_fields(p).get(2) if op == 2 else None
                    if pong is not None:
                        f = parse_fields(pong)
                        if abs(f.get(1, -1) - t0) < 1e-6:
                            emit("CAL %s %.3f %.3f %.3f" % (phase, t0, f.get(2, 0.0), t3))
                            cal_rows.append((t0, f.get(2, 0.0), t3))
                            got = True
            time.sleep(0.02)

    calibrate("pre")
    out.flush()
    epoch = 0
    off = 0.0
    if a.present_delay_ms > 0:
        # Map host time -> device ms with the best (min-RTT) pre-calibration ping, then
        # pin the device's effect time base at "now" so present_at = host time + off - epoch.
        best = min(cal_rows, key=lambda r: r[2] - r[0])
        off = best[1] - (best[0] + best[2]) / 2.0
        epoch = int(now_ms() + off)
        s.sendall(ws_frame(client_set_time_base(epoch)))
        emit("TB %d %.3f %.1f" % (epoch, off, a.present_delay_ms))

    # --- streaming phase (non-blocking, single thread) -------------------------
    s.setblocking(False)
    period = 1000.0 / a.fps
    n_frames = int(a.seconds * a.fps)
    t_start = now_ms() + 50.0
    app_q = bytearray()
    seq = 0
    skipped = 0
    reason = "done"
    pending_pongs = 0
    # latest mode (VideoSender): the frames counted against --max-inflight, by ping t0.
    # A pong not back within max(100 ms, 3x the median RTT) frees its slot anyway (the
    # frame itself rides TCP; only the reply is late), like the web sender.
    inflight = {}
    rtts = []

    def pump_rx():
        nonlocal pending_pongs
        while True:
            try:
                data = s.recv(65536)
            except (ssl.SSLWantReadError, BlockingIOError):
                return
            except ssl.SSLWantWriteError:
                return
            if not data:
                raise ConnectionError("closed by device")
            t3 = now_ms()
            for op, p in rd.feed(data):
                if op == 8:
                    raise ConnectionError("ws close")
                if op != 2:
                    continue
                m = parse_fields(p)
                if 2 in m:
                    f = parse_fields(m[2])
                    emit("P %.3f %.3f %.3f" % (f.get(1, 0.0), f.get(2, 0.0), t3))
                    pending_pongs -= 1
                    t0 = f.get(1, 0.0)
                    if inflight.pop(t0, None) is not None:
                        rtts.append(t3 - t0)
                        del rtts[:-90]
                elif 42 in m:
                    f = parse_fields(m[42])
                    shown_late = f.get(3, 0)
                    if shown_late >= 1 << 63:
                        shown_late -= 1 << 64  # int32 negative, varint-encoded as 64-bit
                    emit(
                        "A %d %.3f %d %d %d %d %d"
                        % (
                            f.get(1, 0),
                            t3,
                            f.get(2, 0),
                            shown_late,
                            f.get(6, 0),
                            f.get(4, 0),
                            f.get(5, 0),
                        )
                    )
                elif 9 in m:
                    emit("E %.3f device-error %r" % (t3, m[9][:80]))

    def pump_tx():
        while app_q:
            try:
                n = s.send(app_q[:16384])
            except (ssl.SSLWantWriteError, ssl.SSLWantReadError, BlockingIOError):
                return
            if n <= 0:
                return
            del app_q[:n]

    noise = None
    noise_next = 0.0
    if a.noise_pps > 0:
        noise = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        noise.setblocking(False)
        noise_next = t_start
    noise_sent = 0
    held = None  # latest mode: (seq, t_sched) of the newest frame waiting for a slot

    def send_frame(fseq, t_sched):
        nonlocal pending_pongs, skipped
        t = now_ms()
        px = frame_pixels(fseq, a.width, a.height)
        present_at = 0
        if a.present_delay_ms > 0:
            present_at = max(1, int(t_sched + a.present_delay_ms + off - epoch))
        msg = ws_frame(
            client_set_texture(
                a.tex_index,
                a.width,
                a.height,
                px,
                seq=fseq + 1 if a.present_delay_ms > 0 else 0,
                present_at=present_at,
            )
        )
        msg += ws_frame(client_ping(t))
        app_q.extend(msg)
        pending_pongs += 1
        inflight[t] = True
        pump_tx()
        emit(
            "F %d %.3f %.3f %d %d %d %d"
            % (fseq, t_sched, t, len(app_q), outq(s), len(msg), skipped)
        )
        skipped = 0
        emit_tcp(t, tcp_info(s))

    try:
        while (
            seq < n_frames
            or held is not None
            or (pending_pongs > 0 and now_ms() < t_start + n_frames * period + a.drain * 1000)
        ):
            t_next = t_start + seq * period if seq < n_frames else now_ms() + 50
            wait = max(0.0, (t_next - now_ms()) / 1000.0)
            tick = 0.002 if held or noise is not None or inflight else 0.05
            rl, wl, _ = select.select([s], [s] if app_q else [], [], min(wait, tick))
            if noise is not None and seq < n_frames:
                tn = now_ms()
                while noise_next <= tn:
                    try:
                        noise.sendto(b"\0" * 200, (a.host, 9))
                        noise_sent += 1
                    except OSError:
                        pass
                    noise_next += 1000.0 / a.noise_pps
            if s.pending() or rl:
                pump_rx()
            if app_q:
                pump_tx()
            if inflight:
                srt = sorted(rtts)
                limit = max(100.0, 3 * srt[len(srt) // 2]) if srt else 100.0
                tn = now_ms()
                for t0 in [k for k in inflight if tn - k > min(limit, 1000.0)]:
                    del inflight[t0]
            if held is not None and len(inflight) < a.max_inflight:
                # A slot freed: the newest held frame goes out now (VideoSender.pump).
                send_frame(*held)
                held = None
            if seq >= n_frames:
                continue
            if now_ms() < t_next:
                continue
            if a.mode == "latest" and len(inflight) >= a.max_inflight:
                # Bounded in flight (VideoSender): hold only the newest frame; the one it
                # replaces is dropped (stale) without ever being sent.
                if held is not None:
                    skipped += 1
                held = (seq, t_next)
                seq += 1
                continue
            send_frame(seq, t_next)
            seq += 1
    except (OSError, ConnectionError) as e:
        reason = "error:%s:%s" % (type(e).__name__, str(e).replace(" ", "_")[:60])
    if reason == "done":
        try:
            s.setblocking(True)
            calibrate("post")
        except (OSError, ConnectionError) as e:
            reason = "post-calib-error:%s" % type(e).__name__
    ti = None
    try:
        ti = tcp_info(s)
    except OSError:
        pass
    if ti:
        emit_tcp(now_ms(), ti)
    if noise is not None:
        emit("E %.3f noise-datagrams-sent %d" % (now_ms(), noise_sent))
    emit("END %s" % reason)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
