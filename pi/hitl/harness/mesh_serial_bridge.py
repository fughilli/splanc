"""Serial console bridge for the mesh spike — runs INSIDE a rig reservation container.

stdin lines -> the DUT's USB-serial console; every console line -> stdout, prefixed with
the container's monotonic ms ("<ms> <line>"). Opens the port WITHOUT resetting the C6
(RTS dropped before DTR, as serial_capture.py does), so a DUT keeps its
link and its running effect. Exits on stdin EOF or after --seconds.

    python3 mesh_serial_bridge.py [--port /dev/ttyACM0] [--seconds 900]
"""

from __future__ import annotations

import argparse
import sys
import threading
import time

import serial  # pyserial (present in every reservation container: hitl-monitor uses it)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--seconds", type=float, default=900.0)
    a = ap.parse_args()
    # Linux cdc-acm raises DTR+RTS together on open, which leaves the C6 running; then drop
    # RTS FIRST, then DTR (serial_capture.py): the other order passes through EN low = reset.
    s = None
    for _ in range(50):  # a just-reset C6 re-enumerates: wait for the port (10 s)
        try:
            s = serial.Serial(a.port, 115200, timeout=0.2)
            break
        except (OSError, serial.SerialException) as e:
            print(f"0 #bridge waiting for {a.port}: {e}", flush=True)
            time.sleep(0.2)
    if s is None:
        print("0 #bridge no port", flush=True)
        return 2
    s.rts = False
    s.dtr = False
    t0 = time.monotonic()
    stop = threading.Event()

    def reader() -> None:
        buf = b""
        while not stop.is_set():
            try:
                chunk = s.read(4096)
            except Exception as e:  # noqa: BLE001 — a re-enumerating port ends the bridge
                print(f"{int((time.monotonic() - t0) * 1000)} #bridge read error {e!r}", flush=True)
                stop.set()
                return
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                ms = int((time.monotonic() - t0) * 1000)
                print(f"{ms} {line.decode('utf-8', 'replace').rstrip()}", flush=True)

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    print("0 #bridge up", flush=True)

    def writer() -> None:
        for line in sys.stdin:
            s.write(line.rstrip("\n").encode() + b"\n")
            s.flush()
        stop.set()

    threading.Thread(target=writer, daemon=True).start()
    while not stop.is_set() and time.monotonic() - t0 < a.seconds:
        time.sleep(0.2)
    stop.set()
    s.close()
    print(f"{int((time.monotonic() - t0) * 1000)} #bridge down", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
