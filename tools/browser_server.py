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
    curl 'host:8092/wsprobe?url=wss://10.59.111.165/ws'     # RAW host wss client (no browser/PNA)
    curl 'host:8092/wsrename?url=wss://10.59.111.165/ws&name=Foo'  # RAW rename round-trip

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
import base64
import json
import os
import socket
import ssl
import struct
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


# --- Raw TLS-WebSocket client (no browser) --------------------------------
# The headless browser can't reach a private-IP wss from a scriptable origin
# (Private Network Access + the player's 2-socket cap fighting the landing
# page). This host-side client dials the device directly with CERT_NONE — no
# browser policy in the way — and speaks the real ledmapper protocol, so it
# validates the wss:443 upgrade + hello/welcome + SetDeviceName end to end.


def _varint(n: int) -> bytes:
    out = bytearray()
    while n > 127:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


def _strf(field: int, s: str) -> bytes:
    b = s.encode()
    return _varint((field << 3) | 2) + _varint(len(b)) + b


def _msgf(field: int, inner: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(inner)) + inner


def _pb_hello() -> bytes:  # ClientMessage{hello=1: Hello{client=1, app_version=2}}
    return _msgf(1, _strf(1, "host-wsprobe") + _strf(2, "probe"))


def _pb_setname(name: str) -> bytes:  # ClientMessage{set_device_name=27: {name=1}}
    return _msgf(27, _strf(1, name))


def _pb_fields(buf: bytes) -> dict:
    out: dict = {}
    i = 0
    n = len(buf)

    def rv() -> int:
        nonlocal i
        sh = res = 0
        while True:
            b = buf[i]
            i += 1
            res |= (b & 0x7F) << sh
            sh += 7
            if not (b & 0x80):
                return res

    while i < n:
        tag = rv()
        field, wire = tag >> 3, tag & 7
        if wire == 2:
            ln = rv()
            v = buf[i:i + ln]
            i += ln
        elif wire == 0:
            v = rv()
        elif wire == 1:
            v = buf[i:i + 8]
            i += 8
        elif wire == 5:
            v = buf[i:i + 4]
            i += 4
        else:
            break
        out.setdefault(field, []).append(v)
    return out


def _welcome_name(frame: bytes):
    """(device_name, mac) if `frame` is a ServerMessage.welcome, else None."""
    sm = _pb_fields(frame)
    if 1 not in sm:  # ServerMessage.welcome = field 1
        return None
    w = _pb_fields(sm[1][0])
    name = w[5][0].decode() if 5 in w else ""  # Welcome.device_name = 5
    mac = w[4][0].decode() if 4 in w else ""    # Welcome.mac = 4
    return name, mac


def _wss_open(host: str, port: int, path: str, timeout: float,
              tls_max: str = "", use_sni: bool = True) -> ssl.SSLSocket:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    if tls_max == "12":  # pin TLS 1.2 (isolate a broken 1.3 path on the device)
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
    elif tls_max == "13":
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    raw = socket.create_connection((host, port), timeout=timeout)
    raw.settimeout(timeout)
    # On ANY failure (handshake timeout, no-101) close the socket so we send a
    # FIN and the device frees its slot immediately — otherwise a failed probe
    # leaks a client socket that keeps the device's half-open session alive,
    # cascading into more failures and confounding churn measurements.
    try:
        # Browsers omit SNI for an IP literal; Python sends it unless we pass None.
        s = ctx.wrap_socket(raw, server_hostname=(host if use_sni else None))
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                   f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = s.recv(1024)
            if not chunk:
                raise ConnectionError("closed during handshake")
            resp += chunk
        status = resp.split(b"\r\n", 1)[0].decode("latin1")
        if "101" not in status:
            raise ConnectionError(f"no upgrade (got: {status!r})")
        return s
    except BaseException:
        try:
            raw.close()
        except OSError:
            pass
        raise


