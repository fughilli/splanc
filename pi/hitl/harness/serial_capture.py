"""Always-on DUT serial capture for every HITL reservation.

Every on-hardware failure should come with the firmware's own account of what
happened. `hitl_client.Reservation` uses this module to:

  1. ship REMOTE_LOGGER into the reservation and start it at acquire() — a
     background capture of every DUT tty in the reservation, written line-by-line
     with UTC timestamps (so it lines up with the CI log);
  2. PAUSE it around any ssh command that needs the port itself (hitl-flash,
     hitl-monitor, esptool, a shipped probe that opens the tty, ...) — two readers
     on one tty split the byte stream and esptool can't sync — and resume after;
  3. stop + fetch it at release(), save the full log (HITL_SERIAL_LOG_DIR, else the
     test's undeclared outputs), and print the tail into the test output when the
     test is failing (see hitl_client's failure hooks).

The capture does NOT reset the board on attach. The native-USB ESP32-C6 resets when
RTS is asserted with DTR deasserted; the kernel raises both together on open (harmless),
and the logger then drops RTS before DTR so it never passes through that state. (The
DTR-first order — pyserial's `dtr=False; rts=False`, which `hitl-monitor` uses — does,
which is why that tool resets on attach and throws away a DUT's lease.) So a reset in
the log is real. It also reopens after a disconnect: a chip reset re-enumerates the
native USB port.

The client-side helpers here are pure (no ssh) so they unit-test offline.
"""

from __future__ import annotations

import base64
import re
import shlex

# Where the logger lives + writes inside the reservation (per-reservation container /
# session, so a fixed path is fine).
REMOTE_DIR = "/tmp/hitl-serial"

# Commands that open the DUT's serial port themselves. Matched against the command
# string a test hands to Reservation.ssh(); a match pauses the capture around it.
PORT_USER = re.compile(
    r"\b(hitl-flash|hitl-monitor|hitl-jtag|hitl-gdb|esptool(\.py)?|openocd"
    r"|ios_serial_diag\.py|led_freeze_probe\.py)\b"
    r"|/dev/tty(ACM|USB)\d|/dev/cu\.|\$\{?HITL_(TTY|ESP_PORT)"
)

# A command that leaves a port user running in the background after it returns (e.g.
# `( nohup hitl-monitor ... & )`): resuming right away would put two readers on the
# tty, so the capture stays paused (and says so in the log).
BACKGROUNDS = re.compile(r"\bnohup\b|&\s*(\)|;|$)")

# Pick a python3 that can import pyserial: the rig toolbox's python3 on PATH has it;
# the Mac bench's is the nix one (its /usr/bin/python3 doesn't).
PY_SELECT = (
    "PY=; for p in python3 /run/current-system/sw/bin/python3; do "
    'if "$p" -c "import serial" >/dev/null 2>&1; then PY=$p; break; fi; done; '
)

TAIL_LINES = 80


def needs_port(cmd: str) -> bool:
    return bool(PORT_USER.search(cmd))


def _logger(action: str, remote_dir: str, *extra: str) -> str:
    args = " ".join(shlex.quote(a) for a in extra)
    return (
        f'[ -n "$PY" ] && "$PY" {remote_dir}/logger.py {action} {remote_dir} {args} '
        ">/dev/null 2>&1"
    ).rstrip()


def install_cmd(remote_dir: str = REMOTE_DIR) -> str:
    """Shell command that writes the logger into the reservation and starts it.
    Prints `serial-capture: <ports>` (or `serial-capture: none`) for the caller."""
    b64 = base64.b64encode(REMOTE_LOGGER.encode()).decode()
    # Python, not mkdir/base64(1): the rig reservation shell is a minimal busybox.
    write = (
        "import base64,os,sys;os.makedirs(sys.argv[1],exist_ok=True);"
        "open(sys.argv[1]+'/logger.py','wb').write(base64.b64decode(sys.argv[2]))"
    )
    return (
        PY_SELECT
        + 'if [ -z "$PY" ]; then echo "serial-capture: no python3 with pyserial"; exit 0; fi; '
        + f'"$PY" -c {shlex.quote(write)} {remote_dir} {b64} && '
        + f'"$PY" {remote_dir}/logger.py start {remote_dir}'
    )


