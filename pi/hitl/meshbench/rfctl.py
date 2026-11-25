"""Host driver for the rfctl RF-switch controller (docs/design/mesh-hitl-rig.md §5).

Speaks the line protocol of rfctl/rfctl_core.c over a serial port (the RP2350's USB
CDC) or over the pipes of the host simulator (rfctl/sim/sim_main.c), which runs the
same core. Every request carries an `@tag`; the reply is the lines with that tag up
to the `ok`/`err` line.

    with Rfctl.open("/dev/serial/by-id/usb-splanc_rfctl_mesh-bench_...-if00") as rf:
        rf.set({"cut01": 1, "att0": 12.25})
        rf.load([(0, {"cut12": 0}), (2_000_000, {"cut12": 1})])
        t0 = rf.play(delay_us=500_000)
        rf.attcheck()   # every UART attenuator acknowledged its value

Attenuator kinds: `atten` / `atten_serial` (PE4302, 0.5 dB steps; the legacy
`pe4302` board table) and `atten_uart` (the Jeanoko unit per DUT, 0.25 dB steps;
the default board). Values are dB either way.

Pure Python; pyserial only for a real port.
"""

from __future__ import annotations

import dataclasses
import os
import queue
import subprocess
import threading
import time
from typing import Iterable, Mapping, Sequence

MAX_LINE = 200  # stay well under the controller's 256-byte line buffer


class RfctlError(RuntimeError):
    def __init__(self, code: str, text: str, line: str):
        super().__init__(f"rfctl {code}: {text} (sent: {line})")
        self.code = code
        self.text = text


class Transport:
    def write_line(self, line: str) -> None:
        raise NotImplementedError

    def read_line(self, timeout: float) -> str | None:
        raise NotImplementedError

    def close(self) -> None:
        pass


class _Reader:
    """Background line reader feeding a queue (both transports)."""

    def __init__(self, readline) -> None:
        self.q: "queue.Queue[str | None]" = queue.Queue()
        self._readline = readline
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        try:
            while True:
                ln = self._readline()
                if ln is None:
                    break
                self.q.put(ln)
        finally:
            self.q.put(None)

    def get(self, timeout: float) -> str | None:
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None


class SerialTransport(Transport):
    def __init__(self, port: str, baud: int = 115200) -> None:
        import serial  # pyserial

        self.ser = serial.Serial(port, baud, timeout=0.2)
        self.ser.reset_input_buffer()

        self._buf = b""
        self.reader = _Reader(self._readline)

    def _readline(self) -> str | None:
        while True:
            if b"\n" in self._buf:
                line, _, self._buf = self._buf.partition(b"\n")
                return line.decode(errors="replace").rstrip("\r")
            try:
                ch = self.ser.read(256)
            except Exception:
                return None
            if ch:
                self._buf += ch
            elif not self.ser.is_open:
                return None

    def write_line(self, line: str) -> None:
        self.ser.write((line + "\n").encode())
        self.ser.flush()

    def read_line(self, timeout: float) -> str | None:
        return self.reader.get(timeout)

    def close(self) -> None:
        self.ser.close()


class ProcessTransport(Transport):
    """The host simulator on pipes."""

    def __init__(self, argv: Sequence[str]) -> None:
        self.proc = subprocess.Popen(
            list(argv), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1
        )

        def rd():
            ln = self.proc.stdout.readline()
            return ln.rstrip("\n") if ln else None

        self.reader = _Reader(rd)

    def write_line(self, line: str) -> None:
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def read_line(self, timeout: float) -> str | None:
        return self.reader.get(timeout)

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def sim_binary() -> str:
    """Path of the built simulator: $RFCTL_SIM, else the Bazel runfile."""
    if os.environ.get("RFCTL_SIM"):
        return os.environ["RFCTL_SIM"]
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (
        os.path.join(here, "rfctl", "rfctl_sim"),
        os.path.join(os.environ.get("RUNFILES_DIR", ""), "_main/pi/hitl/meshbench/rfctl/rfctl_sim"),
    ):
        if os.path.isfile(cand):
            return cand
    raise FileNotFoundError("rfctl_sim not found (set $RFCTL_SIM)")


