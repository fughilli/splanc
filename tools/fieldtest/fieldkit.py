#!/usr/bin/env python3
"""fieldkit — drive Splanc mesh field-kit nodes (firmware/fieldtest/field_node.cpp) over USB.

One file, needs only Python 3.8+ and pyserial (`pip3 install pyserial esptool`). Commands:

  fieldkit.py ports                                   list USB serial ports
  fieldkit.py flash BUNDLE.tar --id N [--ch C]        flash a node, set its id, erase its log
  fieldkit.py setup --id N [--ch C] [--erase]         (re)configure an already-flashed node
  fieldkit.py show                                    print the node's config + peers
  fieldkit.py scan                                    list Wi-Fi APs per channel (pick a quiet one)
  fieldkit.py collect --out DIR                       log everything the node hears (the collector);
                                                      type phase/power/rate commands while it runs
  fieldkit.py pull --out DIR                          download the node's flash log (end of day)
  fieldkit.py send 'CMD'                              send one raw command line

--port defaults to the only USB serial port present. Logs are text, one line per serial line
prefixed by the host's unix time: "<unix.sss>\\t<line>". The analysis is tools/fieldtest/analyze.py.
"""
from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time

try:
    import serial  # pyserial
    import serial.tools.list_ports
except ImportError:  # pragma: no cover
    serial = None


def die(msg: str) -> None:
    print(f"fieldkit: {msg}", file=sys.stderr)
    sys.exit(1)


def find_ports() -> list[str]:
    pats = [
        "/dev/ttyACM*",
        "/dev/cu.usbmodem*",
        "/dev/ttyUSB*",
        "/dev/cu.usbserial*",
        "/dev/cu.wchusbserial*",
    ]
    found = sorted({p for pat in pats for p in glob.glob(pat)})
    if not found and serial is not None:
        found = [
            p.device
            for p in serial.tools.list_ports.comports()
            if "USB" in (p.description or "") or p.vid
        ]
    return found


def pick_port(port: str | None) -> str:
    if port:
        return port
    ports = find_ports()
    if len(ports) == 1:
        return ports[0]
    if not ports:
        die("no USB serial port found; plug the node into the port marked USB (not UART)")
    die("several ports: pass --port, one of: " + " ".join(ports))
    return ""


class Node:
    """A line-oriented connection to one node."""

    def __init__(self, port: str, log=None):
        if serial is None:
            die("pyserial missing: pip3 install pyserial")
        self.port = port
        # DTR/RTS low before opening: on the C6's USB-Serial-JTAG some line patterns reset it.
        self.ser = serial.Serial()
        self.ser.port, self.ser.baudrate, self.ser.timeout = port, 115200, 0.2
        self.ser.dtr = False
        self.ser.rts = False
        self.ser.open()
        self.log = log
        self.buf = b""
        self.lock = threading.Lock()

    def close(self) -> None:
        self.ser.close()

    def write(self, line: str) -> None:
        with self.lock:
            self.ser.write((line.strip() + "\n").encode())
            self.ser.flush()
        if self.log:
            self.log.write(f"{time.time():.3f}\t>{line.strip()}\n")
            self.log.flush()

    def lines(self, seconds: float):
        """Yield decoded lines for `seconds` (None = forever)."""
        end = None if seconds is None else time.time() + seconds
        while end is None or time.time() < end:
            try:
                chunk = self.ser.read(4096)
            except serial.SerialException:
                # Native USB re-enumerates on reset: reopen.
                time.sleep(0.5)
                try:
                    self.ser.close()
                    self.ser.open()
                except Exception:
                    pass
                continue
            if not chunk:
                yield None
                continue
            self.buf += chunk
            while b"\n" in self.buf:
                raw, self.buf = self.buf.split(b"\n", 1)
                line = raw.decode("utf-8", "replace").rstrip("\r")
                if self.log:
                    self.log.write(f"{time.time():.3f}\t{line}\n")
                yield line

    def command(self, line: str, expect: str, seconds: float = 5.0) -> str | None:
        """Send a command and return the first reply line starting with `expect`."""
        self.write(line)
        for got in self.lines(seconds):
            if got is not None and got.startswith(expect):
                return got
        return None


def ctl_line(**kv) -> str:
    """A kit-wide CTRL: epoch and wall clock from this host, flooded to every node."""
    now = int(time.time())
    parts = [f"epoch={now}", f"unix={now}"]
    for k, v in kv.items():
        if v is None:
            continue
        if k == "label":
            v = str(v).replace(" ", "_")[:19]
        parts.append(f"{k}={v}")
    return "ctl " + " ".join(parts)


def configure(node: Node, args) -> None:
    cmds = []
    if getattr(args, "defaults", False):
        cmds.append("defaults")
    if args.id is not None:
        cmds.append(f"id {args.id}")
    for flag, cmd in (
        ("ch", "ch"),
        ("pwr", "pwr"),
        ("rates", "rates"),
        ("period", "period"),
        ("len", "len"),
        ("win", "win"),
        ("led", "led"),
        ("run_s", "run_s"),
        ("net", "net"),
        ("mping", "mping"),
    ):
        v = getattr(args, flag, None)
        if v is not None:
            cmds.append(f"{cmd} {v}")
    for c in cmds:
        node.command(c, "I,field_node", 8)
    if getattr(args, "erase", False):
        if node.command("erase", "I,erased", 60) is None:
            die("erase did not confirm")
    show = node.command("show", "I,field_node", 5)
    if show is None:
        die("node did not answer `show` (is this a field node? try the USB port, then RESET)")
    print(show)