def wrap_port_cmd(cmd: str, remote_dir: str = REMOTE_DIR) -> str:
    """Pause the capture around `cmd` (which needs the port), preserving its exit
    status. The command runs in a subshell so its own `exit`/`set -e` can't skip the
    resume."""
    reason = "paused for: " + " ".join(cmd.split())[:120]
    pre = PY_SELECT + _logger("stop", remote_dir, reason) + "; "
    if BACKGROUNDS.search(cmd):
        return pre + f"( {cmd}\n)"
    return pre + f"( {cmd}\n); rc=$?; " + _logger("start", remote_dir) + "; exit $rc"


FILE_MARK = "@@@HITL-SERIAL-FILE "


def fetch_cmd(remote_dir: str = REMOTE_DIR) -> str:
    """Stop the capture and print every log, each preceded by FILE_MARK <name>."""
    return PY_SELECT + f'[ -n "$PY" ] && "$PY" {remote_dir}/logger.py dump {remote_dir}'


def parse_fetch(out: str) -> dict[str, str]:
    """Split fetch_cmd() output into {log name: text}."""
    logs: dict[str, str] = {}
    name = None
    buf: list[str] = []
    for line in out.splitlines(keepends=True):
        if line.startswith(FILE_MARK):
            if name is not None:
                logs[name] = "".join(buf)
            name, buf = line[len(FILE_MARK) :].strip(), []
        elif name is not None:
            buf.append(line)
    if name is not None:
        logs[name] = "".join(buf)
    return logs


def log_filename(target: str, unit: str, res_id: str, log_name: str) -> str:
    """A stable, unique file name: <test target>--<unit>--<reservation>--<dut log>."""
    tgt = re.sub(r"[^A-Za-z0-9_.-]+", "_", target.lstrip("/")).strip("_") or "hitl"
    return f"{tgt}--{unit or 'unit'}--{res_id or 'res'}--{log_name}"


def format_tail(label: str, text: str, n: int = TAIL_LINES) -> str:
    lines = text.splitlines()
    shown = lines[-n:]
    head = f"===== DUT serial log: {label} (last {len(shown)} of {len(lines)} lines) ====="
    return "\n".join([head, *shown, "=" * len(head)])