@dataclasses.dataclass
class Reply:
    head: str  # the ok line without the tag and "ok "
    data: list  # the other lines
    kv: dict


@dataclasses.dataclass
class Device:
    index: int
    name: str
    kind: str  # switch | atten | atten_serial | atten_uart
    max: str
    safe: str
    value: str
    note: str

    @property
    def is_atten(self) -> bool:
        return self.kind.startswith("atten")

    @property
    def is_uart(self) -> bool:
        """A UART attenuator: its change lands ms after the latch (design §5.4)."""
        return self.kind == "atten_uart"

    @property
    def step_db(self) -> float:
        return 0.25 if self.is_uart else 0.5


def _kv(text: str) -> dict:
    out = {}
    for tok in text.split():
        if "=" in tok:
            k, _, v = tok.partition("=")
            out[k] = v
    return out


def fmt_value(v, step_db: float = 0.5) -> str:
    """Wire form of a value: switch codes as integers, attenuation (float) in dB as
    the controller formats it (12.0, 12.5, 12.25). `step_db` is the device's step."""
    if isinstance(v, str):
        return v
    if isinstance(v, float):
        q = v / step_db
        if abs(q - round(q)) > 1e-9:
            raise ValueError(f"attenuation {v} dB is not a multiple of {step_db}")
        cdb = int(round(round(q) * step_db * 100))
        whole, frac = divmod(cdb, 100)
        return f"{whole}.{frac // 10}" if frac % 10 == 0 else f"{whole}.{frac:02d}"
    return str(int(v))


@dataclasses.dataclass
class ClockMap:
    """host_monotonic_s = a + b * controller_us (fit from ping midpoints)."""

    a: float
    b: float
    rtt_s: float  # best round trip seen
    n: int

    def to_host(self, ctrl_us: float) -> float:
        return self.a + self.b * ctrl_us

    def to_ctrl(self, host_s: float) -> float:
        return (host_s - self.a) / self.b


