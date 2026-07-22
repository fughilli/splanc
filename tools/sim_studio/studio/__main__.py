"""Run the Sim Studio server.

    python -m studio [--host H] [--port P]

Open the printed URL in a browser. The front-end loads Three.js from a CDN, so
the browser needs internet access (the Python API is fully local).
"""

from __future__ import annotations

import argparse

import uvicorn
from studio.app import create_app


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="studio", description=__doc__)
    # Default to 0.0.0.0 so the claude-container port mapping (host 8090 →
    # container 8090) can reach it; inside the dev container this is only exposed
    # via that mapping, which is bound to the host's loopback.
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args(argv)

    app = create_app()
    print(
        f"Sim Studio bound on {args.host}:{args.port} — open http://localhost:{args.port}",
        flush=True,
    )
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
