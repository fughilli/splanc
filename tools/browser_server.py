#!/usr/bin/env python3
"""Host-side headless-browser driver (Playwright/Chromium) so the container can
test the player's wss + self-signed-cert flow without a phone.

This covers the NON-Bluetooth half of the flow (the onboarding half goes through
ble_onboard_server.py — Web Bluetooth's native device chooser can't be
automated). It drives a real Chromium on the host, which shares the browser TLS
stack the phone uses, so a wss handshake that works here works there.

Run on the host:

    pip install playwright && playwright install chromium
    python3 tools/browser_server.py                 # binds 0.0.0.0:8092

Drive it from the container:

    curl 'host:8092/probe?url=wss://10.59.111.165/ws'   # does the wss OPEN?
    curl 'host:8092/cert?host=10.59.111.165'            # is the cert acceptable?
    curl 'host:8092/app?wss=wss://10.59.111.165/ws'     # load the hosted app, read status

  /probe  opens `new WebSocket(url)` from a cert-accepting context and reports
          whether it reaches OPEN (i.e. TLS handshake + WS upgrade succeed — the
          thing that was failing on OOM / bad cert). ?ignore_cert=0 to require a
          genuinely trusted cert instead.
  /cert   navigates to https://<host>/ WITHOUT ignoring cert errors and reports
          the outcome (loaded / the exact cert error) — the browser's verdict on
          the SAN cert.
  /app    loads the hosted app pointed at the player and reports the connection
          status pill text + a screenshot path.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CFG: dict = {}
_LOCK = threading.Lock()  # serialize Chromium launches (one at a time)

# In-page probe: resolve when the socket OPENs (or errors/closes/times out).
_WS_PROBE = """
(url, ms) => new Promise((resolve) => {
  let ws;
  const t = setTimeout(() => { try { ws && ws.close(); } catch (e) {} resolve({connected:false, error:'timeout'}); }, ms);
  try { ws = new WebSocket(url); } catch (e) { clearTimeout(t); return resolve({connected:false, error:'ctor: '+e}); }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { clearTimeout(t); resolve({connected:true}); try { ws.close(); } catch (e) {} };
  ws.onerror = () => { clearTimeout(t); resolve({connected:false, error:'ws error (see /cert — likely untrusted cert)'}); };
  ws.onclose = (ev) => { clearTimeout(t); resolve({connected:false, error:'closed code '+ev.code}); };
})
"""


def _log(msg: str) -> None:
    print(msg, flush=True)


def _pw():
    from playwright.sync_api import sync_playwright

    return sync_playwright


def probe_ws(url: str, timeout_ms: int, ignore_cert: bool) -> dict:
    with _LOCK, _pw()() as p:
        # `ignore_https_errors` (context) does NOT cover WebSocket TLS in
        # Chromium — the WS handshake still validates the cert. The
        # `--ignore-certificate-errors` LAUNCH flag does cover WS, so use it when
        # asked to ignore the (self-signed) cert for a raw wss OPEN probe.
        args = ["--ignore-certificate-errors"] if ignore_cert else []
        browser = p.chromium.launch(headless=True, args=args)
        try:
            ctx = browser.new_context(ignore_https_errors=ignore_cert)
            page = ctx.new_page()
            page.goto("about:blank")
            res = page.evaluate(_WS_PROBE, [url, timeout_ms])
            return {"url": url, "ignore_cert": ignore_cert, **res}
        finally:
            browser.close()


def check_cert(host: str, timeout_ms: int) -> dict:
    url = host if host.startswith("http") else f"https://{host}/"
    with _LOCK, _pw()() as p:
        browser = p.chromium.launch(headless=True)
        try:
            # No ignore_https_errors: we want the browser's real verdict.
            ctx = browser.new_context()
            page = ctx.new_page()
            try:
                resp = page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
                return {"url": url, "loaded": True,
                        "status": resp.status if resp else None,
                        "title": page.title()}
            except Exception as e:
                # Chromium raises with the net error (e.g. ERR_CERT_AUTHORITY_INVALID,
                # ERR_CERT_COMMON_NAME_INVALID) — exactly the cert verdict we want.
                return {"url": url, "loaded": False, "error": str(e).splitlines()[0]}
        finally:
            browser.close()


def load_app(app_url: str, wss: str, timeout_ms: int) -> dict:
    full = f"{app_url}{'&' if '?' in app_url else '?'}url={urllib.parse.quote(wss, safe='')}"
    shot = "/tmp/browser_server_app.png"
    with _LOCK, _pw()() as p:
        # Cover WebSocket TLS too (see probe_ws) so the app's wss to a self-signed
        # player connects headlessly.
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        try:
            ctx = browser.new_context(ignore_https_errors=True)
            page = ctx.new_page()
            page.goto(full, timeout=timeout_ms, wait_until="domcontentloaded")
            page.wait_for_timeout(6000)  # let it attempt the wss + clock sync
            status = None
            for sel in [".k-pill", "[data-state]", ".conn-status", ".pill"]:
                try:
                    el = page.query_selector(sel)
                    if el:
                        status = (el.get_attribute("data-state") or el.inner_text()).strip()
                        break
                except Exception:
                    pass
            page.screenshot(path=shot, full_page=False)
            return {"app": full, "status": status, "screenshot": shot}
        finally:
            browser.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "browser-driver/1.0"

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
        g = lambda k, d=None: q.get(k, [d])[0]
        route = u.path.rstrip("/") or "/"
        try:
            if route == "/":
                self._json({"usage": __doc__, "playwright": _pw_ok()})
            elif route == "/probe":
                url = g("url")
                if not url:
                    self._json({"error": "missing ?url=wss://host/ws"}, 400)
                    return
                self._json(probe_ws(url, int(g("timeout", "8000")),
                                    g("ignore_cert", "1") not in ("0", "false")))
            elif route == "/cert":
                host = g("host")
                if not host:
                    self._json({"error": "missing ?host="}, 400)
                    return
                self._json(check_cert(host, int(g("timeout", "15000"))))
            elif route == "/app":
                wss = g("wss")
                if not wss:
                    self._json({"error": "missing ?wss="}, 400)
                    return
                self._json(load_app(g("app", CFG["app"]), wss, int(g("timeout", "20000"))))
            else:
                self._json({"error": f"no such endpoint: {route}"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)


def _pw_ok() -> str:
    try:
        import playwright  # noqa: F401

        return "installed (run `playwright install chromium` if launch fails)"
    except ImportError:
        return "MISSING — run: pip install playwright && playwright install chromium"


def _lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Host headless-browser (Playwright) driver.")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8092)
    ap.add_argument("--app", default="https://ledmapper.pages.dev/",
                    help="hosted app base URL for /app")
    args = ap.parse_args()
    CFG.update(app=args.app)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    lan = _lan_ip() if args.host in ("0.0.0.0", "::") else args.host
    _log(f"browser-driver on http://{args.host}:{args.port}  (LAN: http://{lan}:{args.port})")
    _log(f"  playwright: {_pw_ok()}")
    _log(f"  app: {args.app}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