class Rfctl:
    def __init__(self, transport: Transport, timeout: float = 3.0) -> None:
        self.t = transport
        self.timeout = timeout
        self._tag = 0
        self._lock = threading.Lock()
        self.devices: dict[str, Device] = {}
        self.info: dict = {}

    @classmethod
    def open(cls, port: str) -> "Rfctl":
        rf = cls(SerialTransport(port))
        rf.hello()
        return rf

    @classmethod
    def sim(
        cls, virtual: bool = True, binary: str | None = None, board: str | None = None
    ) -> "Rfctl":
        """The host simulator. `board`: jeanoko-n4 (default), jeanoko-n6 or pe4302."""
        argv = [binary or sim_binary()] + (["--virtual"] if virtual else [])
        if board:
            argv += ["--board", board]
        rf = cls(ProcessTransport(argv))
        rf.virtual = virtual
        rf.hello()
        return rf

    def close(self) -> None:
        self.t.close()

    def __enter__(self) -> "Rfctl":
        return self

    def __exit__(self, *exc) -> None:
        try:
            self.safe()
        except Exception:
            pass
        self.close()

    # ---- request/reply

    def raw(self, line: str, timeout: float | None = None) -> list[str]:
        """Send one line, return the reply lines (untagged, sim.* commands)."""
        with self._lock:
            self.t.write_line(line)
            out = []
            deadline = time.monotonic() + (timeout or self.timeout)
            while True:
                ln = self.t.read_line(max(0.01, deadline - time.monotonic()))
                if ln is None:
                    raise TimeoutError(f"rfctl: no reply to {line!r}")
                out.append(ln)
                if ln.startswith("ok") or ln.startswith("err"):
                    return out

    def cmd(self, line: str, timeout: float | None = None) -> Reply:
        with self._lock:
            self._tag += 1
            tag = f"@{self._tag}"
            self.t.write_line(f"{tag} {line}")
            data = []
            deadline = time.monotonic() + (timeout or self.timeout)
            while True:
                left = deadline - time.monotonic()
                ln = self.t.read_line(max(0.01, left)) if left > 0 else None
                if ln is None:
                    raise TimeoutError(f"rfctl: no reply to {line!r}")
                if not ln.startswith(tag + " "):
                    continue  # a stale reply or noise
                body = ln[len(tag) + 1 :]
                if body.startswith("ok"):
                    head = body[3:] if body.startswith("ok ") else ""
                    return Reply(head=head, data=data, kv=_kv(head))
                if body.startswith("err"):
                    parts = body.split(" ", 2)
                    raise RfctlError(
                        parts[1] if len(parts) > 1 else "?",
                        parts[2] if len(parts) > 2 else "",
                        line,
                    )
                data.append(body)

    # ---- commands

    def hello(self) -> dict:
        r = self.cmd("hello")
        self.info = r.kv
        if int(r.kv.get("proto", 0)) != 1:
            raise RfctlError("proto", f"unsupported protocol {r.kv.get('proto')}", "hello")
        self.list()
        return r.kv

    def list(self) -> dict[str, Device]:
        r = self.cmd("list")
        devs = {}
        for ln in r.data:
            if not ln.startswith("dev "):
                continue
            head, _, note = ln.partition(' note="')
            parts = head.split()
            kv = _kv(head)
            d = Device(
                int(parts[1]),
                parts[2],
                kv["kind"],
                kv["max"],
                kv["safe"],
                kv["value"],
                note.rstrip('"'),
            )
            devs[d.name] = d
        self.devices = devs
        return devs

    def _pairs(self, values: Mapping[str, object]) -> str:
        toks = []
        for k, v in values.items():
            if k not in self.devices:
                raise KeyError(f"rfctl: no device {k!r} on board {self.info.get('board')}")
            d = self.devices[k]
            if isinstance(v, (int, float)) and not isinstance(v, bool) and d.is_atten:
                v = float(v)
            toks += [k, fmt_value(v, d.step_db)]
        return " ".join(toks)

    def set(self, values: Mapping[str, object]) -> int:
        """Apply several devices in one latch; returns the controller commit time (us)."""
        r = self.cmd("set " + self._pairs(values))
        return int(r.kv["t"])

    def get(self, dev: str) -> str:
        return self.cmd(f"get {dev}").head.split()[-1]

    def state(self) -> dict[str, str]:
        r = self.cmd("state")
        out = {}
        for ln in r.data:
            if ln.startswith("val "):
                _, k, v = ln.split()
                out[k] = v
        out["_chain"] = r.kv.get("chain", "")
        return out

    def safe(self) -> int:
        return int(self.cmd("safe").kv["t"])

    def now_us(self) -> int:
        return int(self.cmd("time").kv["time"])

    def status(self) -> dict:
        kv = self.cmd("status").kv
        out = {}
        for k, v in kv.items():
            try:
                out[k] = int(v, 0)
            except ValueError:
                out[k] = v
        return out

    def lease(self, ms: int) -> None:
        self.cmd(f"lease {int(ms)}")

    def clear(self) -> None:
        self.cmd("clear")

    def load(self, timeline: Iterable[tuple[int, Mapping[str, object]]]) -> int:
        """Replace the timeline: (t_rel_us, {device: value}) steps, non-decreasing."""
        self.clear()
        n = 0
        for t_rel, values in timeline:
            if not values:
                continue
            # one line holds < 256 chars: split a big step over several `at` lines
            # with the same time (the controller still applies them in one latch)
            items = list(values.items())
            while items:
                chunk, size = {}, 0
                while items and (not chunk or size + len(items[0][0]) + 8 < MAX_LINE - 24):
                    k, v = items.pop(0)
                    chunk[k] = v
                    size += len(k) + 8 + 2
                r = self.cmd(f"at {int(t_rel)} " + self._pairs(chunk))
                n = int(r.kv["n"])
        return n

    def play(self, t0_us: int | None = None, delay_us: int = 200_000) -> int:
        arg = str(int(t0_us)) if t0_us is not None else f"+{int(delay_us)}"
        return int(self.cmd(f"play {arg}").kv["t0"])

    def stop(self) -> int:
        return int(self.cmd("stop").kv["next"])

    def log(self, max_n: int = 256) -> list[dict]:
        r = self.cmd(f"log {int(max_n)}")
        out = []
        for ln in r.data:
            if ln.startswith("step "):
                _, ts, ta, late, first, count = ln.split()
                out.append(
                    {
                        "t_sched": int(ts),
                        "t_actual": int(ta),
                        "late_us": int(late),
                        "first": int(first),
                        "count": int(count),
                    }
                )
        return out

    def capture(self, mask: int, holdoff_us: int = 2000) -> None:
        self.cmd(f"cap 0x{mask:04x} {int(holdoff_us)}")

    def capread(self, max_n: int = 512) -> list[tuple[int, int]]:
        """Drain the frame-start timestamps: [(line, t_us)]."""
        out = []
        while True:
            r = self.cmd(f"capread {int(max_n)}")
            for ln in r.data:
                if ln.startswith("ev "):
                    _, line, t = ln.split()
                    out.append((int(line), int(t)))
            if int(r.kv.get("left", 0)) == 0:
                return out

    def selftest(self) -> str:
        return self.cmd("selftest").kv["chain"]

    def attcheck(self, *devs: str) -> dict[str, dict]:
        """Re-send each UART attenuator's value one unit at a time and wait for its
        "ok" on the shared acknowledge line: {dev: {result, value, latency_us}}.
        result is ok | timeout | stuck_low (an unpowered unit on the bus) | absent."""
        r = self.cmd("attcheck " + " ".join(devs), timeout=max(self.timeout, 2.0))
        out = {}
        for ln in r.data:
            if ln.startswith("att "):
                parts = ln.split()
                kv = _kv(ln)
                out[parts[1]] = {
                    "result": parts[2],
                    "value": kv.get("value"),
                    "latency_us": int(kv.get("latency_us", 0)),
                }
        return out

    def clock_map(self, n: int = 24, clock=time.monotonic) -> ClockMap:
        """Fit host time against controller time from `n` pings; the fastest round
        trips carry the least queueing, so the fit uses the best third."""
        samples = []
        for _ in range(n):
            t1 = clock()
            c = int(self.cmd("ping").kv["t"])
            t2 = clock()
            samples.append((t2 - t1, 0.5 * (t1 + t2), c))
        samples.sort()
        best = samples[: max(3, n // 3)]
        if len(best) >= 2 and max(s[2] for s in best) > min(s[2] for s in best):
            import statistics

            cs = [s[2] for s in best]
            hs = [s[1] for s in best]
            cm, hm = statistics.fmean(cs), statistics.fmean(hs)
            var = sum((c - cm) ** 2 for c in cs)
            b = sum((c - cm) * (h - hm) for c, h in zip(cs, hs)) / var if var else 1e-6
            if not (0.999e-6 < b < 1.001e-6):
                b = 1e-6  # a fit over a few ms can't resolve ppm: assume nominal
            a = hm - b * cm
        else:
            b = 1e-6
            a = best[0][1] - b * best[0][2]
        return ClockMap(a=a, b=b, rtt_s=samples[0][0], n=n)

    # ---- simulator only

    def sim_advance(self, us: int) -> int:
        out = self.raw(f"sim.advance {int(us)}", timeout=30)
        return int(_kv(out[-1])["t"])

    def sim_history(self, n: int = 64) -> list[tuple[int, str, int]]:
        out = self.raw(f"sim.history {int(n)}")
        hist = []
        for ln in out:
            if ln.startswith("latch "):
                _, t, chain, gpio, sync = ln.split()
                hist.append((int(t), chain, int(gpio, 0)))
        return hist

    def sim_uart(self, n: int = 64) -> list[tuple[int, int, int, str]]:
        """The last UART attenuator commands: [(t_us, unit, tx_gpio, text)]."""
        out = []
        for ln in self.raw(f"sim.uart {int(n)}"):
            if ln.startswith("uart "):
                _, t, unit, gpio, text = ln.split(" ", 4)
                out.append((int(t), int(unit), int(gpio), text))
        return out

    def sim_edge(self, line: int, t_us: int) -> bool:
        return _kv(self.raw(f"sim.edge {int(line)} {int(t_us)}")[-1]).get("accepted") == "1"
