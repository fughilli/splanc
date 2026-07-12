"""Capture trace server — receives the webapp's CV traces (?trace=) and writes
them to readable files for offline blooming/misclassification analysis.

    bazelisk run //tools:trace_server                 # http://0.0.0.0:8444
    bazelisk run //tools:trace_server -- --tls        # https (self-signed)
    bazelisk run //tools:trace_server -- --out /tmp/traces

The capture page (?trace=<this-server>/trace) POSTs batches of frames, each
with per-blob detector stats — the mean color the bloom washes toward gray,
the CHROMA-WEIGHTED halo color that survives it, peak luminance and the
saturated-pixel fraction — plus periodic color thumbnails. This writes:

    <out>/<session>/meta.json          the capture header (codeParams, UA, ...)
    <out>/<session>/frames.jsonl       one JSON line per frame (thumbs stripped)
    <out>/<session>/thumbs/<n>.png     decoded thumbnails (measure-pass frames)

CORS is wide open (the app is served from a different origin — pages.dev or
the container). From an https app origin, run with --tls and take the cert
exception once (browse to the server root); otherwise the POST is mixed
content and blocked, same as the player WS.
"""

from __future__ import annotations

import argparse
import base64
import json
import struct
import subprocess
import sys
import tempfile
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OUT_DIR = Path("traces")


def _png(width: int, height: int, rgb: bytes) -> bytes:
    """Minimal PNG (8-bit RGB, no interlace) from packed RGB rows — stdlib
    only (zlib), so the tool has no image-library dependency."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgb[y * width * 3 : (y + 1) * width * 3])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def _write_thumb(session_dir: Path, name: str, thumb: dict) -> None:
    """Decode a base64 RGBA thumbnail to an RGB PNG."""
    w, h = int(thumb["w"]), int(thumb["h"])
    rgba = base64.b64decode(thumb["rgbaB64"])
    if len(rgba) < w * h * 4:
        return
    rgb = bytearray(w * h * 3)
    for i in range(w * h):
        rgb[i * 3] = rgba[i * 4]
        rgb[i * 3 + 1] = rgba[i * 4 + 1]
        rgb[i * 3 + 2] = rgba[i * 4 + 2]
    thumbs = session_dir / "thumbs"
    thumbs.mkdir(exist_ok=True)
    (thumbs / f"{name}.png").write_bytes(_png(w, h, bytes(rgb)))


class Handler(BaseHTTPRequestHandler):
    server_version = "ledmapper-trace/1"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")

    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server API)
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        sessions = sorted(p.name for p in OUT_DIR.glob("*") if p.is_dir())
        body = (
            "ledmapper trace server\n\nsessions:\n"
            + ("\n".join(f"  {s}" for s in sessions) or "  (none yet)")
            + f"\n\nwriting under: {OUT_DIR.resolve()}\n"
        ).encode()
        self.send_response(200)
        self._cors()
        self.send_header("content-type", "text/plain")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_response(400)
            self._cors()
            self.end_headers()
            return

        header = payload.get("header")
        frames = payload.get("frames", [])
        # Session id: from the header when present (first batch), else the
        # most recent session that received frames.
        global _last_session
        if header:
            _last_session = str(header.get("sessionId", "unknown"))
            session_dir = OUT_DIR / _last_session
            session_dir.mkdir(parents=True, exist_ok=True)
            (session_dir / "meta.json").write_text(json.dumps(header, indent=2))
            print(f"[trace] new session {_last_session}: {header.get('userAgent', '')}")
        session_dir = OUT_DIR / (_last_session or "unknown")
        session_dir.mkdir(parents=True, exist_ok=True)

        n_blobs = 0
        n_sat = 0
        with (session_dir / "frames.jsonl").open("a") as f:
            for frame in frames:
                thumb = frame.pop("thumb", None)
                if thumb:
                    _write_thumb(session_dir, f"{frame.get('t', 0):.0f}", thumb)
                    frame["thumb"] = f"thumbs/{frame.get('t', 0):.0f}.png"
                for b in frame.get("blobs", []):
                    n_blobs += 1
                    if b.get("satFrac", 0) > 0.1:
                        n_sat += 1
                f.write(json.dumps(frame) + "\n")

        if frames:
            print(
                f"[trace] {_last_session}: +{len(frames)} frames, "
                f"{n_blobs} blobs ({n_sat} with >10% saturation)"
            )
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, *_args) -> None:  # quiet the default access log
        pass


_last_session: str | None = None


def _self_signed() -> tuple[str, str]:
    """cert+key pair via openssl (present on the dev container + Pi image);
    no Python crypto dependency. Regenerated per run (dev tool)."""
    d = Path(tempfile.mkdtemp(prefix="trace-tls-"))
    cert, key = d / "cert.pem", d / "key.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "365",
            "-subj", "/CN=ledmapper-trace",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    return str(cert), str(key)


def main() -> int:
    global OUT_DIR
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8444)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--tls", action="store_true", help="serve https (self-signed)")
    args = ap.parse_args()

    OUT_DIR = args.out
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    scheme = "http"
    if args.tls:
        import ssl

        cert, key = _self_signed()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    stamp = datetime.now(timezone.utc).isoformat()
    print(f"[trace] {stamp} listening on {scheme}://{args.host}:{args.port}")
    print(f"[trace] point the capture page at: ?trace={scheme}://<this-host>:{args.port}/trace")
    print(f"[trace] writing traces under: {OUT_DIR.resolve()}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[trace] shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
