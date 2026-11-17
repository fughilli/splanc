#!/usr/bin/env python3
"""Rig-side daemon for the channel-sounding bench (runs inside the hitl reservation env).

Holds the two C6 serial ports open (re-opening a USB-Serial-JTAG port can reset the chip)
and the HackRF, and executes JSON step lists sent over a localhost TCP socket, so a
multi-device sequence runs with rig-local timing instead of one ssh round trip per command.

Request (one JSON line): {"steps": [{"dev": "A", "cmd": "cap 4096 0"},
                                    {"sleep": 0.01},
                                    {"dev": "B", "cmd": "cw 0", "nowait": true},
                                    {"wait": "B"},
                                    {"sdr": {"freq": 2.44e9, "rate": 20e6, "n": 2000000,
                                             "lna": 16, "vga": 20}}]}
Reply (one JSON line): {"results": [...]} — per step: {"lines": [...]} for a device command
(text lines up to END; B64 payloads are passed through as strings), {"sdr_b64": ...} for an
SDR capture (int8 interleaved IQ, base64).
Stdlib + pyserial only (the env has no numpy in python3).
"""
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

import serial

SERIALS = {"A": "58:E6:C5:11:FC:B0", "B": "8C:FD:49:11:32:18"}


def find_port(usb_serial):
    """The /dev/ttyACM* whose USB serial matches (via sysfs); create the node if the
    container's /dev predates a re-enumeration (privileged env)."""
    import glob

    for t in sorted(glob.glob("/sys/class/tty/ttyACM*")):
        try:
            ser = open(os.path.join(t, "device", "..", "serial")).read().strip()
        except OSError:
            continue
        if ser.upper() == usb_serial.upper():
            name = os.path.basename(t)
            dev = "/dev/" + name
            if not os.path.exists(dev):
                maj, mnr = open(os.path.join(t, "dev")).read().strip().split(":")
                os.mknod(dev, 0o20666, os.makedev(int(maj), int(mnr)))
            return dev
    raise RuntimeError(f"no tty for {usb_serial}")


PORTS = {k: None for k in SERIALS}


class Dev:
    def __init__(self, name, port):
        self.name = name
        self.port = port
        self.s = serial.Serial()
        self.s.port = port
        self.s.baudrate = 921600
        self.s.timeout = 0.05
        # keep DTR/RTS deasserted across open: on the C6 USB-Serial-JTAG RTS=1,DTR=0 resets
        self.s.dtr = False
        self.s.rts = False
        self.s.open()
        self.buf = b""
        self.pending = None
        self.lock = threading.Lock()

    def send(self, cmd):
        self.s.reset_input_buffer()
        self.buf = b""
        self.s.write((cmd + "\n").encode())
        self.s.flush()

    def collect(self, timeout=10.0):
        lines = []
        t0 = time.time()
        while time.time() - t0 < timeout:
            chunk = self.s.read(65536)
            if chunk:
                self.buf += chunk
                while b"\n" in self.buf:
                    line, self.buf = self.buf.split(b"\n", 1)
                    t = line.decode(errors="replace").rstrip("\r")
                    if t == "END":
                        return lines
                    lines.append(t)
        lines.append("TIMEOUT")
        return lines


def sdr_capture(p):
    f = tempfile.mktemp(suffix=".iq", dir="/tmp")
    args = [
        "hackrf_transfer",
        "-r",
        f,
        "-f",
        str(int(p.get("freq", 2.44e9))),
        "-s",
        str(int(p.get("rate", 20e6))),
        "-n",
        str(int(p.get("n", 2000000))),
        "-l",
        str(int(p.get("lna", 16))),
        "-g",
        str(int(p.get("vga", 20))),
        "-a",
        str(int(p.get("amp", 0))),
    ]
    if p.get("bw"):
        args += ["-b", str(int(p["bw"]))]
    r = subprocess.run(args, capture_output=True, text=True, timeout=60)
    data = open(f, "rb").read() if os.path.exists(f) else b""
    try:
        os.remove(f)
    except OSError:
        pass
    return {"sdr_b64": base64.b64encode(data).decode(), "sdr_log": r.stderr[-400:]}


