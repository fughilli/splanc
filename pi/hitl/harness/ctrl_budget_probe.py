#!/usr/bin/env python3
"""Pure-stdlib rig-side live-control latency probe (docs/design/live-control.md
"Measuring the budget"). Runs INSIDE the reservation container, network-local to the
DUT over the rig AP, so the numbers are the LAN's, not the tailnet tunnel's.

The DUT runs the LM_CTRL_TRACE measurement image
(//firmware/player_app:esp32c6_netstack_ctrltrace_flashbundle), which stamps every stage
of every control message and every effect frame. This probe drives a knob stream, then
pages the device's trace out over the same WS, and prints raw rows for the harness host
(ctrl_budget_core parses and attributes them):

  META <json>                      run parameters
  W <k> <t_us>                     window k starts (host monotonic µs)
  S <idx> <t_us> <kind> <seq> <counter>
                                   WS message idx (1-based since the window's trace reset)
                                   left the probe: kind u=set_uniforms p=time_sync_ping
  G <counter> <t_us>               the counter knob moved to <counter> (the INTENDED time)
  O <counter> <t_us>               an OSC /probe datagram carrying <counter> was sent
  R <t_us> <kind> <key>            a reply arrived: a=control_ack(seq) p=pong(idx)
  D <k> <t_us> <base64>            window k's trace dump (t_us: when its first page arrived)
  E <t_us> <text>                  event / note
  END <reason>

Transports: ``wss`` (the app's live channel: latest value per knob, --inflight batches
unacknowledged, never faster than --min-interval-ms; set_uniforms carries a seq and is
answered with a ControlAck) or ``osc`` (/probe ,f + /k1..k3 datagrams to udp/9000 with
no reply; the WS stays open only for clock-sync pings). --noise-pps adds 200-byte UDP
datagrams to a closed port (RX-ring and airtime load, like a busy channel).

Usage: ctrl_budget_probe.py --host IP --transport wss --windows 4 --window-s 8
"""
import argparse
import base64
import json
import os
import select
import socket
import ssl
import struct
import sys
import time


def now_us():
    return time.monotonic_ns() // 1000


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


def f_packed_floats(field, vals):
    return f_bytes(field, b"".join(struct.pack("<f", v) for v in vals))


def client_hello():
    return f_bytes(1, f_bytes(1, b"ctrl_budget_probe") + f_bytes(2, b"1"))


def client_ping(t0):
    return f_bytes(2, f_double(1, t0))  # ClientMessage.time_sync_ping = 2


def client_set_uniforms(values, seq, commit=False):
    """ClientMessage.set_uniforms = 23: SetUniforms{values=1 (UniformValue{slot=1,
    value=2 packed float}), commit=2 (optional: false = live only), seq=4}."""
    inner = b""
    for slot, vec in values:
        inner += f_bytes(1, (f_varint(1, slot) if slot else b"") + f_packed_floats(2, vec))
    inner += f_varint(2, 1 if commit else 0)
    if seq:
        inner += f_varint(4, seq)
    return f_bytes(23, inner)


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


def parse_all(b):
    """[(field, value), ...] for one protobuf message, repeated fields kept."""
    out = []
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
        out.append((fn, v))
    return out


def client_get_effect_uniforms():
    return f_bytes(24, b"")  # ClientMessage.get_effect_uniforms = 24 (active effect)


def effect_uniform_slot0(eu):
    """EffectUniforms.current (3) -> slot 0's first value (None if absent)."""
    for fn, v in parse_all(eu):
        if fn != 3:
            continue
        uv = parse_fields(v)
        if uv.get(1, 0) == 0 and isinstance(uv.get(2), bytes) and len(uv[2]) >= 4:
            return struct.unpack_from("<f", uv[2], 0)[0]
    return None


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
def ws_frame(payload, opcode=2):
    hdr = bytearray([0x80 | opcode])
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
            if len(b) < off + ln:
                break
            out.append((b[0] & 0x0F, bytes(b[off : off + ln])))
            del self.buf[: off + ln]
        return out


OSC_PROBE_HEAD = b"/probe\0\0,f\0\0"


