"""OSC 1.0 over UDP to a Splanc fixture (§3), stdlib only.

`OscStreamer` keeps the latest value per address and sends from its own thread:
  - a changed value goes out at most MAX_HZ times a second (latest value wins),
  - every value is re-sent at KEEPALIVE_HZ while idle (UDP drops; the fixture
    doesn't persist values, so a reboot resets them to the effect's defaults).
Transports: `UdpTransport` (a configured fixture address, never discovered),
`LogTransport` (dry run: decodes and logs each datagram, sends nothing) and
`CallbackTransport` (hands datagrams to a function, e.g. the synthetic fixture).
"""

import socket
import struct
import sys
import threading
import time

MAX_HZ = 120.0
KEEPALIVE_HZ = 5.0
OSC_PORT = 9000


def _pad(b):
    return b + b"\0" * (4 - len(b) % 4)


def message(addr, *floats):
    """One OSC message with float32 arguments (type tag ,f...)."""
    return (
        _pad(addr.encode())
        + _pad(("," + "f" * len(floats)).encode())
        + b"".join(struct.pack(">f", float(f)) for f in floats)
    )


def message_typed(addr, *args):
    """One OSC message with int32 (Python int) and float32 arguments, e.g. the P4
    tracker module's /lh/station ,iffffff f (station id, then its pose)."""
    tags = "," + "".join(
        "i" if isinstance(a, int) and not isinstance(a, bool) else "f" for a in args
    )
    body = b"".join(
        struct.pack(
            ">i" if t == "i" else ">f", (a if a < 2**31 else a - 2**32) if t == "i" else float(a)
        )
        for t, a in zip(tags[1:], args)
    )
    return _pad(addr.encode()) + _pad(tags.encode()) + body


def bundle(*messages):
    """#bundle with an 'immediately' time tag."""
    out = _pad(b"#bundle") + struct.pack(">Q", 1)
    for m in messages:
        out += struct.pack(">i", len(m)) + m
    return out


def _read_str(b, i):
    j = b.index(b"\0", i)
    s = b[i:j].decode()
    return s, (j // 4 + 1) * 4


def decode(b):
    """Datagram -> list of (address, [args]). Handles bundles and f/i/s args."""
    if b.startswith(b"#bundle\0"):
        out, i = [], 16
        while i < len(b):
            (n,) = struct.unpack(">i", b[i : i + 4])
            out += decode(b[i + 4 : i + 4 + n])
            i += 4 + n
        return out
    addr, i = _read_str(b, 0)
    tags, i = _read_str(b, i)
    args = []
    for t in tags[1:]:
        if t == "f":
            args.append(struct.unpack(">f", b[i : i + 4])[0])
            i += 4
        elif t == "i":
            args.append(struct.unpack(">i", b[i : i + 4])[0])
            i += 4
        elif t == "s":
            s, i = _read_str(b, i)
            args.append(s)
        else:
            raise ValueError("unsupported OSC type tag %r" % t)
    return [(addr, args)]


class UdpTransport:
    def __init__(self, host, port=OSC_PORT):
        self.addr = (host, int(port))
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))  # a fixed source port: the fixture answers to it
        self.warned = False
        self.received = 0

    def on_receive(self, callback):
        """Datagrams the fixture sends back (a Splanc P4 player's /lh/pose ...) go to
        callback(bytes), on a thread of their own."""

        def run():
            while True:
                try:
                    data, _ = self.sock.recvfrom(4096)
                except OSError:
                    return
                self.received += 1
                callback(data)

        threading.Thread(target=run, daemon=True, name="osc-in").start()

    def send(self, data):
        try:
            self.sock.sendto(data, self.addr)
        except OSError as e:
            # Network hiccup; the keep-alive retries. Say so once: on macOS a
            # persistent EHOSTUNREACH means Local Network access is denied to the
            # app that launched Python (System Settings > Privacy & Security).
            if not self.warned:
                self.warned = True
                print("osc: send to %s:%d failed: %s" % (self.addr + (e,)), file=sys.stderr)

    def close(self):
        self.sock.close()

    def describe(self):
        return "udp://%s:%d" % self.addr


