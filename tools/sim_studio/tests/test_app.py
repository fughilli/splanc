"""Sim Studio HTTP layer: boot a real server, drive the API + static serving."""

import contextlib
import json
import math
import socket
import threading
import time
import urllib.error
import urllib.request

import uvicorn
from studio.app import create_app


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@contextlib.contextmanager
def _server(app, port):
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if not thread.is_alive():
                raise RuntimeError("server thread died")
            try:
                with urllib.request.urlopen(base + "/api/fixtures", timeout=1) as r:
                    if r.status == 200:
                        break
            except (urllib.error.URLError, OSError):
                time.sleep(0.1)
        else:
            raise RuntimeError("server never came up")
        yield base
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def _get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.status, r.read().decode()


def _post(url, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.loads(r.read().decode())


def test_full_studio_flow_over_http():
    port = _free_port()
    with _server(create_app(), port) as base:
        # fixtures + static index
        _, body = _get(base + "/api/fixtures")
        assert "cube" in json.loads(body)["fixtures"]
        code, html = _get(base + "/")
        assert code == 200 and "Sim Studio" in html

        # scene
        _, scene = _post(base + "/api/scene", {"fixture": "cube", "leds": 64, "scale": 1.5})
        assert scene["ledCount"] == 64
        c = scene["centroid"]
        r = scene["suggestedRadius"]
        span = scene["span"]

        # an arc of zero-noise captures
        views = 26
        arc = math.radians(170)
        for i in range(views):
            a = -arc / 2 + arc * (i / (views - 1))
            vert = span * 0.25 * math.cos(math.pi * (i / (views - 1) - 0.5))
            eye = [c[0] + r * math.sin(a), c[1] + vert, c[2] + r * math.cos(a)]
            _, cap = _post(base + "/api/capture", {"eye": eye, "target": c})
        assert cap["totalViews"] == views

        # solve → near-perfect recovery
        _, sol = _post(base + "/api/solve", {"minViews": 2, "minParallaxDeg": 5})
        assert sol["solvedCount"] >= int(0.9 * sol["ledCount"])
        assert sol["maxErrorM"] < 1e-3
        assert "leds" in sol["map"]

        # reset clears captures
        _, st = _post(base + "/api/reset", {})
        assert st["detections"] == 0

        # bad fixture → 400
        try:
            _post(base + "/api/scene", {"fixture": "nope", "leds": 8})
            assert False, "expected HTTPError"
        except urllib.error.HTTPError as e:
            assert e.code == 400
