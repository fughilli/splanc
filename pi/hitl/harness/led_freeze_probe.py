#!/usr/bin/env python3
"""Rig-side probe for the LED-freeze regression (runs in the reservation, reads
/dev/ttyACM0). Prove the render loop keeps producing frames while the serial
console is NOT drained — the condition that froze the old blocking logger.

Read [fx] t=/frame= for a baseline, stop reading for GAP seconds (fills the host
buffer + device FIFO -> backpressure), then flush and read the LIVE frame. If t
advanced ~GAP and the ring dropped lines (proving the serial WAS backpressured),
render never stalled. Exits 0 on PASS, 1 on FAIL. Shipped + run by
//pi/hitl/harness:led_freeze.
"""
import re
import sys
import time

import serial

GAP = 40
fx = re.compile(rb"\[fx\] t=([\d.]+) frame=(\d+)")


def read_window(p, secs):
    end = time.time() + secs
    tmax = fmax = 0.0
    frames = []
    while time.time() < end:
        m = fx.search(p.readline())
        if m:
            tmax = max(tmax, float(m.group(1)))
            fv = int(m.group(2))
            fmax = max(fmax, fv)
            frames.append(fv)
    return tmax, int(fmax), frames


def main():
    # Open WITHOUT toggling DTR/RTS: a bare open resets the C6, which on a
    # freshly-flashed board can bounce it into the USB-download strap race and
    # kill the app (no [fx]). dtr/rts set before open() hold the lines steady.
    p = serial.Serial()
    p.port = "/dev/ttyACM0"
    p.baudrate = 115200
    p.timeout = 0.2
    p.dtr = False
    p.rts = False
    p.open()

    # Wait for the render loop to be producing frames (tolerate a just-flashed
    # board still settling / a reset from a prior monitor), up to ~25s.
    t1 = f1 = 0
    deadline = time.time() + 25
    while time.time() < deadline:
        p.reset_input_buffer()
        t1, f1, _ = read_window(p, 4)
        if f1 > 0:
            break
    print(f"BEFORE gap:  t={t1:.2f}s frame={f1}", flush=True)
    if f1 == 0:
        print("FAIL — no [fx] frames before the gap (render not running / no serial)", flush=True)
        return 1

    print(f"... NOT reading serial for {GAP}s (backpressure) ...", flush=True)
    time.sleep(GAP)

    p.reset_input_buffer()
    t2, f2, frames = read_window(p, 8)
    print(f"AFTER {GAP}s gap: t={t2:.2f}s frame={f2}", flush=True)

    dt = t2 - t1
    jumps = sum(1 for a, b in zip(frames, frames[1:]) if b - a > 3)
    print(
        f"render advance: dt={dt:.1f}s (expect ~{GAP}); dropped-log jumps during stall: {jumps}",
        flush=True,
    )
    # PASS requires render to have advanced through the gap AND evidence the ring
    # actually overflowed (dropped lines) so the stall was a real backpressure.
    ok = dt > GAP * 0.8 and jumps >= 1
    print(
        (
            "PASS — render kept running through the serial stall"
            if ok
            else "FAIL — render stalled while serial was backpressured"
        ),
        flush=True,
    )
    p.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