def _ws_send(s: ssl.SSLSocket, payload: bytes) -> None:
    hdr = bytearray([0x82])  # FIN + binary
    n = len(payload)
    mask = os.urandom(4)
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126)
        hdr += struct.pack("!H", n)
    else:
        hdr.append(0x80 | 127)
        hdr += struct.pack("!Q", n)
    hdr += mask
    s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def _ws_recv(s: ssl.SSLSocket) -> bytes:
    def exact(n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            c = s.recv(n - len(buf))
            if not c:
                raise ConnectionError("closed")
            buf += c
        return buf

    b0, b1 = exact(2)
    ln = b1 & 0x7F
    if ln == 126:
        ln = struct.unpack("!H", exact(2))[0]
    elif ln == 127:
        ln = struct.unpack("!Q", exact(8))[0]
    return exact(ln)  # server frames are unmasked


def _ws_graceful_close(s: ssl.SSLSocket) -> None:
    """Close like a real client would — WS Close frame (opcode 0x8, masked,
    empty) then a TLS close_notify — so the device frees its session slot
    promptly. (An abrupt SSLSocket.close() sends neither, which can leave the
    player's max_open_sockets=2 cap occupied by a lingering half-open session.)"""
    try:
        s.sendall(bytes([0x88, 0x80]) + os.urandom(4))
    except OSError:
        pass
    try:
        s.unwrap()  # TLS close_notify
    except (OSError, ssl.SSLError):
        pass
    try:
        s.close()
    except OSError:
        pass


def _next_welcome(s: ssl.SSLSocket, tries: int = 6):
    for _ in range(tries):  # skip any non-welcome server frames
        nm = _welcome_name(_ws_recv(s))
        if nm is not None:
            return nm
    raise ConnectionError("no welcome frame")


def _parse_tls_server_flight(data: bytes) -> dict:
    """Walk a TLS 1.2 plaintext server flight into its handshake messages so a
    truncated/malformed ServerKeyExchange or a missing ServerHelloDone is
    visible (the suspected ECDSA-handshake deadlock)."""
    records, hs = [], bytearray()
    i = 0
    while i + 5 <= len(data):
        ct, ln = data[i], (data[i + 3] << 8) | data[i + 4]
        body = data[i + 5:i + 5 + ln]
        rec = {"type": ct, "len": ln, "complete": len(body) == ln}
        if ct == 21:  # alert
            rec["alert"] = list(body[:2])
        records.append(rec)
        if ct == 22:  # handshake
            hs += body
        i += 5 + ln
    names = {0: "HelloRequest", 2: "ServerHello", 11: "Certificate",
             12: "ServerKeyExchange", 13: "CertificateRequest",
             14: "ServerHelloDone"}
    msgs, j = [], 0
    while j + 4 <= len(hs):
        t = hs[j]
        ln = (hs[j + 1] << 16) | (hs[j + 2] << 8) | hs[j + 3]
        present = len(hs) - (j + 4)
        msgs.append({"name": names.get(t, str(t)), "declared_len": ln,
                     "bytes_present": min(ln, present), "truncated": present < ln})
        j += 4 + ln
    return {"raw_bytes": len(data), "records": records, "handshake_bytes": len(hs),
            "messages": msgs, "server_hello_done": any(m["name"] == "ServerHelloDone" for m in msgs)}


def ws_hs_capture(url: str, timeout_ms: float) -> dict:
    u = urllib.parse.urlparse(url)
    to = timeout_ms / 1000.0
    raw = socket.create_connection((u.hostname, u.port or 443), timeout=to)
    raw.settimeout(to)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.maximum_version = ssl.TLSVersion.TLSv1_2  # keep the flight plaintext
    inb, outb = ssl.MemoryBIO(), ssl.MemoryBIO()
    obj = ctx.wrap_bio(inb, outb, server_hostname=u.hostname)
    server = bytearray()
    done = stalled = False
    err = None
    try:
        while True:
            try:
                obj.do_handshake()
                done = True
                break
            except ssl.SSLWantReadError:
                pass
            except ssl.SSLError as e:
                err = str(e).splitlines()[0]
                break
            out = outb.read()
            if out:
                raw.sendall(out)
            try:
                chunk = raw.recv(4096)
            except socket.timeout:
                stalled = True
                break
            if not chunk:
                break
            server += chunk
            inb.write(chunk)
    finally:
        raw.close()
    return {"url": url, "handshake_complete": done, "stalled": stalled,
            "error": err, "tls": (obj.version() if done else "TLSv1.2-attempt"),
            **_parse_tls_server_flight(bytes(server))}


def ws_probe_raw(url: str, timeout_ms: float, tls_max: str = "",
                 use_sni: bool = True) -> dict:
    u = urllib.parse.urlparse(url)
    to = timeout_ms / 1000.0
    s = _wss_open(u.hostname, u.port or 443, u.path or "/ws", to, tls_max, use_sni)
    try:
        ver = s.version()
        _ws_send(s, _pb_hello())
        name, mac = _next_welcome(s)
        return {"url": url, "connected": True, "tls": ver,
                "device_name": name, "mac": mac}
    finally:
        _ws_graceful_close(s)


def ws_rename_raw(url: str, new_name: str, timeout_ms: float) -> dict:
    u = urllib.parse.urlparse(url)
    to = timeout_ms / 1000.0
    s = _wss_open(u.hostname, u.port or 443, u.path or "/ws", to)
    try:
        _ws_send(s, _pb_hello())
        before, mac = _next_welcome(s)
        _ws_send(s, _pb_setname(new_name))
        after, _ = _next_welcome(s)
        _ws_send(s, _pb_setname(before))       # restore original
        restored, _ = _next_welcome(s)
        return {"url": url, "new_name": new_name, "mac": mac, "before": before,
                "after": after, "restored": restored,
                "applied": after == new_name, "restored_ok": restored == before}
    finally:
        _ws_graceful_close(s)


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
            elif route == "/wsprobe":
                url = g("url")
                if not url:
                    self._json({"error": "missing ?url=wss://host/ws"}, 400)
                    return
                self._json(ws_probe_raw(url, int(g("timeout", "8000")),
                                        g("tls", ""), g("sni", "1") not in ("0", "false")))
            elif route == "/hscapture":
                url = g("url")
                if not url:
                    self._json({"error": "missing ?url=wss://host/ws"}, 400)
                    return
                self._json(ws_hs_capture(url, int(g("timeout", "8000"))))
            elif route == "/wsrename":
                url = g("url")
                name = g("name")
                if not url or not name:
                    self._json({"error": "need ?url=wss://host/ws&name=NewName"}, 400)
                    return
                self._json(ws_rename_raw(url, name, int(g("timeout", "10000"))))
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