def cmd_flash(args) -> None:
    port = pick_port(args.port)
    tmp = tempfile.mkdtemp(prefix="fieldkit-")
    with tarfile.open(args.bundle) as t:
        t.extractall(tmp)
    man = json.load(open(os.path.join(tmp, "flash.json")))
    esptool = shutil.which("esptool.py") or shutil.which("esptool")
    base = [esptool] if esptool else [sys.executable, "-m", "esptool"]
    argv = base + ["--chip", man.get("chip", "esp32c6"), "-p", port, "-b", "460800", "write_flash"]
    for img in man["images"]:
        argv += [img["offset"], os.path.join(tmp, img["file"])]
    print(" ".join(argv))
    if subprocess.call(argv) != 0:
        # esptool v5 spells it write-flash
        argv = [a if a != "write_flash" else "write-flash" for a in argv]
        if subprocess.call(argv) != 0:
            die("esptool failed (hold BOOT, tap RESET, release BOOT, and retry)")
    shutil.rmtree(tmp, ignore_errors=True)
    time.sleep(3.0)
    args.erase = True
    args.defaults = True
    node = Node(port)
    configure(node, args)
    node.close()
    print(f"node {args.id} ready: label it, unplug, power it from a battery.")


def cmd_setup(args) -> None:
    node = Node(pick_port(args.port))
    configure(node, args)
    node.close()


def cmd_show(args) -> None:
    node = Node(pick_port(args.port))
    node.write("show")
    for line in node.lines(2.0):
        if line and line.startswith("I,"):
            print(line)
    node.close()


def cmd_scan(args) -> None:
    node = Node(pick_port(args.port))
    node.write("scan")
    for line in node.lines(12.0):
        if line and line.startswith("A,"):
            print(line)
            if line.startswith("A,summary"):
                break
    node.close()


def cmd_send(args) -> None:
    node = Node(pick_port(args.port))
    node.write(args.line)
    for line in node.lines(args.seconds):
        if line and not line.startswith(("R,", "T,", "B,", "H,")):
            print(line)
    node.close()


HELP = """collector commands (type and Enter; each is flooded to every node with this laptop's clock):
  phase N [label] [pwr=8] [rates=1,6]   start step N (e.g. 'phase 4 b_lowpwr pwr=8')
  pwr DBM             TX power for the whole kit (2..20)
  rates 1,6           rates cycled per frame (1,2,5.5,11,6,9,12,18,24,36,48,54)
  period MS           probe period
  quiet 1|0           stop / restart the kit's transmissions
  mesh 1|0            run the real mesh flood on every node (stretch); hops N sets its hop limit
  !RAW                send a raw command to the collector node only (e.g. !show)
  q                   stop collecting"""


def collect_loop(
    node: Node, duration: float | None, schedule: list[tuple[float, str]], quiet_console: bool
) -> None:
    t0 = time.time()
    pending = sorted(schedule)
    stats = {"R": 0, "H": 0, "B": 0, "T": 0}
    last_print = 0.0
    for line in node.lines(duration):
        now = time.time()
        while pending and now - t0 >= pending[0][0]:
            _, cmd = pending.pop(0)
            if cmd.startswith("ctl "):  # stamp the clock when it is sent
                cmd = ctl_line(**dict(x.split("=", 1) for x in cmd[4:].split()))
            node.write(cmd)
        if line:
            tag = line[:1]
            if tag in stats:
                stats[tag] += 1
            elif not quiet_console:
                print(line[:200])
        if not quiet_console and now - last_print > 10:
            last_print = now
            print(
                f"[{time.strftime('%H:%M:%S')}] frames={stats['R']} summaries heard={stats['H']} "
                f"own windows={stats['B']} acks={stats['T']}",
                flush=True,
            )


def console(node: Node, stop: threading.Event) -> None:
    print(HELP)
    for raw in sys.stdin:
        s = raw.strip()
        if not s:
            continue
        if s in ("q", "quit", "exit"):
            stop.set()
            return
        if s.startswith("!"):
            node.write(s[1:])
            continue
        w = s.split()
        try:
            if w[0] == "phase":
                # phase N [label] [pwr=8 rates=1,6 ...]: one CTRL for the step and its settings
                kv = dict(x.split("=", 1) for x in w[2:] if "=" in x)
                label = " ".join(x for x in w[2:] if "=" not in x) or None
                node.write(ctl_line(phase=int(w[1]), label=label, **kv))
            elif w[0] in ("pwr", "period", "len", "quiet", "uni", "win", "raw", "mesh", "hops"):
                node.write(ctl_line(**{w[0]: int(w[1])}))
            elif w[0] == "rates":
                node.write(ctl_line(rates=w[1]))
            else:
                print("? " + HELP)
        except (IndexError, ValueError):
            print("? " + HELP)


