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
import html
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import segno

DEFAULT_APP_URL = "https://ledmapper.pages.dev"


def _log(msg: str) -> None:
    # bazel run pipes stdout, so force a flush or nothing shows live.
    print(msg, flush=True)


def _lan_ip() -> str:
    """The primary outbound-interface IP (the address the phone reaches us
    at), found by asking the routing table which source a UDP socket to a
    public IP would use — no packet is sent."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# Default under the source workspace (so dumps are readable + survive), not
# the bazel runfiles sandbox. BUILD_WORKSPACE_DIRECTORY is set by `bazel run`.
_WS = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
OUT_DIR = Path(_WS) / "traces" if _WS else Path("traces")


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
        # The CORS preflight is the FIRST contact from the capture page — log
        # it so the user sees the phone reached the server (cert trusted, CORS
        # negotiated) even before any frames flush.
        _log(f"[trace] preflight from {self.client_address[0]} — phone can reach the server")
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        # /go is the QR target: the PHONE lands here (a top-level navigation to
        # THIS origin), which is what lets it accept the self-signed cert —
        # without which the later cross-origin trace POSTs are silently
        # blocked. It then bounces to the app with ?trace= filled.
        if path == "/go":
            _log(f"[trace] /go from {self.client_address[0]} — cert accepted, bouncing to the app")
            body = _bounce_html().encode()
        else:
            _log(f"[trace] GET {path} from {self.client_address[0]}")
            sessions = sorted(p.name for p in OUT_DIR.glob("*") if p.is_dir())
            body = _landing_html(sessions).encode()
        self.send_response(200)
        self._cors()
        self.send_header("content-type", "text/html; charset=utf-8")
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
            _log(f"[trace] new session {_last_session}: {header.get('userAgent', '')}")
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
            _log(
                f"[trace] {_last_session}: +{len(frames)} frames, "
                f"{n_blobs} blobs ({n_sat} with >10% saturation)"
            )
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, *_args) -> None:  # quiet the default access log
        pass


_last_session: str | None = None
# Pairing state, set in main(): the app URL with ?trace= filled (PAIR_URL),
# the trace POST endpoint (TRACE_URL), and the /go bounce URL the QR encodes
# (GO_URL — points at THIS server so the phone accepts the cert first).
PAIR_URL = ""
TRACE_URL = ""
GO_URL = ""

_PAGE_STYLE = """
  body { font: 15px/1.5 system-ui, sans-serif; background:#fff; color:#111;
         display:grid; place-items:center; min-height:100vh; margin:0; }
  main { max-width:30rem; padding:1.5rem; text-align:center; }
  img.qr { width:min(70vw,320px); height:auto; image-rendering:pixelated; }
  a.button { display:inline-block; margin-top:1rem; padding:.7rem 1.4rem;
             border-radius:.5rem; background:#2a6; color:#fff;
             text-decoration:none; font-weight:600; }
  code { background:#f0f0f0; padding:.1em .3em; border-radius:.2em;
         word-break:break-all; font-size:.85em; }
  .muted { color:#666; font-size:.85rem; }
  ul { text-align:left; }
"""


def _bounce_html() -> str:
    """Served at /go — the QR target. Loading it (a top-level navigation to
    THIS origin) is what lets the phone accept the self-signed cert; it then
    redirects to the capture app with ?trace= filled, so the later
    cross-origin trace POSTs reuse the stored cert exception."""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LED Mapper trace</title>
<style>{_PAGE_STYLE}</style>
<script>
  var target = {json.dumps(PAIR_URL)};
  setTimeout(function () {{ location.replace(target); }}, 800);
</script></head>
<body><main>
  <h1>Trace server trusted</h1>
  <p>Opening the capture app… then set up the player over Bluetooth.</p>
  <a class="button" href="{html.escape(PAIR_URL)}">Open the app</a>
</main></body></html>"""


def _landing_html(sessions: list[str]) -> str:
    """The pairing page (shown on the LAPTOP): a QR encoding the /go bounce on
    this server — scan it with the phone to accept the cert AND open the app
    pointed at this trace server. Plus live session status."""
    qr = segno.make(GO_URL, error="m")
    qr_img = qr.png_data_uri(scale=6, border=3, dark="#111", light="#fff")
    session_list = "".join(f"<li>{html.escape(s)}</li>" for s in sessions) or "<li>(none yet)</li>"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LED Mapper trace server</title>
<style>{_PAGE_STYLE}</style></head>
<body><main>
  <h1>Scan to start a traced capture</h1>
  <p>Scan with the phone camera. It opens THIS server first (accept the
     certificate warning — "Advanced &rarr; Proceed"), which then bounces to
     the capture app with tracing on. Accepting the cert here is what lets the
     trace POSTs through.</p>
  <img class="qr" src="{qr_img}" alt="pairing QR">
  <p class="muted">QR &rarr; <code>{html.escape(GO_URL)}</code><br>
     then &rarr; <code>{html.escape(PAIR_URL)}</code></p>
  <p class="muted">After the app opens, set up the player over Bluetooth (the
     <code>?url=</code> it adds is kept across the trace param).</p>
  <h2 style="font-size:1rem">Sessions received</h2>
  <ul>{session_list}</ul>
</main></body></html>"""


def _self_signed(lan_ip: str) -> tuple[str, str]:
    """cert+key pair via openssl (present on the dev container + Pi image);
    no Python crypto dependency. Names the LAN IP in the SAN so the browser's
    warning is just "self-signed" (not also a hostname mismatch)."""
    d = Path(tempfile.mkdtemp(prefix="trace-tls-"))
    cert, key = d / "cert.pem", d / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "365",
            "-subj",
            "/CN=ledmapper-trace",
            "-addext",
            f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{lan_ip}",
        ],
        check=True,
        capture_output=True,
    )
    return str(cert), str(key)


def main() -> int:
    global OUT_DIR, PAIR_URL, TRACE_URL, GO_URL
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8444)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--tls", action="store_true", help="serve https (self-signed)")
    ap.add_argument(
        "--app-url",
        default=DEFAULT_APP_URL,
        help=f"capture app origin the QR points at (default {DEFAULT_APP_URL})",
    )
    ap.add_argument(
        "--host-ip",
        default=None,
        help="the address the phone reaches this server at (default: auto-detected LAN IP)",
    )
    args = ap.parse_args()

    OUT_DIR = args.out
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    host_ip = args.host_ip or _lan_ip()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    scheme = "http"
    if args.tls:
        import ssl

        cert, key = _self_signed(host_ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    TRACE_URL = f"{scheme}://{host_ip}:{args.port}/trace"
    PAIR_URL = f"{args.app_url.rstrip('/')}/?trace={urllib.parse.quote(TRACE_URL, safe='')}"
    GO_URL = f"{scheme}://{host_ip}:{args.port}/go"

    stamp = datetime.now(timezone.utc).isoformat()
    _log(f"[trace] {stamp} listening on {scheme}://{args.host}:{args.port}")
    _log(f"[trace] OPEN THIS ON THE LAPTOP for the pairing QR: {scheme}://{host_ip}:{args.port}/")
    _log("[trace]   scan it with the phone: it accepts this server's cert, then")
    _log("[trace]   bounces to the app with tracing on (then do BLE player setup)")
    _log(f"[trace] trace endpoint: {TRACE_URL}")
    _log(f"[trace] writing traces under: {OUT_DIR.resolve()}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("\n[trace] shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
