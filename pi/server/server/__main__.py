"""Run the M2 server with uvicorn.

    python -m server [--host H] [--port P] [--web-root DIR]
                     [--session-dir DIR] [--maps-dir DIR] [--led-count N]

On the Pi this is launched as ``led-server.service`` (design doc §6 M4 /
pi/provisioning), binding :80 and serving the built web app from ``--web-root``.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from server.app import create_app
from server.codebook import DEFAULT_BIT_PERIOD_MS


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="server", description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=80)
    parser.add_argument("--web-root", type=Path, default=None, help="built web app to serve at /")
    parser.add_argument("--session-dir", type=Path, default=Path("/var/lib/ledmapper/sessions"))
    parser.add_argument("--maps-dir", type=Path, default=Path("/var/lib/ledmapper/maps"))
    parser.add_argument("--led-count", type=int, default=1024, help="default code-book LED count")
    parser.add_argument("--bit-period-ms", type=float, default=DEFAULT_BIT_PERIOD_MS)
    args = parser.parse_args(argv)

    app = create_app(
        session_dir=args.session_dir,
        maps_dir=args.maps_dir,
        web_root=args.web_root,
        default_led_count=args.led_count,
        bit_period_ms=args.bit_period_ms,
    )
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
