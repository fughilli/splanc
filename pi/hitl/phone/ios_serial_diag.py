#!/usr/bin/env python3
"""Wired serial diagnostic for the netstack C6 on the Mac iOS bench.

Runs HOST-NATIVE on the Mac inside the reserved session (needs the nix pyEnv python
that has pyserial). Resolves the reserved C6's USB-Serial-JTAG port, asserts DTR so
the Arduino USBCDC actually transmits (a bare `cat` is DTR-gated and comes back empty),
optionally pulses a USB-JTAG reset to capture the boot `[scan]` dump, then sends the
wired `PROV <ssid> <pass>` line and captures the full association attempt so we can read
the EXACT stall + deauth reason code (scan-latch / assoc status / 4-way / GTK / DHCP).

Diagnostic only: it provisions over the wire (no BLE, no phone) and prints everything.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import serial  # pyserial (nix pyEnv)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serial_discovery  # noqa: E402


def _ts(t0: float) -> str:
    return f"[+{time.monotonic() - t0:6.2f}s] "


def usb_jtag_reset(sp: serial.Serial) -> None:
    """Best-effort ESP32 USB-Serial-JTAG reset via the CDC control lines (esptool's
    sequence). If the peripheral ignores it, we still capture the running firmware's
    response to PROV, so failure here is non-fatal."""
    try:
        sp.setRTS(False)
        sp.setDTR(False)
        time.sleep(0.1)
        sp.setDTR(True)
        sp.setRTS(False)
        time.sleep(0.1)
        sp.setRTS(True)
        sp.setDTR(False)
        sp.setRTS(True)
        time.sleep(0.1)
        sp.setDTR(False)
        sp.setRTS(False)
    except Exception as e:  # noqa: BLE001
        print(f"[diag] reset toggle failed (non-fatal): {e}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serial", default=os.environ.get("HITL_ADAPTER_SERIAL", ""))
    ap.add_argument("--fallback", default=os.environ.get("HITL_ESP_PORT", ""))
    ap.add_argument("--ssid", default="")
    ap.add_argument("--pass", dest="password", default="")
    ap.add_argument(
        "--monitor-only",
        action="store_true",
        help="capture serial only; do NOT send PROV (watch a phone BLE provision instead)",
    )
    ap.add_argument("--seconds", type=float, default=60.0, help="capture window after PROV")
    ap.add_argument("--warmup", type=float, default=6.0, help="pre-PROV read (catch boot scan)")
    ap.add_argument("--reset", action="store_true", help="pulse a USB-JTAG reset first")
    ap.add_argument("--baud", type=int, default=115200)
    args = ap.parse_args()
    if not args.monitor_only and not args.ssid:
        ap.error("--ssid is required unless --monitor-only")

    port = serial_discovery.select_port(args.serial or None, fallback=args.fallback or None).device
    print(f"[diag] C6 port = {port}", flush=True)

    # Assert DTR (USBCDC TX is gated on it); keep RTS low. Open non-exclusive.
    sp = serial.Serial()
    sp.port = port
    sp.baudrate = args.baud
    sp.timeout = 0.2
    sp.dtr = True
    sp.rts = False
    sp.open()
    try:
        sp.dtr = True
        sp.rts = False
    except Exception:  # noqa: BLE001
        pass

    t0 = time.monotonic()
    saw_any = False

    def pump(deadline: float) -> None:
        nonlocal saw_any
        buf = b""
        while time.monotonic() < deadline:
            chunk = sp.read(4096)
            if chunk:
                saw_any = True
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    sys.stdout.write(_ts(t0) + line.decode("utf-8", "replace") + "\n")
                    sys.stdout.flush()
        if buf:
            sys.stdout.write(_ts(t0) + buf.decode("utf-8", "replace") + "\n")
            sys.stdout.flush()

    if args.reset:
        print("[diag] pulsing USB-JTAG reset…", flush=True)
        usb_jtag_reset(sp)

    print(f"[diag] warmup read {args.warmup:g}s (boot/scan)…", flush=True)
    pump(time.monotonic() + args.warmup)
    if not saw_any:
        # DTR toggle kick in case the USBCDC hasn't flushed its connected state.
        print("[diag] no output yet — toggling DTR to kick USBCDC…", flush=True)
        try:
            sp.dtr = False
            time.sleep(0.2)
            sp.dtr = True
        except Exception:  # noqa: BLE001
            pass
        pump(time.monotonic() + 3.0)

    if args.monitor_only:
        print(f"[diag] MONITOR-ONLY: capturing {args.seconds:g}s (no PROV sent)…", flush=True)
    else:
        line = f"PROV {args.ssid} {args.password}\n"
        print(f"[diag] sending wired PROV (ssid={args.ssid!r})", flush=True)
        sp.write(line.encode("utf-8"))
        sp.flush()
        print(f"[diag] capturing association for {args.seconds:g}s…", flush=True)
    pump(time.monotonic() + args.seconds)
    print(f"[diag] done (saw_any_output={saw_any})", flush=True)
    sp.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
