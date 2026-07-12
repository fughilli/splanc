"""Self-signed TLS for phone testing (the capture APIs need a secure context).

The web app's capture path needs a secure origin: getUserMedia (camera) and
DeviceMotion (the inertial stream) are secure-context APIs, and the control
plane runs over WSS. In the field the Pi serves over its own AP and users can
flag the origin; on a dev laptop the practical path is HTTPS with a
self-signed certificate the user taps through once ("Advanced → Proceed").

`ensure_self_signed(dir)` generates a long-lived self-signed cert + key pair
into ``dir`` (once — subsequent runs reuse it, so the browser exception
sticks) by shelling out to ``openssl``, which is present on both the dev
container and the NixOS Pi image. No Python crypto dependency needed.

The certificate carries permissive SANs (localhost, common mDNS names); the
browser will warn regardless for a self-signed cert — the point is the secure
context after the user proceeds, not a clean padlock.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Tuple

_SAN = "DNS:localhost,DNS:ledmapper.local,IP:127.0.0.1"


def ensure_self_signed(cert_dir: Path) -> Tuple[Path, Path]:
    """Return ``(certfile, keyfile)`` under ``cert_dir``, generating them once."""
    cert_dir = Path(cert_dir)
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert, key = cert_dir / "cert.pem", cert_dir / "key.pem"
    if cert.is_file() and key.is_file():
        return cert, key
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "3650",
            "-nodes",
            "-subj",
            "/CN=ledmapper",
            "-addext",
            f"subjectAltName={_SAN}",
        ],
        check=True,
        capture_output=True,
    )
    return cert, key