class LogTransport:
    """Dry run: nothing leaves the machine. Logs each datagram (decoded) to a file or
    a function; keeps the last few for the UI."""

    def __init__(self, path=None, printer=None, keep=50):
        self.f = open(path, "a") if path else None
        self.printer = printer
        self.recent = []
        self.keep = keep
        self.lock = threading.Lock()

    def send(self, data):
        line = "%.3f %s" % (
            time.time(),
            " | ".join(
                "%s %s"
                % (a, " ".join("%.5g" % x if isinstance(x, float) else str(x) for x in args))
                for a, args in decode(data)
            ),
        )
        with self.lock:
            self.recent = (self.recent + [line])[-self.keep :]
            if self.f:
                self.f.write(line + "\n")
                self.f.flush()
        if self.printer:
            self.printer(line)

    def describe(self):
        return "dry-run (log%s)" % (": " + self.f.name if self.f else "")


class CallbackTransport:
    def __init__(self, fn, name="callback"):
        self.fn, self.name = fn, name

    def send(self, data):
        self.fn(data)

    def describe(self):
        return self.name


class Tee:
    def __init__(self, *transports):
        self.transports = [t for t in transports if t is not None]

    def send(self, data):
        for t in self.transports:
            t.send(data)

    def describe(self):
        return " + ".join(t.describe() for t in self.transports)


class OscStreamer:
    """Latest-value-wins sender with a rate cap and keep-alive. Each address is re-sent
    every `keepalive` seconds (default 1/keepalive_hz) and on change; due ones share a bundle."""

    def __init__(self, transport, max_hz=MAX_HZ, keepalive_hz=KEEPALIVE_HZ, clock=time.monotonic):
        assert max_hz <= 120.0 + 1e-9 and keepalive_hz >= 5.0 - 1e-9
        self.transport = transport
        self.min_dt = 1.0 / max_hz
        self.keep_dt = 1.0 / keepalive_hz
        self.clock = clock
        self.values = {}  # addr -> tuple of floats
        self.dirty = set()
        self.keep = {}  # addr -> its keep-alive period (s), if not the default
        self.last_kept = {}  # addr -> when it last went out
        self.last_send = -1e9
        self.cond = threading.Condition()
        self.sent = 0
        self.thread = None
        self.running = False

    def set(self, addr, *floats, keepalive=None):
        """`keepalive`: re-send period for this address (s), e.g. 1 s for settings that
        rarely change; default the streamer's."""
        v = tuple(float(f) for f in floats)
        with self.cond:
            if keepalive is not None:
                self.keep[addr] = float(keepalive)
            if self.values.get(addr) != v:
                self.values[addr] = v
                self.dirty.add(addr)
                self.cond.notify()

    def resend(self):
        """Send every address again now, e.g. to a freshly deployed effect."""
        with self.cond:
            self.dirty.update(self.values)
            self.cond.notify()

    def clear(self, *addrs):
        """Stop sending (and keeping alive) these addresses, e.g. /pick after calibration."""
        with self.cond:
            for a in addrs:
                self.values.pop(a, None)
                self.dirty.discard(a)
                self.last_kept.pop(a, None)

    def step(self, now=None):
        """Send whatever is due at `now`. Returns the number of datagrams sent. Used by
        the thread, and directly by tests with a fake clock."""
        now = self.clock() if now is None else now
        with self.cond:
            if now - self.last_send < self.min_dt:
                return 0
            addrs = [a for a in self.values if a in self.dirty or now >= self._due(a)]
            if addrs:
                # Slow keep-alives ride along with this datagram rather than sending
                # their own a little later.
                addrs += [
                    a for a in self.values if a not in addrs and now >= self._due(a) - self.keep_dt
                ]
            for a in addrs:
                self.last_kept[a] = now
            self.dirty.clear()
            msgs = [message(a, *self.values[a]) for a in addrs]
            if msgs:
                self.last_send = now
        if not msgs:
            return 0
        self.transport.send(msgs[0] if len(msgs) == 1 else bundle(*msgs))
        self.sent += 1
        return 1

    def _run(self):
        while self.running:
            self.step()
            with self.cond:
                now = self.clock()
                if self.dirty:
                    timeout = self.min_dt - (now - self.last_send)
                else:
                    timeout = (
                        min((self._due(a) for a in self.values), default=now + self.keep_dt) - now
                    )
                self.cond.wait(timeout=max(timeout, 0.001))

    def _due(self, addr):
        return self.last_kept.get(addr, -1e9) + self.keep.get(addr, self.keep_dt)

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True, name="osc")
        self.thread.start()
        return self

    def stop(self):
        self.running = False
        with self.cond:
            self.cond.notify()
