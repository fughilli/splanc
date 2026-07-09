"""Run the M2 server with uvicorn.

    python -m server [--host H] [--port P] [--web-root DIR]
                     [--session-dir DIR] [--maps-dir DIR] [--led-count N]
                     [--ssl-dir DIR | --ssl-certfile F --ssl-keyfile F]

On the Pi this is launched as ``led-server.service`` (design doc §6 M4 /
pi/provisioning), binding :80 and serving the built web app from ``--web-root``.

For phone testing, serve HTTPS: WebXR needs a secure context, so either pass
``--ssl-dir`` (self-signed cert generated once into that directory) or a real
cert/key pair. The web app derives ws:// vs wss:// from the page protocol.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn
from server.app import create_app
from server.codebook import DEFAULT_BIT_PERIOD_MS
from server.tls import ensure_self_signed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="server", description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=80)
    parser.add_argument("--web-root", type=Path, default=None, help="built web app to serve at /")
    parser.add_argument(
        "--solver-dir",
        type=Path,
        default=None,
        help="wasm solver bundle (//solver:solver_wasm_pkg) to serve at /solver/ "
        "for the phone-side final solve",
    )
    parser.add_argument("--session-dir", type=Path, default=Path("/var/lib/ledmapper/sessions"))
    parser.add_argument("--maps-dir", type=Path, default=Path("/var/lib/ledmapper/maps"))
    parser.add_argument("--led-count", type=int, default=1024, help="default code-book LED count")
    parser.add_argument(
        "--bit-period-ms",
        type=float,
        default=DEFAULT_BIT_PERIOD_MS,
        help="FALLBACK bit period for clients that don't choose one; the phone "
        "normally negotiates the rate itself from its measured camera cadence "
        "(start_mapping options / mid-capture configure, §7.1)",
    )
    parser.add_argument(
        "--encoding",
        choices=["gray", "gray-hue"],
        default="gray",
        help="FALLBACK code carrier for clients that don't choose one: intensity "
        "blink ('gray') or constant-brightness color code ('gray-hue'). The "
        "phone normally measures the scene and picks the carrier itself in "
        "start_mapping options — no flag needed",
    )
    parser.add_argument(
        "--ssl-dir",
        type=Path,
        default=None,
        help="serve HTTPS with a self-signed cert kept in this directory "
        "(generated on first run; WebXR on the phone requires a secure context)",
    )
    parser.add_argument("--ssl-certfile", type=Path, default=None)
    parser.add_argument("--ssl-keyfile", type=Path, default=None)
    args = parser.parse_args(argv)

    certfile, keyfile = args.ssl_certfile, args.ssl_keyfile
    if args.ssl_dir is not None:
        if certfile or keyfile:
            parser.error("--ssl-dir and --ssl-certfile/--ssl-keyfile are mutually exclusive")
        certfile, keyfile = ensure_self_signed(args.ssl_dir)
    if bool(certfile) != bool(keyfile):
        parser.error("--ssl-certfile and --ssl-keyfile must be given together")

    app = create_app(
        session_dir=args.session_dir,
        maps_dir=args.maps_dir,
        web_root=args.web_root,
        solver_dir=args.solver_dir,
        default_led_count=args.led_count,
        bit_period_ms=args.bit_period_ms,
        encoding=args.encoding,
    )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        ssl_certfile=str(certfile) if certfile else None,
        ssl_keyfile=str(keyfile) if keyfile else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
