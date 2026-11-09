"""Records a wired Vive tracker through the ESP32-P4 (//firmware/p4/tracker:
esp32p4_tracker_dump) into lhd's .rec.gz format, for lh_replay / lh_protocheck.

    python3 tools/p4_dump_to_rec.py --port /dev/cu.usbmodem… --seconds 60 out.rec.gz

Resets the P4 so the recording starts with the device handshake (the feature
reads lh_replay needs), then keeps F/R lines (see usb_tracker.h) and echoes the
'#' lines.
"""

import argparse
import gzip
import sys
import time

import serial

IFACE = {0: "IMU", 1: "Lightcap", 2: "Buttons"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True)
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--name", default="T20", help="device name in the recording")
    ap.add_argument("out")
    a = ap.parse_args()

    s = serial.Serial(a.port, 115200, timeout=0.1)
    s.dtr = False
    s.rts = True
    time.sleep(0.1)
    s.rts = False
    # The image prints its banner at 115200, then switches to 2 Mbaud.
    t_end = time.time() + 5
    buf = b""
    while time.time() < t_end and b"raw dump at" not in buf:
        buf += s.read(256)
    sys.stdout.write(buf.decode("utf-8", "replace"))
    s.baudrate = 2000000

    t0 = None
    n = {"F": 0, "R": 0, "bad": 0}
    with gzip.open(a.out, "wt", compresslevel=3) as out:
        t_end = time.time() + a.seconds
        while time.time() < t_end:
            line = s.readline().decode("ascii", "replace").strip()
            if not line:
                continue
            p = line.split()
            try:
                if p[0] == "F" and len(p) == 5:
                    us = int(p[2])
                    t0 = us if t0 is None else t0
                    out.write(
                        f"{(us - t0) / 1e6:.6f} {a.name} HIDFEAT {p[1]} {us - t0} {p[3]} {p[4]}\n"
                    )
                    n["F"] += 1
                elif p[0] == "R" and len(p) == 4:
                    us = int(p[2])
                    t0 = us if t0 is None else t0
                    data = p[3]
                    out.write(
                        f"{(us - t0) / 1e6:.6f} {a.name} HIDIN {IFACE[int(p[1])]} {us - t0} {len(data) // 2} {data}\n"
                    )
                    n["R"] += 1
                elif line.startswith("#"):
                    print(line)
                else:
                    n["bad"] += 1
            except (ValueError, KeyError, IndexError):
                n["bad"] += 1
    print(f"{n['F']} feature exchanges, {n['R']} reports, {n['bad']} unparsed lines -> {a.out}")


if __name__ == "__main__":
    main()