# The in-reservation logger. Stdlib + pyserial only; runs under the toolbox python3.
#   logger.py start DIR          daemonize and capture every DUT tty to DIR/dut<N>.log
#   logger.py stop DIR [REASON]  stop it (writing REASON into each log)
REMOTE_LOGGER = r'''
import os, signal, sys, threading, time

MAX_BYTES = 32 * 1024 * 1024


def ports():
    """DUT ttys in this reservation: HITL_TTY[_N] (rig units), else HITL_ESP_PORT (the
    phone benches), else /dev/ttyACM0 when present."""
    found = []
    for n in range(8):
        p = os.environ.get("HITL_TTY" + ("" if n == 0 else "_%d" % n))
        if p:
            found.append((n, p))
    if not found:
        p = os.environ.get("HITL_ESP_PORT") or ("/dev/ttyACM0" if os.path.exists("/dev/ttyACM0") else "")
        if p:
            found.append((0, p))
    return found


def stamp():
    t = time.time()
    return time.strftime("%H:%M:%S", time.gmtime(t)) + ".%03dZ " % int((t % 1) * 1000)


class Log:
    def __init__(self, path):
        self.f = open(path, "ab", buffering=0)
        self.size = os.path.getsize(path)

    def line(self, text):
        if self.size > MAX_BYTES:
            return
        b = (stamp() + text.rstrip("\r\n") + "\n").encode("utf-8", "replace")
        self.f.write(b)
        self.size += len(b)
        if self.size > MAX_BYTES:
            self.f.write(b"[capture] log size cap reached; capture truncated\n")


def capture(port, log, stop):
    import serial

    ser, buf, last, waiting = None, b"", time.time(), False
    log.line("[capture] started on %s (non-resetting)" % port)
    while not stop.is_set():
        if ser is None:
            try:
                # Linux cdc-acm raises DTR+RTS together on open: (DTR,RTS)=(1,1) leaves
                # the C6 running. Then drop RTS FIRST, then DTR, ending at (0,0). The
                # other order passes through (0,1) = EN low = a chip reset, which is
                # what made pyserial's dtr=False/rts=False (and hitl-monitor) reset
                # the board on attach. (1,0) only straps GPIO9 if a reset lands in
                # that instant.
                s = serial.Serial(port, 115200, timeout=0.2)
                try:
                    s.rts = False
                    s.dtr = False
                except Exception:  # no modem lines (e.g. a pty): nothing to reset
                    pass
                ser = s
                if waiting:
                    log.line("[capture] %s is back" % port)
                waiting = False
            except Exception:
                if not waiting:
                    log.line("[capture] waiting for %s" % port)
                waiting = True
                stop.wait(0.2)
                continue
        try:
            chunk = ser.read(4096)
        except Exception as e:
            log.line("[capture] %s disconnected (%s) - reset/re-enumeration?" % (port, type(e).__name__))
            try:
                ser.close()
            except Exception:
                pass
            ser, waiting = None, True
            continue
        if chunk:
            buf += chunk
            last = time.time()
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                log.line(line.decode("utf-8", "replace"))
        elif buf and time.time() - last > 0.5:
            log.line(buf.decode("utf-8", "replace"))  # flush a partial line
            buf = b""
    if buf:
        log.line(buf.decode("utf-8", "replace"))
    if ser is not None:
        try:
            ser.close()
        except Exception:
            pass


def guarded(port, log, stop):
    try:
        capture(port, log, stop)
    except Exception as e:  # never die silently: the log is the only witness
        log.line("[capture] FAILED on %s: %s: %s" % (port, type(e).__name__, e))


def run(d, stop):
    threads = []
    ps = ports()
    if not ps:
        Log(os.path.join(d, "dut0.log")).line("[capture] no DUT serial port in this reservation")
        return
    for n, p in ps:
        t = threading.Thread(target=guarded, args=(p, Log(os.path.join(d, "dut%d.log" % n)), stop), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join()


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_pid(d):
    try:
        return int(open(os.path.join(d, "pid")).read().strip())
    except Exception:
        return 0


def start(d):
    pid = read_pid(d)
    if pid and alive(pid):
        return
    if os.fork():
        for _ in range(50):  # parent: wait for the daemon to write its pid
            if read_pid(d) and alive(read_pid(d)):
                break
            time.sleep(0.05)
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    open(os.path.join(d, "pid"), "w").write(str(os.getpid()))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        run(d, stop)
    finally:
        os._exit(0)


def stop(d, reason):
    pid = read_pid(d)
    if pid and alive(pid):
        os.kill(pid, signal.SIGTERM)
        for _ in range(60):
            if not alive(pid):
                break
            time.sleep(0.05)
        else:
            os.kill(pid, signal.SIGKILL)
    try:
        os.unlink(os.path.join(d, "pid"))
    except OSError:
        pass
    if reason:
        for name in os.listdir(d):
            if name.endswith(".log"):
                Log(os.path.join(d, name)).line("[capture] " + reason)


if __name__ == "__main__":
    action, d = sys.argv[1], sys.argv[2]
    if action == "start":
        start(d)
        print("serial-capture: " + (", ".join(p for _, p in ports()) or "none"))
    elif action == "stop":
        stop(d, " ".join(sys.argv[3:]))
    elif action == "dump":
        stop(d, "capture stopped at release")
        for name in sorted(os.listdir(d)):
            if name.endswith(".log"):
                sys.stdout.write("@@@HITL-SERIAL-FILE " + name + "\n")
                sys.stdout.write(open(os.path.join(d, name), encoding="utf-8", errors="replace").read())
        sys.stdout.flush()
'''