def cmd_collect(args) -> None:
    port = pick_port(args.port)
    os.makedirs(args.out, exist_ok=True)
    name = os.path.join(
        args.out, f"collect-{time.strftime('%Y%m%d-%H%M%S')}-{os.path.basename(port)}.log"
    )
    log = sys.stdout if args.out == "-" else open(name, "a", buffering=1)
    node = Node(port, log=log)
    print(f"logging to {name}")
    for c in args.setup or []:
        node.write(c)
        time.sleep(0.3)
    node.write("show")
    sched = []
    for a in args.at or []:
        off, cmd = a.split(":", 1)
        sched.append((float(off), cmd))
    stop = threading.Event()
    if args.interactive:
        threading.Thread(target=console, args=(node, stop), daemon=True).start()
    try:
        if args.interactive and args.duration is None:
            for line in node.lines(None):
                if stop.is_set():
                    break
                if line and line[:1] not in "RHBT":
                    print(line[:200])
        else:
            collect_loop(node, args.duration, sched, quiet_console=args.out == "-")
    except KeyboardInterrupt:
        pass
    if args.dump_at_end:
        pull(node, args.out if args.out != "-" else None, log)
    node.close()


def pull(node: Node, outdir: str | None, log=None) -> str | None:
    """Ask for the flash log, rebuild the bytes, save <outdir>/node<ID>-<time>.bin."""
    show = node.command("show", "I,field_node", 5) or ""
    node_id = "x"
    for kv in show.split(","):
        if kv.startswith("id="):
            node_id = kv[3:]
    node.log = None  # keep the dump out of the text log
    node.write("dump")
    data = bytearray()
    size = None
    for line in node.lines(180):
        if line is None or not line.startswith("X,"):
            continue
        parts = line.split(",")
        if parts[1] == "begin":
            size = int(parts[3])
        elif parts[1] == "end":
            end = int(parts[2])
            if len(data) != end:
                print(f"warning: got {len(data)} of {end} bytes")
            break
        else:
            off = int(parts[1])
            chunk = base64.b64decode(parts[2])
            if off != len(data):
                print(f"warning: gap at {off} (have {len(data)})")
                data.extend(b"\xff" * (off - len(data)))
            data.extend(chunk)
    node.log = log
    if outdir is None:
        sys.stdout.write(f"{time.time():.3f}\tXB64,{base64.b64encode(bytes(data)).decode()}\n")
        return None
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"node{node_id}-{time.strftime('%Y%m%d-%H%M%S')}.bin")
    with open(path, "wb") as f:
        f.write(data)
    print(f"saved {len(data)} bytes ({size} partition) -> {path}")
    return path


def cmd_pull(args) -> None:
    node = Node(pick_port(args.port))
    pull(node, args.out)
    node.close()


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--port")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def cfg_flags(p):
        p.add_argument("--id", type=int)
        p.add_argument("--ch", type=int)
        p.add_argument("--pwr", type=int)
        p.add_argument("--rates")
        p.add_argument("--period", type=int)
        p.add_argument("--len", type=int)
        p.add_argument("--win", type=int)
        p.add_argument("--led", type=int)
        p.add_argument("--run_s", type=int)
        p.add_argument("--net", type=int)

    sub.add_parser("ports").set_defaults(fn=lambda a: print("\n".join(find_ports()) or "none"))
    p = sub.add_parser("flash")
    p.add_argument("bundle")
    cfg_flags(p)
    p.set_defaults(fn=cmd_flash)
    p = sub.add_parser("setup")
    cfg_flags(p)
    p.add_argument("--erase", action="store_true", help="clear the node's log")
    p.add_argument(
        "--defaults", action="store_true", help="reset power/rates/period/mesh to defaults"
    )
    p.add_argument("--mping", type=int, help="1 = this node pings the mesh (the collector)")
    p.set_defaults(fn=cmd_setup)
    sub.add_parser("show").set_defaults(fn=cmd_show)
    sub.add_parser("scan").set_defaults(fn=cmd_scan)
    p = sub.add_parser("send")
    p.add_argument("line")
    p.add_argument("--seconds", type=float, default=3.0)
    p.set_defaults(fn=cmd_send)
    p = sub.add_parser("collect")
    p.add_argument("--out", default="fieldlogs")
    p.add_argument("--duration", type=float)
    p.add_argument("--setup", action="append", help="raw command(s) sent first")
    p.add_argument(
        "--at",
        action="append",
        help="'SECONDS:command' scheduled commands ('ctl k=v ..' gets the clock)",
    )
    p.add_argument("--dump-at-end", action="store_true")
    p.add_argument("--no-interactive", dest="interactive", action="store_false")
    p.set_defaults(fn=cmd_collect)
    p = sub.add_parser("pull")
    p.add_argument("--out", default="fieldlogs")
    p.set_defaults(fn=cmd_pull)
    args = ap.parse_args()
    if args.cmd == "flash" and args.id is None:
        die("flash needs --id N (1..254), unique per node; write it on the board")
    args.fn(args)


if __name__ == "__main__":
    main()
