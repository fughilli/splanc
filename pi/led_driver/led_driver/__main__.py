"""Run the LED driver + control socket on the Pi.

    python -m led_driver [--socket PATH] [--bus N] [--device N] [--speed-hz HZ]
                         [--dry-run] [--start LED_COUNT]

On the Pi this is launched as ``led-driver.service`` (pi/provisioning), owning
the SPI bus and the control socket at ``/run/ledmapper/control.sock``. With
``--dry-run`` it uses an in-memory sink (no hardware) — useful under emulation or
for a wiring check with ``--start``.
"""

from __future__ import annotations

import argparse
import signal
import threading
from pathlib import Path

from led_driver.control import ControlServer
from led_driver.driver import LedDriver
from led_driver.graycode import default_code_params
from led_driver.spi import RecordingSink, SpidevSink


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="led_driver", description=__doc__)
    parser.add_argument("--socket", default="/run/ledmapper/control.sock", type=Path)
    parser.add_argument("--bus", type=int, default=0)
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--speed-hz", type=int, default=8_000_000)
    parser.add_argument("--brightness", type=int, default=31, help="global brightness 0..31")
    parser.add_argument("--dry-run", action="store_true", help="in-memory sink, no SPI hardware")
    parser.add_argument(
        "--start",
        type=int,
        default=None,
        metavar="LED_COUNT",
        help="immediately start a default cycle for LED_COUNT LEDs (debug)",
    )
    args = parser.parse_args(argv)

    sink = RecordingSink() if args.dry_run else SpidevSink(args.bus, args.device, args.speed_hz)
    driver = LedDriver(sink, brightness=args.brightness)
    server = ControlServer(driver, str(args.socket))
    server.start()
    print(f"led_driver listening on {args.socket} (dry-run={args.dry_run})", flush=True)

    if args.start is not None:
        epoch = driver.start(default_code_params(args.start))
        print(f"started cycle for {args.start} LEDs; patternClockEpoch={epoch:.1f} ms", flush=True)

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        stop.wait()
    finally:
        driver.stop()
        server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
