#!/usr/bin/env python3
"""Host-side Improv-over-BLE onboarding driver — provisions the ESP32-C6 player
onto WiFi headlessly, so the phone (and its Web Bluetooth chooser, which nothing
can automate) is out of the loop for testing.

Web Bluetooth in a headless browser is a dead end: the device chooser is a
native OS dialog Playwright/CDP can't touch. So this speaks the Improv BLE
protocol directly with SimpleBLE (real adapter, CoreBluetooth on macOS), the
same protocol the firmware's improv_ble.cpp implements.

Run on the host (the machine with the Bluetooth radio):

    pip install simplepyble
    python3 tools/ble_onboard_server.py            # binds 0.0.0.0:8091

Drive it from the container:

    curl 'host:8091/scan?seconds=6'                       # list Improv devices
    curl -X POST 'host:8091/provision?ssid=BigVibes&pass=SECRET'   # onboard
    curl 'host:8091/provision?ssid=BigVibes&pass=SECRET&address=AA:BB:..'

`/provision` connects, subscribes to the result/error/state characteristics,
writes the WiFi-settings RPC, and waits for the device to join and report back
its redirect URL (or an error) — exactly the phone's onboarding step.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Improv WiFi BLE UUIDs — must match firmware/player_app/improv_ble.cpp.
SVC = "00467768-6228-2272-4663-277478268000"
CH_STATE = "00467768-6228-2272-4663-277478268001"
CH_ERROR = "00467768-6228-2272-4663-277478268002"
CH_RPC_CMD = "00467768-6228-2272-4663-277478268003"
CH_RPC_RESULT = "00467768-6228-2272-4663-277478268004"

CMD_WIFI_SETTINGS = 0x01
ERROR_NAMES = {
    0: "none",
    1: "invalid_rpc",
    2: "unknown_command",
    3: "unable_to_connect",
}

CFG: dict = {}
_BLE_LOCK = threading.Lock()  # one BLE operation at a time (single adapter)


def _log(msg: str) -> None:
    print(msg, flush=True)


def _adapter():
    import simplepyble

    adapters = simplepyble.Adapter.get_adapters()
    if not adapters:
        raise RuntimeError("no Bluetooth adapter (is BT on? Terminal granted BT permission?)")
    return adapters[0]


def _looks_like_player(name: str) -> bool:
    n = (name or "").lower()
    return "led widget" in n or "ledmapper" in n or "widget" in n


def _svc_uuids(p) -> list[str]:
    """Advertised/known service UUIDs for a scanned peripheral (best-effort)."""
    try:
        return [s.uuid().lower() for s in p.services()]
    except Exception:
        return []


def scan(seconds: float) -> list[dict]:
    with _BLE_LOCK:
        adapter = _adapter()
        adapter.scan_for(int(seconds * 1000))
        out = []
        for p in adapter.scan_get_results():
            try:
                name = p.identifier() or ""
                addr = p.address()
            except Exception:
                continue
            improv = SVC in _svc_uuids(p) or _looks_like_player(name)
            out.append(
                {
                    "name": name,
                    "address": addr,
                    "rssi": _try(lambda: p.rssi()),
                    "improv": improv,
                }
            )
        # Improv-looking devices first, then by RSSI.
        out.sort(key=lambda d: (not d["improv"], -(d["rssi"] or -999)))
        return out


def _try(fn):
    try:
        return fn()
    except Exception:
        return None


def _build_wifi_rpc(ssid: str, pw: str) -> bytes:
    data = bytes([len(ssid)]) + ssid.encode() + bytes([len(pw)]) + pw.encode()
    body = bytes([CMD_WIFI_SETTINGS, len(data)]) + data
    return body + bytes([sum(body) & 0xFF])


def _parse_result(buf: bytes) -> list[str]:
    """RPC result: [cmd, data_len, (len, str)*, checksum] -> list of strings."""
    if len(buf) < 3:
        return []
    data_len = buf[1]
    body = buf[2 : 2 + data_len]
    strings, i = [], 0
    while i < len(body):
        n = body[i]
        i += 1
        strings.append(body[i : i + n].decode("utf-8", "replace"))
        i += n
    return strings


def provision(ssid: str, pw: str, address: str | None, timeout: float) -> dict:
    import simplepyble  # noqa: F401 — ensure import error surfaces clearly

    with _BLE_LOCK:
        adapter = _adapter()
        adapter.scan_for(6000)
        target = None
        for p in adapter.scan_get_results():
            addr = _try(lambda: p.address())
            name = _try(lambda: p.identifier()) or ""
            if address and addr and addr.lower() == address.lower():
                target = p
                break
            if not address and (SVC in _svc_uuids(p) or _looks_like_player(name)):
                target = p
                break
        if target is None:
            return {"ok": False, "error": "no Improv device found in scan"}

        name = _try(lambda: target.identifier()) or "?"
        addr = _try(lambda: target.address()) or "?"
        _log(f"[ble] provisioning {name} ({addr}) -> ssid={ssid!r}")

        done = threading.Event()
        result: dict = {"urls": None, "error": None, "state": None}

        def on_result(data: bytes) -> None:
            result["urls"] = _parse_result(bytes(data))
            done.set()

        def on_error(data: bytes) -> None:
            code = data[0] if data else 0
            if code != 0:
                result["error"] = ERROR_NAMES.get(code, f"error {code}")
                done.set()

        def on_state(data: bytes) -> None:
            result["state"] = data[0] if data else None

        target.connect()
        try:
            # Subscribe BEFORE writing so the reply is never missed.
            target.notify(SVC, CH_RPC_RESULT, on_result)
            target.notify(SVC, CH_ERROR, on_error)
            try:
                target.notify(SVC, CH_STATE, on_state)
            except Exception:
                pass
            target.write_request(SVC, CH_RPC_CMD, _build_wifi_rpc(ssid, pw))
            got = done.wait(timeout)
        finally:
            _try(lambda: target.disconnect())

        if not got:
            return {
                "ok": False,
                "error": "timed out waiting for the player to join",
                "device": {"name": name, "address": addr},
            }
        if result["error"]:
            return {
                "ok": False,
                "error": result["error"],
                "device": {"name": name, "address": addr},
            }
        return {
            "ok": True,
            "urls": result["urls"],
            "state": result["state"],
            "device": {"name": name, "address": addr},
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "ble-onboard/1.0"

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def log_message(self, fmt: str, *a) -> None:
        _log("%s - %s" % (self.address_string(), fmt % a))

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _dispatch(self) -> None:
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        def g(k, d=None):
            return q.get(k, [d])[0]

        route = u.path.rstrip("/") or "/"
        try:
            if route == "/":
                self._json({"usage": __doc__, "ble": _ble_ok()})
            elif route == "/scan":
                self._json({"devices": scan(float(g("seconds", "6")))})
            elif route == "/provision":
                ssid, pw = g("ssid"), g("pass", "")
                if not ssid:
                    self._json({"ok": False, "error": "missing ?ssid="}, 400)
                    return
                self._json(provision(ssid, pw, g("address"), float(g("timeout", "60"))))
            else:
                self._json({"error": f"no such endpoint: {route}"}, 404)
        except Exception as e:  # noqa: BLE001 — report to the caller
            self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)


def _ble_ok() -> str:
    try:
        import simplepyble
    except ImportError:
        return "MISSING — run: pip install simplepyble"
    ver = getattr(simplepyble, "__version__", None) or "?"
    try:
        n = len(simplepyble.Adapter.get_adapters())
        return f"simplepyble {ver}, adapters={n}"
    except Exception as e:  # noqa: BLE001 — no adapter/permission on this host
        return f"simplepyble {ver}, adapter error: {e}"


def _lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Host Improv-BLE onboarding driver.")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8091)
    args = ap.parse_args()
    CFG.update(host=args.host, port=args.port)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    lan = _lan_ip() if args.host in ("0.0.0.0", "::") else args.host
    _log(f"ble-onboard on http://{args.host}:{args.port}  (LAN: http://{lan}:{args.port})")
    _log(f"  BLE: {_ble_ok()}")
    if args.host in ("0.0.0.0", "::"):
        _log("  NOTE: bound to all interfaces so the container can reach it.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
