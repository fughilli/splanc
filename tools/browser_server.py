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
    curl 'host:8092/rename?url=wss://10.59.111.165/ws&name=Foo'  # rename round-trip (restores)

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


# In-page protocol round-trip: hello -> welcome(before) -> set_device_name(new)
# -> welcome(after) -> set_device_name(before) -> welcome(restored). Hand-encodes
# the (tiny) protobuf envelopes so we exercise the REAL wss control plane + the
# rename feature over a cert-trusting Chromium (launched with
# --ignore-certificate-errors so the self-signed player is reachable).
_RENAME = """
(url, newName, ms) => new Promise((resolve) => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const varint = (n) => { const b=[]; while(n>127){b.push((n&0x7f)|0x80); n=n>>>7;} b.push(n); return b; };
  const strF = (f,s) => { const by=enc.encode(s); return [...varint((f<<3)|2), ...varint(by.length), ...by]; };
  const msgF = (f,inner) => [...varint((f<<3)|2), ...varint(inner.length), ...inner];
  const hello = msgF(1, [...strF(1,'browser-probe'), ...strF(2,'probe')]);
  const rename = (name) => msgF(27, strF(1, name));
  const readMsg = (buf) => {
    const out={}; let i=0;
    const rv=()=>{let sh=0,r=0,b; do{b=buf[i++]; r|=(b&0x7f)<<sh; sh+=7;}while(b&0x80); return r>>>0;};
    while(i<buf.length){ const tag=rv(), f=tag>>>3, w=tag&7; let v;
      if(w===2){const L=rv(); v=buf.slice(i,i+L); i+=L;}
      else if(w===0){v=rv();} else if(w===1){i+=8;} else if(w===5){i+=4;} else break;
      (out[f]=out[f]||[]).push(v); }
    return out;
  };
  let ws, state='hello', before=null, after=null, mac='';
  const t=setTimeout(()=>{try{ws&&ws.close()}catch(e){} resolve({ok:false,error:'timeout',state,before,after})}, ms);
  try { ws=new WebSocket(url); } catch(e){ clearTimeout(t); return resolve({ok:false,error:'ctor '+e}); }
  ws.binaryType='arraybuffer';
  ws.onopen=()=>ws.send(new Uint8Array(hello));
  ws.onerror=()=>{ clearTimeout(t); resolve({ok:false,error:'ws error (see /cert — likely untrusted cert)',state}); };
  ws.onclose=(ev)=>{ clearTimeout(t); resolve({ok:false,error:'closed code '+ev.code,state,before,after}); };
  ws.onmessage=(ev)=>{
    const sm=readMsg(new Uint8Array(ev.data));
    if(!sm[1]) return;                     // only care about ServerMessage.welcome (field 1)
    const w=readMsg(sm[1][0]);
    const name=w[5]?dec.decode(w[5][0]):''; mac=w[4]?dec.decode(w[4][0]):'';
    if(state==='hello'){ before=name; state='renamed'; ws.send(new Uint8Array(rename(newName))); }
    else if(state==='renamed'){ after=name; state='restore'; ws.send(new Uint8Array(rename(before))); }
    else if(state==='restore'){ clearTimeout(t);
      resolve({ok:true, before, after, restored:name, mac, applied: after===newName, restored_ok: name===before});
      try{ws.close()}catch(e){} }
  };
}
"""


def _origin_of(ws_url: str) -> str:
    """https://host[:port]/ for a wss://host[:port]/path — the device's own
    origin. We navigate there before opening the socket so the WebSocket is
    SAME-ORIGIN and in a secure context: Chromium blocks a wss to a private IP
    (192.168.x) from an opaque about:blank origin (Private Network Access +
    mixed-context), which silently drops the connection before it ever dials."""
    u = urllib.parse.urlparse(ws_url)
    scheme = "https" if u.scheme in ("wss", "https") else "http"
    return f"{scheme}://{u.netloc}/"


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
            # Land on the device's own origin first so the socket is same-origin
            # + secure (see _origin_of). about:blank's opaque origin gets the wss
            # to a private IP silently dropped before it dials.
            nav = None
            try:
                page.goto(_origin_of(url), timeout=timeout_ms, wait_until="domcontentloaded")
            except Exception as e:
                nav = str(e).splitlines()[0]
            res = page.evaluate(_WS_PROBE, [url, timeout_ms])
            return {"url": url, "ignore_cert": ignore_cert, "nav_error": nav, **res}
        finally:
            browser.close()


def rename_dev(url: str, new_name: str, timeout_ms: int) -> dict:
    with _LOCK, _pw()() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        try:
            ctx = browser.new_context(ignore_https_errors=True)
            page = ctx.new_page()
            nav = None
            try:
                page.goto(_origin_of(url), timeout=timeout_ms, wait_until="domcontentloaded")
            except Exception as e:
                nav = str(e).splitlines()[0]
            res = page.evaluate(_RENAME, [url, new_name, timeout_ms])
            return {"url": url, "new_name": new_name, "nav_error": nav, **res}
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
            elif route == "/rename":
                url = g("url")
                name = g("name")
                if not url or not name:
                    self._json({"error": "need ?url=wss://host/ws&name=NewName"}, 400)
                    return
                self._json(rename_dev(url, name, int(g("timeout", "12000"))))
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