def sdr_start(p):
    """Background HackRF capture; returns a handle dict stored in STATE."""
    f = tempfile.mktemp(suffix=".iq", dir="/tmp")
    args = [
        "hackrf_transfer",
        "-r",
        f,
        "-f",
        str(int(p.get("freq", 2.44e9))),
        "-s",
        str(int(p.get("rate", 20e6))),
        "-n",
        str(int(p.get("n", 2000000))),
        "-l",
        str(int(p.get("lna", 16))),
        "-g",
        str(int(p.get("vga", 20))),
        "-a",
        str(int(p.get("amp", 0))),
    ]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    STATE["sdr"] = (proc, f)
    return {"sdr_started": True}


def sdr_finish():
    proc, f = STATE.pop("sdr")
    _, err = proc.communicate(timeout=60)
    data = open(f, "rb").read() if os.path.exists(f) else b""
    try:
        os.remove(f)
    except OSError:
        pass
    return {"sdr_b64": base64.b64encode(data).decode(), "sdr_log": err[-400:]}


STATE = {}
DEVS = {}


def run_steps(steps):
    out = []
    for st in steps:
        try:
            if "sleep" in st:
                time.sleep(st["sleep"])
                out.append({})
            elif "dev" in st:
                d = DEVS[st["dev"]]
                d.send(st["cmd"])
                if st.get("nowait"):
                    d.pending = st["cmd"]
                    out.append({"sent": True})
                else:
                    out.append({"lines": d.collect(st.get("timeout", 10.0))})
            elif "wait" in st:
                d = DEVS[st["wait"]]
                out.append({"lines": d.collect(st.get("timeout", 10.0))})
                d.pending = None
            elif "sdr" in st:
                out.append(sdr_capture(st["sdr"]))
            elif "sdr_start" in st:
                out.append(sdr_start(st["sdr_start"]))
            elif "sdr_finish" in st:
                out.append(sdr_finish())
            elif "raw_reset" in st:  # hardware-reset a DUT via RTS (boots the app again)
                k = st["raw_reset"]
                d = DEVS[k]
                d.s.close()  # never hold the port across the USB re-enumeration
                tmp = serial.Serial()
                tmp.port = d.port
                tmp.dtr = False
                tmp.rts = True
                tmp.open()
                time.sleep(0.1)
                tmp.rts = False
                tmp.close()
                time.sleep(st.get("boot_wait", 2.0))
                DEVS[k] = Dev(k, find_port(SERIALS[k]))
                out.append({"boot": "reopened " + DEVS[k].port})
            elif "reopen" in st:
                for k in SERIALS:
                    try:
                        DEVS[k].s.close()
                    except Exception:
                        pass
                    DEVS[k] = Dev(k, find_port(SERIALS[k]))
                out.append({"reopened": True})
            else:
                out.append({"error": "bad step"})
        except Exception as e:  # noqa: BLE001
            out.append({"error": repr(e)})
    return out


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7700
    for k in SERIALS:
        DEVS[k] = Dev(k, find_port(SERIALS[k]))
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(1)
    print(f"csd listening on {port}", flush=True)
    while True:
        c, _ = srv.accept()
        f = c.makefile("rwb")
        try:
            for line in f:
                req = json.loads(line)
                if req.get("quit"):
                    f.write(b'{"bye":1}\n')
                    f.flush()
                    return
                res = run_steps(req["steps"])
                f.write((json.dumps({"results": res}) + "\n").encode())
                f.flush()
        except Exception as e:  # noqa: BLE001
            print("conn error", e, flush=True)
        finally:
            c.close()


if __name__ == "__main__":
    main()
