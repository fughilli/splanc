#!/usr/bin/env python3
"""Host-side flash + serial-log helper for the ESP32-C6 player firmware.

The dev container can't see the board's USB serial device, so run THIS on the
host and drive it over HTTP from inside the container:

    bazel run //tools:flash_server                     # binds 0.0.0.0:8090
    #   (or, without bazel:  python3 tools/flash_server.py)

    # from the container (host is reachable at the docker gateway or
    # host.docker.internal):
    curl -N host.docker.internal:8090/flash            # build + flash, stream log
    curl -N host.docker.internal:8090/logs             # tail the serial console
    curl     host.docker.internal:8090/ports           # list candidate ports

Endpoints (GET or POST — netcat-friendly, e.g.
`printf 'GET /flash HTTP/1.0\\r\\n\\r\\n' | nc HOST 8090`):

    /            usage + detected ports
    /ports       JSON list of candidate serial devices
    /flash       run `bazel run -c opt <target> -- --port <PORT>`, stream output
    /logs        open the serial port and stream what the board prints
                   ?seconds=N  stop after N seconds (default 0 = until you ^C)
                   ?reset=1    pulse the auto-reset line first (see boot logs)
    /ports, /flash, /logs all accept ?port=/dev/ttyACM0 and ?baud=115200

Flashing and log-reading share the one serial port: a /flash request preempts
any in-progress /logs stream, then holds the port until the flash finishes.

Serial reads use pyserial when importable, else a stdlib termios fallback (so
the base feature works with nothing installed; `reset` needs either path).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import select
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Repo root to run `bazel` in (overridable with --workspace). Under `bazel run`
# the launcher sets $BUILD_WORKSPACE_DIRECTORY to the real workspace (this file
# otherwise lives in the runfiles tree, not the checkout); fall back to the
# parent of this tools/ dir when run as a plain script.
def _default_workspace() -> str:
    return os.environ.get("BUILD_WORKSPACE_DIRECTORY") or str(
        Path(__file__).resolve().parents[1]
    )

# One user of the serial port at a time; a /flash preempts a live /logs stream.
_PORT_LOCK = threading.Lock()
_PREEMPT = threading.Event()

CFG: dict = {}  # populated from argv in main()


def _log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# Serial port discovery + reading
# --------------------------------------------------------------------------- #
def list_ports() -> list[str]:
    """Candidate USB-serial devices, most-likely first (Linux + macOS)."""
    pats = [
        "/dev/ttyACM*",
        "/dev/ttyUSB*",
        "/dev/cu.usbmodem*",
        "/dev/cu.usbserial*",
        "/dev/cu.SLAB_USBtoUART*",
        "/dev/cu.wchusbserial*",
    ]
    found: list[str] = []
    for p in pats:
        found.extend(sorted(glob.glob(p)))
    return found


def resolve_port(explicit: str | None) -> str:
    port = explicit or CFG["port"]
    if port:
        return port
    ports = list_ports()
    if not ports:
        raise FileNotFoundError(
            "no serial port given and none auto-detected "
            "(pass ?port=/dev/ttyACM0 or --serial)"
        )
    return ports[0]


class _Serial:
    """Minimal read-only serial wrapper: pyserial if present, else termios.

    `read_some(timeout)` returns whatever bytes are available within `timeout`
    seconds (possibly b""). `reset` pulses the ESP auto-reset lines on open."""

    def __init__(self, port: str, baud: int, reset: bool):
        self.port = port
        self._impl = None
        self._fd = -1
        try:
            import serial  # type: ignore

            s = serial.Serial()
            s.port = port
            s.baudrate = baud
            s.timeout = 0.2
            # Don't disturb the board on open unless asked (opening otherwise
            # tends to toggle DTR/RTS and reset the ESP).
            s.dtr = False
            s.rts = False
            s.open()
            if reset:
                # Classic ESP auto-reset: pulse EN (RTS) low with GPIO0 (DTR)
                # high → boot back into the app.
                s.dtr = False
                s.rts = True
                time.sleep(0.1)
                s.rts = False
                time.sleep(0.1)
            self._impl = s
        except ImportError:
            self._open_termios(port, baud, reset)

    # -- pyserial-less path ------------------------------------------------- #
    def _open_termios(self, port: str, baud: int, reset: bool) -> None:
        import termios

        baud_const = getattr(termios, f"B{baud}", None)
        if baud_const is None:
            raise ValueError(
                f"pyserial not installed and baud {baud} has no termios constant"
            )
        fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        iflag, oflag, cflag, lflag, ispeed, ospeed, cc = termios.tcgetattr(fd)
        iflag = oflag = lflag = 0  # raw
        cflag = (cflag & ~(termios.CSIZE | termios.PARENB)) | (
            termios.CS8 | termios.CREAD | termios.CLOCAL
        )
        cc = list(cc)
        cc[termios.VMIN] = 0
        cc[termios.VTIME] = 0
        termios.tcsetattr(
            fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, baud_const, baud_const, cc]
        )
        self._fd = fd
        if reset:
            self._pulse_reset_termios(fd)

    @staticmethod
    def _pulse_reset_termios(fd: int) -> None:
        # Best-effort auto-reset: assert then release RTS (wired to EN). Use the
        # platform's own ioctl constants from `termios` (the raw request numbers
        # differ Linux vs macOS — hardcoding Linux values yields EINVAL/ENOTTY
        # elsewhere), and never let an unsupported tty fail the read.
        import fcntl
        import struct
        import termios

        try:
            for cmd in (termios.TIOCMBIS, termios.TIOCMBIC):
                fcntl.ioctl(fd, cmd, struct.pack("I", termios.TIOCM_RTS))
                time.sleep(0.1)
        except OSError:
            pass

    def read_some(self, timeout: float = 0.2) -> bytes:
        if self._impl is not None:
            n = self._impl.in_waiting or 1
            return self._impl.read(n)
        r, _, _ = select.select([self._fd], [], [], timeout)
        if not r:
            return b""
        try:
            return os.read(self._fd, 4096)
        except (BlockingIOError, OSError):
            return b""

    def close(self) -> None:
        try:
            if self._impl is not None:
                self._impl.close()
            elif self._fd >= 0:
                os.close(self._fd)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# child-process env: strip anything bazel injected so a nested `bazel run` from
# inside this server (should someone launch it via `bazel run`) starts clean.
# --------------------------------------------------------------------------- #
def child_env() -> dict:
    env = dict(os.environ)
    for k in list(env):
        if k.startswith(("BAZEL", "TEST_", "RUNFILES", "BUILD_WORK")) or k in (
            "JAVA_RUNFILES",
            "RUN_UNDER_RUNFILES",
        ):
            env.pop(k, None)
    return env


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "flash-server/1.0"

    # Route GET and POST identically (curl -N, or netcat with either verb).
    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def log_message(self, fmt: str, *args) -> None:
        _log("%s - %s" % (self.address_string(), fmt % args))

    # -- helpers ------------------------------------------------------------ #
    def _write(self, data) -> bool:
        """Write a chunk to the client; False once the client has gone away."""
        if isinstance(data, str):
            data = data.encode("utf-8", "replace")
        try:
            self.wfile.write(data)
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def _begin_stream(self, content_type: str = "text/plain; charset=utf-8") -> None:
        # HTTP/1.0 (the default): no Content-Length, body streams until we close
        # the connection — exactly what `curl -N` / netcat want.
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _text(self, text: str, code: int = 200) -> None:
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _dispatch(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        q = urllib.parse.parse_qs(parsed.query)
        get = lambda k, d=None: q.get(k, [d])[0]
        try:
            if route == "/":
                self._usage()
            elif route == "/ports":
                self._json({"ports": list_ports(), "default": CFG["port"]})
            elif route == "/flash":
                self._flash(get("port"), get("baud"))
            elif route == "/logs":
                self._logs(
                    get("port"),
                    int(get("baud", CFG["baud"])),
                    float(get("seconds", "0")),
                    get("reset", "0") not in ("0", "", "false"),
                )
            else:
                self._text(f"no such endpoint: {route}\n", 404)
        except FileNotFoundError as e:
            self._text(f"error: {e}\n", 404)
        except Exception as e:  # noqa: BLE001 — report anything to the client
            self._text(f"error: {e}\n", 500)

    # -- endpoints ---------------------------------------------------------- #
    def _usage(self) -> None:
        ports = list_ports()
        self._text(
            f"{__doc__}\n"
            f"workspace : {CFG['workspace']}\n"
            f"target    : {CFG['target']}\n"
            f"bazel     : {CFG['bazel']} {' '.join(CFG['bazel_args'])}\n"
            f"detected  : {', '.join(ports) or '(none)'}\n"
        )

    def _flash(self, port: str | None, baud: str | None) -> None:
        dev = resolve_port(port)
        cmd = [CFG["bazel"], "run", *CFG["bazel_args"], CFG["target"], "--", "--port", dev]
        if baud:
            cmd += ["--baud", str(int(baud))]

        # Preempt a live /logs stream, then take exclusive use of the port.
        _PREEMPT.set()
        got = _PORT_LOCK.acquire(timeout=30)
        _PREEMPT.clear()
        if not got:
            self._text("busy: serial port in use (timed out)\n", 503)
            return

        self._begin_stream()
        self._write(f"[flash-server] $ {' '.join(cmd)}\n[flash-server]   cwd={CFG['workspace']}\n\n")
        rc = -1
        try:
            try:
                proc = subprocess.Popen(
                    cmd,
                    cwd=CFG["workspace"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    env=child_env(),
                    bufsize=1,
                    text=True,
                )
            except OSError as e:
                # The stream already started — report into the body, never a
                # second HTTP response.
                self._write(f"[flash-server] cannot launch '{CFG['bazel']}': {e}\n")
                return
            assert proc.stdout is not None
            for line in proc.stdout:
                if not self._write(line):
                    proc.terminate()  # client hung up — abort the flash
                    break
            rc = proc.wait()
            self._write(f"\n[flash-server] exit {rc}\n")
        finally:
            _PORT_LOCK.release()

    def _logs(self, port: str | None, baud: int, seconds: float, reset: bool) -> None:
        dev = resolve_port(port)
        got = _PORT_LOCK.acquire(timeout=5)
        if not got:
            self._text("busy: serial port in use (flash in progress?)\n", 503)
            return
        _PREEMPT.clear()
        self._begin_stream()
        which = "pyserial" if "serial" in sys.modules or _has_pyserial() else "termios"
        self._write(f"[flash-server] reading {dev} @ {baud} ({which})"
                    f"{' +reset' if reset else ''}"
                    f"{f', {seconds:g}s' if seconds else ', until you disconnect'}\n\n")
        ser = None
        try:
            try:
                ser = _Serial(dev, baud, reset)
            except Exception as e:  # noqa: BLE001 — into the body, not a 2nd response
                self._write(f"[flash-server] cannot open {dev}: {e}\n")
                return
            deadline = time.monotonic() + seconds if seconds > 0 else None
            while not _PREEMPT.is_set():
                if deadline is not None and time.monotonic() >= deadline:
                    break
                chunk = ser.read_some(0.2)
                if chunk and not self._write(chunk):
                    break  # client disconnected
        finally:
            if ser is not None:
                ser.close()
            _PORT_LOCK.release()
        if _PREEMPT.is_set():
            self._write("\n[flash-server] preempted by a flash request\n")


def _has_pyserial() -> bool:
    try:
        import serial  # noqa: F401

        return True
    except ImportError:
        return False


def _lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Host flash + serial-log helper.")
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0 so the container can reach it)")
    ap.add_argument("--port", type=int, default=8090, help="HTTP port (default 8090)")
    ap.add_argument("--serial", default=os.environ.get("FLASH_SERIAL", ""),
                    help="serial device (default: auto-detect the first USB-serial port)")
    ap.add_argument("--baud", type=int, default=115200, help="serial console baud for /logs (default 115200)")
    ap.add_argument("--workspace", default=_default_workspace(), help="repo root to run bazel in (default: $BUILD_WORKSPACE_DIRECTORY under `bazel run`)")
    ap.add_argument("--target", default="//firmware/player_app:flash_esp32c6", help="bazel flash target")
    ap.add_argument("--bazel", default=os.environ.get("BAZEL", "bazel"), help="bazel/bazelisk binary")
    ap.add_argument("--bazel-arg", action="append", default=None,
                    help="extra bazel arg before the target (repeatable; default: -c opt)")
    args = ap.parse_args()

    CFG.update(
        port=args.serial or "",
        baud=args.baud,
        workspace=args.workspace,
        target=args.target,
        bazel=args.bazel,
        bazel_args=args.bazel_arg if args.bazel_arg is not None else ["-c", "opt"],
    )

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    lan = _lan_ip() if args.host in ("0.0.0.0", "::") else args.host
    _log(f"flash-server on http://{args.host}:{args.port}  (LAN: http://{lan}:{args.port})")
    _log(f"  workspace {CFG['workspace']}")
    _log(f"  target    {CFG['target']}  via  {CFG['bazel']} {' '.join(CFG['bazel_args'])}")
    _log(f"  serial    {CFG['port'] or '(auto)'} @ {CFG['baud']}   pyserial={_has_pyserial()}")
    _log(f"  ports     {', '.join(list_ports()) or '(none detected)'}")
    if args.host in ("0.0.0.0", "::"):
        _log("  NOTE: bound to all interfaces so the container can reach it — /flash "
             "runs a build on this host. Use --host to restrict.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