def osc_msg(addr, v):
    a = addr.encode() + b"\0"
    a += b"\0" * (-len(a) % 4)
    return a + b",f\0\0" + struct.pack(">f", float(v))


class Probe:
    def __init__(self, a, out):
        self.a = a
        self.out = out
        self.rd = WsReader()
        self.s = None
        self.idx = 0  # WS messages sent since the window's trace reset
        self.ping_idx = {}  # ping t0 -> idx
        self.features = []
        self.probe_q = None  # gate mode: the outstanding get_effect_uniforms (sent at)

    def emit(self, line):
        self.out.write(line + "\n")

    # -- connection -----------------------------------------------------------
    def connect(self):
        a = self.a
        raw = socket.create_connection((a.host, a.port), timeout=10)
        if not a.no_nodelay:
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
                raise ConnectionError("upgrade closed")
            resp += c
        if b" 101" not in resp.split(b"\r\n", 1)[0]:
            raise ConnectionError("upgrade refused")
        self.s = s
        self.send_raw(client_hello())
        w = self.wait_for(lambda op, p: op == 2 and 1 in parse_fields(p), 10.0)
        self.features = [
            v.decode(errors="replace") for fn, v in parse_all(parse_fields(w)[1]) if fn == 10
        ]
        self.emit("F " + ",".join(self.features))

    def send_raw(self, payload):
        self.s.setblocking(True)
        self.s.sendall(ws_frame(payload))

    def recv_some(self, timeout):
        """Server messages that arrive within `timeout` s (at least one read attempt)."""
        s = self.s
        if not s.pending():
            r, _, _ = select.select([s], [], [], max(0.0, timeout))
            if not r:
                return []
        s.setblocking(False)
        msgs = []
        while True:
            try:
                data = s.recv(65536)
            except (ssl.SSLWantReadError, BlockingIOError):
                break
            if not data:
                raise ConnectionError("closed by device")
            msgs += self.rd.feed(data)
            if not s.pending():
                break
        s.setblocking(True)
        return msgs

    def wait_for(self, pred, timeout, what="reply"):
        end = time.monotonic() + timeout
        seen = []
        while time.monotonic() < end:
            for op, p in self.recv_some(end - time.monotonic()):
                if op == 8:
                    raise ConnectionError("ws close")
                if pred(op, p):
                    return p
                if len(seen) < 6:
                    seen.append("%d:%s" % (op, p[:6].hex()))
        # what did come back meanwhile (late acks? nothing at all?) -> the E row
        self.emit("E %d wait-timeout %s seen=%s" % (now_us(), what, ",".join(seen) or "-"))
        raise TimeoutError("no reply (%s)" % what)

    def tr_reset(self):
        self.send_raw(b"\xffCTRR")
        self.wait_for(lambda o, p: o == 2 and p == b"CTRok", 5.0, "trace-reset")
        self.idx = 0
        self.ping_idx = {}

    def tr_dump(self):
        self.send_raw(b"\xffCTRS")
        self.wait_for(lambda o, p: o == 2 and p == b"CTRok", 5.0, "trace-stop")
        img = bytearray()
        total = None
        t_first = None
        while total is None or len(img) < total:
            self.send_raw(b"\xffCTRD" + struct.pack("<I", len(img)))
            p = self.wait_for(
                lambda o, p: o == 2
                and len(p) >= 8
                and struct.unpack_from("<I", p, 4)[0] == len(img),
                5.0,
                "trace-page@%d" % len(img),
            )
            if t_first is None:
                t_first = now_us()  # the header's now_us was stamped just before this
            total = struct.unpack_from("<I", p, 0)[0]
            img += p[8:]
        return bytes(img), t_first

    # -- per-message bookkeeping ---------------------------------------------
    def send_msg(self, payload, kind, seq=0, counter=-1):
        self.idx += 1
        t = now_us()
        self.s.setblocking(True)
        self.s.sendall(ws_frame(payload))
        self.emit("S %d %d %s %d %d" % (self.idx, t, kind, seq, counter))
        return t

    def ping(self):
        t0 = float(now_us())
        idx = self.idx + 1
        self.ping_idx[t0] = idx
        self.send_msg(client_ping(t0), "p")

    def handle_replies(self, msgs, on_ack):
        t = now_us()
        for op, p in msgs:
            if op == 8:
                raise ConnectionError("ws close")
            if op != 2 or not p or p[0] == ord("C"):
                continue
            try:
                m = parse_fields(p)
            except (ValueError, IndexError):
                continue
            if 41 in m:
                seq = parse_fields(m[41]).get(1, 0)
                self.emit("R %d a %d" % (t, seq))
                on_ack(seq)
            elif 2 in m:
                t0 = parse_fields(m[2]).get(1, 0.0)
                self.emit("R %d p %d" % (t, self.ping_idx.pop(t0, -1)))
            elif 16 in m and self.probe_q is not None:
                v = effect_uniform_slot0(m[16])
                self.emit("P %d %d %d" % (self.probe_q, t, -1 if v is None else int(round(v))))
                self.probe_q = None
            elif 9 in m:
                self.emit("E %d device-error %r" % (t, m[9][:80]))

    # -- one measurement window ------------------------------------------------
    def window(self, k):
        a = self.a
        if not a.gate:
            self.tr_reset()
        t0 = now_us() + 20000
        # 0 = what the app does (web/src/net/liveControl.ts): one batch in flight
        max_inflight = a.inflight or 1
        next_probe = t0 + a.probe_ms * 1000 if a.probe_ms > 0 else None
        self.emit("W %d %d" % (k, t0))
        period_us = 1e6 / (a.hz * a.controls)
        n_events = int(a.window_s * a.hz * a.controls)
        pending = {}
        inflight = {}  # seq -> sent_at
        seq = 0
        last_send = -(10**12)
        counter = 0
        ev = 0
        next_ping = t0
        noise = None
        noise_next = t0
        if a.noise_pps > 0:
            noise = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            noise.setblocking(False)
        osc = None
        if a.transport == "osc":
            osc = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        min_iv = a.min_interval_ms * 1000.0
        ack_to = a.ack_timeout_ms * 1000.0
        rtts = []  # recent batch round trips (adaptive ack timeout)

        def on_ack(sq):
            ts = inflight.pop(sq, None)
            if ts is not None:
                rtts.append(now_us() - ts)
                del rtts[:-64]

        end = t0 + n_events * period_us
        while True:
            t = now_us()
            if t >= end + 300000 and not inflight:
                break
            if t >= end + 1500000:
                break
            # knob events due
            while ev < n_events and t0 + ev * period_us <= t:
                slot = ev % a.controls
                due = t0 + ev * period_us
                if slot == 0:
                    counter += 1
                    val = float(counter)
                    if osc is not None:
                        osc.sendto(OSC_PROBE_HEAD + struct.pack(">f", val), (a.host, 9000))
                        self.emit("O %d %d" % (counter, now_us()))
                    self.emit("G %d %d" % (counter, int(due)))
                else:
                    val = ((ev * 37) % 101) / 100.0
                    if osc is not None:
                        osc.sendto(osc_msg("/k%d" % slot, val), (a.host, 9000))
                if osc is None:
                    pending[slot] = (val, counter if slot == 0 else -1)
                ev += 1
            # noise
            if noise is not None and t < end:
                while noise_next <= t:
                    try:
                        noise.sendto(b"\0" * 200, (a.host, 9))
                    except OSError:
                        pass
                    noise_next += 1e6 / a.noise_pps
            # the live channel (wss)
            if osc is None:
                if a.ack_timeout_ms <= 0:
                    # adaptive: 3x the median batch round trip, 25..400 ms (a lost ack
                    # costs ~that, not the device's >= 120 ms RTO)
                    med = sorted(rtts)[len(rtts) // 2] if rtts else 100000
                    ack_to = min(400000.0, max(25000.0, 3.0 * med))
                for sq in [q for q, ts in inflight.items() if t - ts > ack_to]:
                    del inflight[sq]
                    self.emit("E %d ack-timeout %d" % (t, sq))
                if pending and len(inflight) < max_inflight and t - last_send >= min_iv:
                    seq += 1
                    vals = [(sl, [v]) for sl, (v, _c) in sorted(pending.items())]
                    ctr = pending[0][1] if 0 in pending else -1
                    pending = {}
                    last_send = self.send_msg(client_set_uniforms(vals, seq), "u", seq, ctr)
                    inflight[seq] = last_send
            elif t >= next_ping and not a.gate:
                self.ping()
                next_ping = t + a.ping_ms * 1000
            # gate mode: one get_effect_uniforms echo at a time, every --probe-ms
            if next_probe is not None:
                if self.probe_q is not None and t - self.probe_q > a.probe_timeout_s * 1e6:
                    self.emit("P %d %d -2" % (self.probe_q, t))  # timed out (backlog)
                    self.probe_q = None
                if self.probe_q is None and t >= next_probe and t < end:
                    self.probe_q = self.send_msg(client_get_effect_uniforms(), "q")
                    next_probe = t + a.probe_ms * 1000
            # wait for the next thing to do
            nxt = [end + 300000]
            if ev < n_events:
                nxt.append(t0 + ev * period_us)
            if noise is not None and t < end:
                nxt.append(noise_next)
            if osc is None and pending and len(inflight) < max_inflight:
                nxt.append(last_send + min_iv)
            if osc is None and inflight:
                nxt.append(min(inflight.values()) + ack_to)
            if osc is not None and not a.gate:
                nxt.append(next_ping)
            if next_probe is not None:
                nxt.append(next_probe if self.probe_q is None else t + 20000)
            wait = max(0.0, (min(nxt) - now_us()) / 1e6)
            self.handle_replies(self.recv_some(min(wait, 0.05)), on_ack)
        if noise is not None:
            noise.close()
        if osc is not None:
            osc.close()
        if not a.gate:
            img, t_d = self.tr_dump()
            self.emit("D %d %d %s" % (k, t_d, base64.b64encode(img).decode()))
        self.out.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=443)
    ap.add_argument("--transport", choices=["wss", "osc"], default="wss")
    ap.add_argument("--windows", type=int, default=4)
    ap.add_argument("--window-s", type=float, default=8.0)
    ap.add_argument("--controls", type=int, default=4)
    ap.add_argument("--hz", type=float, default=100.0, help="per-control move rate")
    ap.add_argument(
        "--inflight", type=int, default=1, help="wss: unacknowledged batches (0 = as the app)"
    )
    ap.add_argument("--min-interval-ms", type=float, default=40.0, help="wss: batch spacing")
    ap.add_argument(
        "--ack-timeout-ms", type=float, default=400.0, help="0 = adaptive (3x median RTT)"
    )
    ap.add_argument("--ping-ms", type=float, default=100.0, help="osc: clock-sync ping period")
    ap.add_argument("--noise-pps", type=float, default=0.0)
    ap.add_argument("--no-nodelay", action="store_true", help="leave Nagle on (browser-like?)")
    ap.add_argument("--label", default="")
    ap.add_argument(
        "--gate",
        action="store_true",
        help="shipping firmware (no LM_CTRL_TRACE): no trace commands; measure with "
        "get_effect_uniforms echoes (P rows) every --probe-ms instead",
    )
    ap.add_argument("--probe-ms", type=float, default=0.0, help="echo period (gate mode)")
    ap.add_argument("--probe-timeout-s", type=float, default=15.0)
    a = ap.parse_args()
    p = Probe(a, sys.stdout)
    p.emit("META " + json.dumps(vars(a), sort_keys=True))
    reason = "done"
    try:
        for attempt in range(4):
            try:
                p.connect()
                break
            except (OSError, ConnectionError, TimeoutError) as e:
                p.emit("E %d connect-retry %s" % (now_us(), type(e).__name__))
                if attempt == 3:
                    raise
                time.sleep(2.0)
        for k in range(a.windows):
            p.window(k)
    except (OSError, ConnectionError, TimeoutError, ValueError) as e:
        reason = "error:%s:%s" % (type(e).__name__, str(e).replace(" ", "_")[:60])
    p.emit("END %s" % reason)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
