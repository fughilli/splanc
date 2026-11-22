"""The real app drives real C6s through the mesh flow (mesh M6/M7 app side, PR #613).

The web app (the //web:ios_payload bundle: the vite build plus the effect compiler's wasm)
runs in headless Chromium (Playwright). It reaches hitl-rig-1's three C6 DUTs over wss
through the rig (an ssh -L forward per DUT, the path every HITL wss client uses), each
saved in the app as its own fixture (`wss://dut-<x>.localhost:<port>/ws`). Every step is
a real tap in the real UI; the harness reads only the DUTs' serial consoles (the
non-resetting bridge), never a second wss to a fixture the app holds (a fixture takes one
wss client).

  setup        reserve, flash :esp32c6_netstack_meshdev, PROV onto the rig AP, map + effect
  create       Device ▸ Mesh ▸ "Create a mesh": intro, pick a+b+c, name, set up (each is
               provisioned by the app), joined; the browser-signed grant unlocks a
               (`[mesh] unlock ... -> ok`), b and c sync the session
  control      "Control the whole mesh" on
  effect       a new effect with uniforms (~2 KB fxb) typed into the editor and pushed:
               every DUT loads it on one frame (AP-beacon clock); the Mesh section's
               "Last change sent to the mesh" lists all three as reached
  slider       a uniform slider dragged: live moves go on arrival; the value let go is
               committed and lands on one frame on every DUT
  brightness   Color correction ▸ Output level: every DUT applies it on one frame
  eject        member c ▸ Remove from mesh; c leaves
  readd        "Add a fixture to this mesh" ▸ c: provisioned again, joins, catches up
  reboot       b resets (DUT only): it rejoins and catches up
  reload       the page reloads: the app unlocks its new connection by itself
  final        one more brightness change: all three, one frame
  leave        MESH LEAVE on every DUT (the rig as found)

Screenshots of every screen at phone and desktop widths go to --shots; each is also run
through the layout guard (no crammed buttons). Every `[late]` frame on every DUT during
the run is reported with its cause. Writes results.json + results.md; exit 0 iff
mesh_app_e2e_core.verdict passes.

    bazel run //pi/hitl/harness:mesh_app_e2e -- --server http://<rig>:8087 \\
        --units c6-123170 c6-711130 c6-711f48 --out /tmp/mesh_app_e2e
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path

from hitl_client import Reservation
from hitl_mesh_apply_at_skew import TimeDut
from hitl_mesh_smoke import _load_effect, _wait_lease
from hitl_mesh_spike import _flash, _runfile
from mesh_app_e2e_core import (
    app_requests,
    client_arms,
    fx_same_frame,
    late_report,
    late_summary,
    mt_same_frame,
    unlocks,
    verdict,
)
from mesh_effect_core import scenes
from mesh_join_admin_core import membership
from mesh_smoke_core import is_reset
from provision import ble_advertising

_HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = "abc"
DESKTOP = {"width": 1280, "height": 800}
PHONE = {"width": 390, "height": 844}


def _log(msg: str) -> None:
    print(f"[mesh_app_e2e] {msg}", flush=True)


def _layout():
    """The layout guard (tools/ui_layout): its static server, seed and checks."""
    import importlib

    try:
        return importlib.import_module("layout_guard")
    except ImportError:
        sys.path.insert(0, os.path.join(_HERE, "..", "..", "..", "tools", "ui_layout"))
        return importlib.import_module("layout_guard")


def _chromium(p):
    try:
        return p.chromium.launch(headless=True)
    except Exception:  # noqa: BLE001 - first run: fetch the browser
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            env=dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path)),
            check=False,
        )
        return p.chromium.launch(headless=True)


class App:
    """The app in one Chromium page: taps, waits and screenshots (both widths)."""

    def __init__(self, page, shots: Path, out: str, lg) -> None:
        self.page = page
        self.shots = shots
        self.lg = lg
        self.n = 0
        self.layout: dict[str, list[str]] = {}
        self.frames: list[tuple[float, str, str, int, str]] = []
        self.console = open(os.path.join(out, "browser-console.log"), "w", encoding="utf-8")
        page.on("console", lambda m: self._con(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: self._con(f"PAGEERROR: {e}"))
        page.on("websocket", self._ws)

    def _ws(self, ws) -> None:
        """Every wss the app opens (to which fixture, when, how it ended): the log a
        failed connect is debugged from."""
        n = {"tx": 0, "rx": 0}
        self._con(f"WS open {ws.url}")

        def frame(kind: str, payload) -> None:
            n[kind] += 1
            b = payload if isinstance(payload, (bytes, bytearray)) else str(payload).encode()
            self.frames.append(
                (time.monotonic(), ws.url, kind, len(b), bytes(b[:12] if len(b) > 300 else b).hex())
            )
            if n[kind] <= 3:
                self._con(f"WS {kind} {ws.url} #{n[kind]} {len(payload)} B")

        ws.on("framesent", lambda p: frame("tx", p))
        ws.on("framereceived", lambda p: frame("rx", p))
        ws.on("socketerror", lambda e: self._con(f"WS error {ws.url}: {e}"))
        ws.on("close", lambda _w: self._con(f"WS close {ws.url} tx={n['tx']} rx={n['rx']}"))

    def _con(self, s: str) -> None:
        self.console.write(f"{time.strftime('%H:%M:%S')} {s}\n")
        self.console.flush()

    def shot(self, name: str) -> None:
        """`NN-name-{desktop,phone}.png`, each checked by the layout guard."""
        self.n += 1
        base = f"{self.n:02d}-{name}"
        for vname, vp in (("desktop", DESKTOP), ("phone", PHONE)):
            self.page.set_viewport_size(vp)
            self.page.wait_for_timeout(500)
            try:
                root = self.page.evaluate(
                    "() => { document.querySelectorAll('[data-e2e-top]').forEach(e =>"
                    " e.removeAttribute('data-e2e-top'));"
                    " const c = document.querySelectorAll('.k-confirm, .k-sheet');"
                    " if (!c.length) return '.shell-outlet';"
                    " c[c.length - 1].setAttribute('data-e2e-top', '1'); return '[data-e2e-top]'; }"
                )
                v, _ = self.lg.check_page(self.page, root)
                if v:
                    self.layout[f"{base}-{vname}"] = [str(x) for x in v]
            except Exception as e:  # noqa: BLE001
                self.layout[f"{base}-{vname}"] = [f"check failed: {e!r}"]
            self.lg.shoot(self.page, self.shots / f"{base}-{vname}.png", vp)
        self.page.set_viewport_size(DESKTOP)
        self.page.wait_for_timeout(300)
        _log(f"shot {base}")

    def click(self, sel: str, timeout: float = 10_000) -> None:
        self.page.locator(sel).first.click(timeout=timeout)
        self.page.wait_for_timeout(300)

    def wait(self, sel: str, timeout: float = 15_000) -> None:
        self.page.locator(sel).first.wait_for(state="visible", timeout=timeout)

    def visible(self, sel: str) -> bool:
        try:
            return self.page.locator(sel).first.is_visible()
        except Exception:  # noqa: BLE001
            return False

    def text(self, sel: str) -> str:
        try:
            return self.page.locator(sel).first.inner_text(timeout=3000)
        except Exception:  # noqa: BLE001
            return ""

    def go(self, route: str) -> None:
        self.page.evaluate(f"location.hash = {json.dumps(route)}")
        self.page.wait_for_timeout(1500)

    def devices(self) -> list[dict]:
        return json.loads(
            self.page.evaluate("localStorage.getItem('ledmapper.devices') || '[]'") or "[]"
        )

    def close_sheets(self) -> None:
        for _ in range(4):
            close = self.page.locator(".k-sheet .k-sheet-head button[title='Close']")
            if close.count() == 0:
                return
            try:
                close.last.click(timeout=3000)  # the top sheet's ×
            except Exception:  # noqa: BLE001
                self.page.keyboard.press("Escape")
            self.page.wait_for_timeout(500)

    def open_device_sheet(self) -> None:
        self.close_sheets()
        if not self.visible(".tab:has-text('Device')"):
            self.go("#/maps")  # full-screen screens (the editor) hide the tab bar
        self.click(".tab:has-text('Device')")
        # Devices ▸ the connected fixture's ⋮ (Options): its detail sheet, Mesh section.
        row = ".device-row:has(.device-dot[data-state='connected'])"
        self.wait(row, 20_000)
        self.click(f"{row} button[title='Options'], {row} button[aria-label='Options']")
        self.wait(".mesh-section:not([hidden])", 20_000)
        self.page.locator(".mesh-section").first.scroll_into_view_if_needed(timeout=3000)
        self.page.wait_for_timeout(800)

    def set_range(self, sel: str, value: float, release: bool = True) -> None:
        """Move a range input to `value` (an input event, as a drag does; with `release`
        also the change event of letting go)."""
        self.page.locator(sel).first.evaluate(
            "(el, [v, up]) => { el.value = String(v);"
            " el.dispatchEvent(new Event('input', {bubbles: true}));"
            " if (up) el.dispatchEvent(new Event('change', {bubbles: true})); }",
            [value, release],
        )

    def last_change(self) -> dict:
        """The Mesh section's "Last change sent to the mesh": its line and rows."""
        return self.page.evaluate(
            "() => { const b = document.querySelector('.mesh-last'); if (!b) return null;"
            " return { line: (b.querySelector('.mesh-last-line')||{}).textContent || '',"
            " rows: [...b.querySelectorAll('.mesh-last-row')].map(r => ({"
            "  name: (r.querySelector('.mesh-last-name')||{}).textContent || '',"
            "  text: (r.querySelector('.mesh-member-detail')||{}).textContent || '',"
            "  ok: !r.classList.contains('mesh-last-row--bad') })) }; }"
        ) or {"line": "", "rows": []}


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    shots = Path(args.shots or os.path.join(args.out, "shots"))
    shots.mkdir(parents=True, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"
    bundle = _runfile(args.bundle)
    web = Path(_runfile(args.web))
    with open(_runfile(args.fxb), "rb") as fh:
        tint = fh.read()
    with open(_runfile(args.effect_src), encoding="utf-8") as fh:
        effect_src = fh.read()
    lg = _layout()
    try:
        with open(_runfile(args.proto), encoding="utf-8") as fh:
            arms = client_arms(fh.read())
    except OSError:
        arms = {}
    shipped = [os.path.join(_HERE, "mesh_serial_bridge.py")]
    record: dict = {"args": dict(vars(args)), "units": {}, "steps": {}, "late": []}
    duts: list[TimeDut] = []
    t_start = time.time()
    extra_lines: dict[str, list[tuple[str, list[str]]]] = {}
    ui: list[App] = []

    @contextmanager
    def step(name: str):
        marks = {d.label: d.mark() for d in duts}
        t0 = time.monotonic()
        s = record["steps"].setdefault(name, {"ok": False})
        _log(f"step {name}")
        try:
            yield s
        except Exception as e:  # noqa: BLE001
            s["ok"] = False
            s["fail"] = f"{type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ''}"
            _log(f"{name}: FAILED {s['fail']}")
            if ui:  # what the app showed when the step failed
                try:
                    ui[0].page.screenshot(path=os.path.join(args.out, f"fail-{name}.png"))
                    s["screen_text"] = ui[0].page.evaluate(
                        "() => document.body.innerText.slice(0, 1500)"
                    )
                except Exception:  # noqa: BLE001
                    pass
        s["seconds"] = round(time.monotonic() - t0, 1)
        for d in duts:
            ls = d.since(marks[d.label])
            s.setdefault("resets", {})[d.label] = sum(1 for t in ls if is_reset(t))
            for x in late_report(name, d.label, ls):
                # When it happened (host clock: the line's arrival less its ago_ms) and
                # what the app sent or got from this fixture right then.
                t_line = d.lines[marks[d.label] + x["line"]][0]
                ago = next(
                    (int(v) for k, v in re.findall(r"(\w+)=(\d+)", ls[x["line"]]) if k == "ago_ms"),
                    0,
                )
                t = t_line - ago / 1000.0
                if ui:
                    host = f"dut-{d.label}."
                    near = [
                        (round((ft - t) * 1000), k, n, h)
                        for ft, u, k, n, h in ui[0].frames
                        if host in u and -0.4 <= ft - t <= 0.15
                    ]
                    x["app_frames"] = [f"{dt}ms {k} {n}B {h[:24]}" for dt, k, n, h in near]
                    x["app_requests"] = app_requests(near, arms)
                    if x["cause"] == "unattributed" and x["app_requests"]:
                        # Something the app asked for, handled on the player's lock.
                        x["cause"] = "app_request"
                record["late"].append(x)
            for tag, extra in extra_lines.pop(d.label, []):
                record["late"].extend(late_report(f"{name}:{tag}", d.label, extra))
        _log(f"{name}: {json.dumps(s, default=str)[:1500]}")

    def wait_line(d: TimeDut, pattern: str, since: int, timeout: float) -> str | None:
        try:
            return d.wait_raw(pattern, timeout, since)
        except TimeoutError:
            return None

    def info(d: TimeDut) -> dict:
        m = d.mark()
        d.send("MESH INFO")
        if not wait_line(d, r"\[mesh\] infoend", m, 8.0):
            return {}
        return membership(d.since(m))

    with ExitStack() as stack:
        units = args.units or [None] * 3
        for i, unit in enumerate(units):
            r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
            stack.enter_context(r)
            _log(f"reserved {r._unit} ({r.id})")
            d = TimeDut(r, LABELS[i], args.out)
            d.url = ""
            stack.callback(d.close)
            duts.append(d)
        a, b, c = duts
        wifi = a.res.wifi()
        if not wifi:
            raise SystemExit("[mesh_app_e2e] the rig serves no AP")
        ssid, psk = wifi

        # -- setup: flash, bridges, Wi-Fi, a map and a running effect ------------------
        boot: dict[str, str] = {}

        def flash(d: TimeDut) -> None:
            boot[d.label] = _flash(d.res, bundle, d.label)

        ts = [threading.Thread(target=flash, args=(d,)) for d in duts if not args.skip_flash]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for d in duts:
            if args.skip_flash:  # iterating: the DUTs already run this image (MESH LEAVE'd)
                d.res.scp_to(shipped, "/tmp/")
                d.proc = None
                d.start(args.bridge_seconds)
                d.cmd("MESH LEAVE", "ok", 6.0)
                d.proc.stdin.close()  # type: ignore[union-attr]
                d.proc.wait(timeout=10)
                d.res.ssh("hitl-monitor --reset --seconds 3", capture=True, timeout=60)
                d.proc = None
                d.start(args.bridge_seconds)
                continue
            if d.label not in boot:
                raise SystemExit(f"[mesh_app_e2e] {d.label}: flash did not complete")
            for _ in range(2):
                if ble_advertising(boot[d.label]):
                    break
                _log(f"{d.label}: app silent after flash; resetting")
                pr = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
                boot[d.label] = (pr.stdout or "") + (pr.stderr or "")
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(boot[d.label])
            if not ble_advertising(boot[d.label]):
                raise SystemExit(f"[mesh_app_e2e] {d.label}: app never came up")
            d.res.scp_to(shipped, "/tmp/")
            d.proc = None
            d.start(args.bridge_seconds)

        fwd: dict[str, ExitStack] = {}
        ports: dict[str, int] = {}

        def lease(d: TimeDut, since: int) -> None:
            d.ip = _wait_lease(d, since, args.lease_timeout)
            if d.label in fwd:
                fwd.pop(d.label).close()
            es = ExitStack()
            # Keep the app's saved address across a re-lease: same local port when free.
            port = es.enter_context(d.res.forward(d.ip, 443))
            fwd[d.label] = es
            stack.callback(es.close)
            ports[d.label] = port
            d.url = f"wss://localhost:{port}/ws"
            _log(f"{d.label} ({d.res._unit}) leased {d.ip} (wss {d.url})")

        def stop_bridge(d: TimeDut) -> None:
            if d.proc:
                try:
                    d.proc.stdin.close()  # type: ignore[union-attr]
                    d.proc.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    d.proc.kill()
            d.proc = None

        for d in duts:
            m = d.mark()
            d.send(f"PROV {ssid} {psk}", secret=True)
            lease(d, m)
        for d in duts:
            asyncio.run(_load_effect(d.url, tint, args.leds))
        time.sleep(args.settle)  # the harness's own connections closed; slots re-listening
        record["units"] = {d.label: {"unit": d.res._unit, "ip": d.ip} for d in duts}

        def app_url(d: TimeDut) -> str:
            # A host name per fixture: the app keys connections and saved devices by host.
            return f"wss://dut-{d.label}.localhost:{ports[d.label]}/ws"

        # -- the app ---------------------------------------------------------------------
        from playwright.sync_api import sync_playwright

        httpd, hport = lg.serve(web)
        stack.callback(httpd.shutdown)
        origin = f"http://127.0.0.1:{hport}"
        # The app's own record ids (store/deviceStore.ts idForUrl): a seeded record under
        # another id is a second record for the same address, and the app treats it so.
        dev_ids = {
            d.label: "dev-" + re.sub(r"[^a-z0-9]+", "-", app_url(d), flags=re.IGNORECASE)
            for d in duts
        }
        seed = {
            "ledmapper.devices": json.dumps(
                [
                    {
                        "id": dev_ids[d.label],
                        "wssUrl": app_url(d),
                        "label": f"Lamp {d.label.upper()}",
                        "bleMac": "",
                        "named": False,
                        "lastSeen": "2026-11-22T00:00:00Z",
                        # Its certificate was trusted in this browser before (on a phone the
                        # user taps through it once): a failed connect is then a busy fixture
                        # to retry, not a certificate to trust (net/client.ts trustedBefore).
                        "wssOkAt": "2026-11-22T00:00:00Z",
                    }
                    for d in duts
                ]
            ),
            "ledmapper.activeDevice": dev_ids["a"],
            "fxedit.autopush.v1": "0",
        }
        pw = stack.enter_context(sync_playwright())
        browser = _chromium(pw)
        stack.callback(browser.close)
        ctx = browser.new_context(viewport=DESKTOP, device_scale_factor=2, ignore_https_errors=True)
        ctx.add_init_script(lg.seed_js(seed, "light"))
        # Diagnostics: who opens each wss (the stack, in the browser console log).
        ctx.add_init_script(
            "(() => { const W = window.WebSocket; window.WebSocket = new Proxy(W, {"
            " construct(t, a) { console.log('WSNEW ' + a[0] + ' ' +"
            " (new Error().stack || '').split('\\n').slice(2, 9).join(' | '));"
            " return Reflect.construct(t, a); } }); })();"
        )
        # Diagnostics: count per-member mesh results the app stored (store/meshSession.ts keeps
        # the last one per connection in a WeakMap) and read back.
        ctx.add_init_script(
            "(() => { const s = WeakMap.prototype.set, g = WeakMap.prototype.get;"
            " WeakMap.prototype.set = function (k, v) { if (v && Array.isArray(v.members)"
            " && 'opId' in v) { window.__meshResSet = (window.__meshResSet || 0) + 1;"
            " window.__meshResLast = JSON.stringify(v); } return s.call(this, k, v); };"
            " WeakMap.prototype.get = function (k) { const v = g.call(this, k);"
            " if (v && Array.isArray(v.members) && 'opId' in v)"
            " window.__meshResGet = (window.__meshResGet || 0) + 1; return v; }; })();"
        )
        page = ctx.new_page()
        app = App(page, shots, args.out, lg)
        ui.append(app)

        def label(x: str) -> str:
            for dv in app.devices():
                if dv["id"] == dev_ids[x]:
                    return dv["label"]
            return f"Lamp {x.upper()}"

        def mesh_lines(marks: dict[str, int], who=None) -> dict[str, list[str]]:
            return {d.label: d.since(marks[d.label]) for d in (who or duts)}

        def gw_stats() -> dict:
            """The gateway's `[mesh] gw` counters (MESH INFO): sends, results pushed."""
            m = a.mark()
            a.send("MESH INFO")
            wait_line(a, r"\[mesh\] infoend", m, 8.0)
            for t in a.since(m):
                if "[mesh] gw sends=" in t:
                    return dict(
                        x.split("=", 1) for x in t.split("[mesh] ", 1)[1].split()[1:] if "=" in x
                    )
            return {}

        def need(name: str) -> None:
            # Later steps need this one: stop here (the DUTs still leave their mesh).
            if not record["steps"][name]["ok"]:
                raise RuntimeError(f"stopped: {name} failed")

        def check_last_change(s: dict, want: int, timeout: float = 15.0) -> None:
            app.open_device_sheet()
            end = time.monotonic() + timeout
            lc = app.last_change()
            while time.monotonic() < end and len(lc["rows"]) < want:
                page.wait_for_timeout(1000)
                lc = app.last_change()
            s["last_change"] = lc
            s["section_text"] = app.text(".mesh-section")
            s["app_results"] = page.evaluate(
                "() => ({set: window.__meshResSet || 0, get: window.__meshResGet || 0,"
                " last: window.__meshResLast || null})"
            )
            s["gw_stats"] = gw_stats()
            target = ".mesh-last" if lc["rows"] else ".mesh-section"
            page.locator(target).first.scroll_into_view_if_needed(timeout=3000)

        try:
            with step("connect") as s:
                page.goto(f"{origin}/index.html#/maps", wait_until="load", timeout=30_000)
                end = time.monotonic() + args.connect_timeout
                seen = []
                while time.monotonic() < end:
                    st_ = page.evaluate(
                        "() => { const p = document.querySelector('.k-pill');"
                        " return p ? p.dataset.state + ' ' + p.textContent : ''; }"
                    )
                    if not seen or seen[-1] != st_:
                        seen.append(st_)
                    if st_.startswith("connected"):
                        break
                    page.wait_for_timeout(500)
                s["pill_states"] = seen
                s["pill"] = app.text(".k-pill")
                app.shot("connected")
                app.click(".tab:has-text('Device')")
                app.wait(".device-row", 20_000)
                page.wait_for_timeout(1500)
                app.shot("devices")
                app.open_device_sheet()
                s["section"] = app.text(".mesh-section")
                app.shot("device-sheet-mesh-none")
                s["ok"] = seen[-1].startswith("connected") and "Create a mesh" in s["section"]

            need("connect")
            with step("create") as s:
                marks = {d.label: d.mark() for d in duts}
                app.click(".mesh-section button:has-text('Create a mesh')")
                app.wait(".cf-title:has-text('Create a mesh')")
                app.shot("mesh-intro")
                app.click("button:has-text('Get started')")
                app.wait(".cf-title:has-text('Which fixtures?')")
                for x in "bc":
                    page.locator(f".mf-pick-row:has-text('{label(x)}') input").first.check()
                    page.wait_for_timeout(200)
                app.shot("mesh-pick")
                app.click("button:has-text('Continue')")
                app.wait(".cf-title:has-text('Name your mesh')")
                page.locator(".cf-field input").first.fill("Rig mesh")
                app.shot("mesh-name")
                t0 = time.monotonic()
                app.click("button:has-text('Create mesh')")
                app.wait(".cf-title:has-text('Setting up your fixtures')", 10_000)
                page.wait_for_timeout(1500)
                app.shot("mesh-setup-running")
                app.wait(
                    ".cf-title:has-text('All set up'), .cf-title:has-text(\"Some fixtures didn't join\")",
                    args.setup_timeout * 1000,
                )
                s["setup_s"] = round(time.monotonic() - t0, 1)
                s["setup_rows"] = app.text(".mf-steps")
                app.shot("mesh-setup-done")
                if not app.visible(".cf-title:has-text('All set up')"):
                    raise RuntimeError(f"set-up: {s['setup_rows']!r}")
                app.click("button:has-text('Continue')")
                app.wait(
                    ".cf-title:has-text('Joining up'), .cf-title:has-text('Your mesh is ready')"
                )
                page.wait_for_timeout(800)
                app.shot("mesh-joining")
                app.wait(".cf-title:has-text('Your mesh is ready')", args.join_timeout * 1000)
                s["ready_s"] = round(time.monotonic() - t0, 1)
                s["joined_rows"] = app.text(".mf-steps")
                app.shot("mesh-ready")
                ul = unlocks(a.since(marks["a"]))
                s["unlocks"] = ul
                s["synced"] = [
                    x.label
                    for x in (b, c)
                    if wait_line(x, r"\[mesh\] session synced", marks[x.label], args.sync_timeout)
                ]
                s["phase"] = {d.label: info(d).get("phase") for d in duts}
                app.click("button:has-text('Done')")
                fails = []
                if not any(u["ok"] for u in ul):
                    fails.append(f"no grant accepted on a: {ul}")
                if sorted(s["synced"]) != ["b", "c"]:
                    fails.append(f"synced {s['synced']}")
                if any(v != "member" for v in s["phase"].values()):
                    fails.append(f"phase {s['phase']}")
                s["fail"] = "; ".join(fails) or None
                s["ok"] = not fails

            need("create")
            with step("control") as s:
                app.open_device_sheet()
                app.wait(".mesh-section [role=switch]", 20_000)
                app.shot("device-sheet-mesh-admin")
                sw = page.locator(".mesh-section [role=switch]").first
                if sw.get_attribute("aria-checked") != "true":
                    sw.click()
                    page.wait_for_timeout(500)
                s["switch"] = sw.get_attribute("aria-checked")
                s["members"] = app.text(".mesh-members")
                app.shot("device-sheet-mesh-control-on")
                s["ok"] = s["switch"] == "true"

            need("control")
            st: dict = {}

            def push_effect(s: dict, name: str) -> None:
                app.close_sheets()
                app.go("#/effects")
                app.click("[aria-label='New effect']")
                app.wait("textarea.fxedit-code", 20_000)
                page.locator("textarea.fxedit-code").first.fill(effect_src)
                # Compiled: the uniforms pane lists the effect's sliders.
                app.wait("input[type=range]", 60_000)
                page.wait_for_timeout(1000)
                app.shot(f"editor-{name}-compiled")
                marks = {d.label: d.mark() for d in duts}
                t0 = time.monotonic()
                st["editor"] = page.evaluate("location.hash")
                app.click(".k-actiontile:has-text('Push')")
                got = {
                    d.label: wait_line(d, r"\[mesh\] fx applied", marks[d.label], 20.0)
                    for d in duts
                }
                s["all_ms"] = round((time.monotonic() - t0) * 1000)
                page.wait_for_timeout(1500)
                s["status"] = app.text(".fxedit-devstatus, .fxedit-device-status")
                app.shot(f"editor-{name}-pushed")
                s["frame"] = fx_same_frame(mesh_lines(marks), args.max_skew_us)
                s["got"] = {k: bool(v) for k, v in got.items()}
                s["scenes"] = {d.label: scenes(d.since(marks[d.label])) for d in (b, c)}

            with step("effect") as s:
                push_effect(s, "effect")
                check_last_change(s, 3)
                app.shot("device-sheet-last-change-effect")
                fails = []
                if not s["frame"]["ok"]:
                    fails.append(f"frame {s['frame']}")
                if len(s["last_change"]["rows"]) < 3 or not all(
                    r["ok"] for r in s["last_change"]["rows"]
                ):
                    fails.append(f"last change {s['last_change']}")
                s["fail"] = "; ".join(fails) or None
                s["ok"] = not fails

            with step("slider") as s:
                app.close_sheets()
                app.go(st["editor"])
                app.wait("input[type=range]", 60_000)
                if not app.visible("input[type=range]"):
                    raise RuntimeError("the editor's uniform sliders are not shown")
                marks = {d.label: d.mark() for d in duts}
                # A drag: live moves go on arrival; the value let go is committed (the
                # editor commits 600 ms after the last move) and scheduled on the mesh
                # clock, so every fixture settles on one frame.
                for v in (0.6, 0.8, 1.0, 1.2, 1.4, 1.6):
                    app.set_range("input[type=range]", v, release=False)
                    page.wait_for_timeout(60)
                got = {d.label: wait_line(d, r"\[mt\] apply ", marks[d.label], 6.0) for d in duts}
                page.wait_for_timeout(1500)
                s["got"] = {k: bool(v) for k, v in got.items()}
                s["frame"] = mt_same_frame(mesh_lines(marks), args.max_skew_us)
                app.shot("editor-slider-moved")
                check_last_change(s, 3)
                app.shot("device-sheet-last-change-slider")
                fails = []
                if not s["frame"]["ok"]:
                    fails.append(f"commit frame {s['frame']}")
                if len(s["last_change"]["rows"]) < 3 or not all(
                    r["ok"] for r in s["last_change"]["rows"]
                ):
                    fails.append(f"last change {s['last_change']}")
                s["fail"] = "; ".join(fails) or None
                s["ok"] = not fails

            def brightness(s: dict, value: float, tag: str) -> None:
                app.close_sheets()
                app.go("#/settings/color-correction")
                app.wait(".k-slider:has-text('Output level') input[type=range]", 20_000)
                marks = {d.label: d.mark() for d in duts}
                app.set_range(".k-slider:has-text('Output level') input[type=range]", value)
                got = {d.label: wait_line(d, r"\[mt\] apply ", marks[d.label], 10.0) for d in duts}
                page.wait_for_timeout(2500)
                app.shot(f"brightness-{tag}")
                s["frame"] = mt_same_frame(mesh_lines(marks), args.max_skew_us)
                s["got"] = {k: bool(v) for k, v in got.items()}
                check_last_change(s, 3)
                app.shot(f"device-sheet-last-change-brightness-{tag}")
                fails = []
                if not s["frame"]["ok"]:
                    fails.append(f"frame {s['frame']}")
                if len(s["last_change"]["rows"]) < 3 or not all(
                    r["ok"] for r in s["last_change"]["rows"]
                ):
                    fails.append(f"last change {s['last_change']}")
                s["fail"] = "; ".join(fails) or None
                s["ok"] = not fails

            with step("brightness") as s:
                brightness(s, 0.6, "60")

            with step("eject") as s:
                app.open_device_sheet()
                mc = c.mark()
                app.click(f".mesh-member:has-text('{label('c')}')")
                app.wait(".mesh-sheet")
                app.shot("member-sheet")
                app.click(".mesh-sheet button:has-text('Remove from mesh')")
                app.wait(".k-confirm")
                app.shot("member-remove-confirm")
                app.click(".k-confirm button:has-text('Remove')")
                line = wait_line(c, r"\[mesh\] ejected by the admin|left the mesh", mc, 20.0)
                s["c_line"] = line
                t_ej = time.monotonic()
                page.wait_for_timeout(2000)
                app.open_device_sheet()
                page.wait_for_timeout(1500)
                s["members_after_2s"] = app.text(".mesh-members")
                app.shot("device-sheet-after-eject")
                # The section re-reads the mesh every 3 s: how long until c is off the list?
                n_rows = 3
                while time.monotonic() - t_ej < args.eject_list_timeout:
                    n_rows = page.locator(".mesh-members .mesh-member").count()
                    if n_rows <= 2:
                        break
                    page.wait_for_timeout(1000)
                s["members"] = app.text(".mesh-members")
                s["listed_s"] = round(time.monotonic() - t_ej, 1)
                app.shot("device-sheet-after-eject-settled")
                s["c_phase"] = info(c).get("phase")
                s["ok"] = bool(line) and n_rows <= 2
                if not s["ok"]:
                    s["fail"] = (
                        f"c_line={line}; still {n_rows} fixtures listed "
                        f"{s['listed_s']} s after the eject: {s['members']!r}"
                    )

            with step("readd") as s:
                mc = c.mark()
                app.click(".mesh-section button:has-text('Add a fixture to this mesh')")
                app.wait(".cf-title:has-text('Add to')")
                page.locator(f".mf-pick-row:has-text('{label('c')}') input").first.check()
                page.wait_for_timeout(200)
                app.shot("mesh-add-pick")
                app.click("button:has-text('Add fixture')")
                app.wait(
                    ".cf-title:has-text('All set up'), .cf-title:has-text(\"Some fixtures didn't join\")",
                    args.setup_timeout * 1000,
                )
                s["setup_rows"] = app.text(".mf-steps")
                app.shot("mesh-add-setup-done")
                if not app.visible(".cf-title:has-text('All set up')"):
                    raise RuntimeError(f"set-up: {s['setup_rows']!r}")
                app.click("button:has-text('Continue')")
                app.wait(".cf-title:has-text('Your mesh is ready')", args.join_timeout * 1000)
                app.shot("mesh-add-ready")
                app.click("button:has-text('Done')")
                s["synced"] = bool(wait_line(c, r"\[mesh\] session synced", mc, args.sync_timeout))
                s["catch_up"] = wait_line(
                    c, r"\[mesh\] scene apply .*catch_up=1", mc, args.catchup_timeout
                )
                s["scene"] = scenes(c.since(mc))
                s["phase"] = info(c).get("phase")
                app.open_device_sheet()
                page.wait_for_timeout(3500)
                s["members"] = app.text(".mesh-members")
                app.shot("device-sheet-after-readd")
                s["ok"] = s["synced"] and bool(s["catch_up"]) and s["phase"] == "member"
                if not s["ok"]:
                    s["fail"] = f"synced={s['synced']} catch_up={s['catch_up']} phase={s['phase']}"

            with step("reboot") as s:
                stop_bridge(b)
                pr = b.res.ssh("hitl-monitor --reset --seconds 20", capture=True, timeout=120)
                boot_text = (pr.stdout or "") + (pr.stderr or "")
                with open(os.path.join(args.out, "reboot-b.log"), "w") as f:
                    f.write(boot_text)
                extra_lines.setdefault("b", []).append(("boot", boot_text.splitlines()))
                m0 = b.mark()
                t0 = time.monotonic()
                b.start(args.bridge_seconds)
                b.send(f"PROV {ssid} {psk}", secret=True)
                lease(b, m0)
                early = [x for x in scenes(boot_text.splitlines()) if x["kind"] == "apply"]
                caught = bool(early) or bool(
                    wait_line(b, r"\[mesh\] scene apply .*catch_up=1", m0, args.catchup_timeout)
                )
                s["catchup_s"] = round(time.monotonic() - t0, 1)
                s["scene"] = early + [x for x in scenes(b.since(m0)) if x["kind"] == "apply"]
                s["synced"] = bool(
                    any("[mesh] session synced" in t for t in boot_text.splitlines())
                    or wait_line(b, r"\[mesh\] session synced", m0, args.sync_timeout)
                )
                s["phase"] = info(b).get("phase")
                app.open_device_sheet()
                page.wait_for_timeout(4000)
                s["members"] = app.text(".mesh-members")
                app.shot("device-sheet-after-reboot")
                s["ok"] = caught and s["phase"] == "member"
                if not s["ok"]:
                    s["fail"] = f"caught={caught} phase={s['phase']} synced={s['synced']}"

            with step("reload") as s:
                ma = a.mark()
                app.close_sheets()
                page.reload(wait_until="load")
                line = wait_line(a, r"\[mesh\] unlock conn=.* -> ", ma, 40.0)
                s["unlock"] = line
                app.open_device_sheet()
                app.wait(".mesh-section [role=switch]", 20_000)
                app.shot("device-sheet-after-reload")
                s["ok"] = bool(line) and line.endswith("ok")
                if not s["ok"]:
                    s["fail"] = f"unlock line {line!r}"
                # A new connection starts with "Control the whole mesh" off: on again.
                sw = page.locator(".mesh-section [role=switch]").first
                if sw.get_attribute("aria-checked") != "true":
                    sw.click()
                    page.wait_for_timeout(500)
                s["switch"] = sw.get_attribute("aria-checked")

            with step("final") as s:
                brightness(s, 0.9, "90")
                s["phase"] = {d.label: info(d).get("phase") for d in duts}
                if any(v != "member" for v in s["phase"].values()):
                    s["ok"] = False
                    s["fail"] = (s.get("fail") or "") + f" phase {s['phase']}"
        except RuntimeError as e:
            record.setdefault("errors", {})["run"] = str(e)
        finally:
            for d in duts:
                try:
                    if not d.alive():
                        d.start(args.bridge_seconds)
                    d.cmd("MESH LEAVE", "ok", 6.0)
                    time.sleep(1.0)
                except Exception as e:  # noqa: BLE001
                    _log(f"{d.label}: MESH LEAVE failed {e!r}")

        record["layout"] = app.layout
        with open(os.path.join(args.out, "app-frames.tsv"), "w") as f:
            t0 = app.frames[0][0] if app.frames else 0.0
            for ft, u, k, n, h in app.frames:
                f.write(f"{ft - t0:.3f}\t{u}\t{k}\t{n}\t{h}\n")
        record["late_summary"] = late_summary(record["late"])
        ok, why = verdict(record, strict_late=args.strict_late)
        if record.get("layout"):
            why = why + [f"layout {k}: {v}" for k, v in record["layout"].items()]
            ok = ok and not args.strict_layout
        record.update(
            {"verdict": {"pass": ok, "reasons": why}, "elapsed_s": round(time.time() - t_start)}
        )
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(record, f, indent=1, default=str)
        lines = ["# mesh_app_e2e", "", f"verdict: {'PASS' if ok else 'FAIL'}", ""]
        lines += [f"- {w}" for w in why]
        for name, s in record["steps"].items():
            fr = s.get("frame") or {}
            lines.append(
                f"- {name}: ok={s.get('ok')} {s.get('seconds')} s"
                + (f" k={fr.get('k')} skew_us={fr.get('skew_us')}" if fr else "")
                + (f" fail={s.get('fail')}" if s.get("fail") else "")
            )
        ls = record["late_summary"]
        lines += ["", f"late frames: {ls['frames']} {ls['by_dut']} {ls['by_cause']}"]
        lines += [f"  - {x}" for x in record["late"]]
        with open(os.path.join(args.out, "results.md"), "w") as f:
            f.write("\n".join(lines) + "\n")
        _log(f"RESULT {'PASS' if ok else 'FAIL'} {why}")
        _log(f"late frames {ls}")
        for d in duts:
            _log(f"serial log ({d.label}, {d.res._unit}): {d.log.name}")
        return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_app_e2e"))
    ap.add_argument("--units", nargs=3, default=None, help="3 C6 unit names (a = gateway, b, c)")
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "MESH_BUNDLE_RUNFILE",
            "_main/firmware/player_app/esp32c6_netstack_meshdev_flashbundle.tar",
        ),
    )
    ap.add_argument("--web", default=os.environ.get("MESH_WEB_RUNFILE", "_main/web/ios_payload"))
    ap.add_argument(
        "--fxb", default=os.environ.get("MESH_FXB_RUNFILE", "_main/pi/hitl/harness/meshTint.fxb")
    )
    ap.add_argument(
        "--effect-src",
        default=os.environ.get(
            "MESH_EFFECT_SRC_RUNFILE", "_main/pi/hitl/harness/ab_demo/meshStorm.fx"
        ),
        help="the effect typed into the editor (meshStorm: ~2 KB fxb, 7 uniforms)",
    )
    ap.add_argument(
        "--proto",
        default=os.environ.get("MESH_PROTO_RUNFILE", "_main/shared/protocol/proto/ledmapper.proto"),
        help="names the app's requests next to a late frame",
    )
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--max-skew-us", type=int, default=12_500, help="one frame at 80 fps")
    ap.add_argument("--connect-timeout", type=float, default=90.0)
    ap.add_argument("--setup-timeout", type=float, default=120.0)
    ap.add_argument("--join-timeout", type=float, default=90.0)
    ap.add_argument("--sync-timeout", type=float, default=40.0)
    ap.add_argument(
        "--eject-list-timeout",
        type=float,
        default=10.0,
        help="an ejected fixture must leave the Mesh section list within this",
    )
    ap.add_argument("--catchup-timeout", type=float, default=60.0)
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--bridge-seconds", type=float, default=3600.0)
    ap.add_argument("--skip-flash", action="store_true", help="the DUTs already run the image")
    ap.add_argument("--strict-late", action="store_true", help="any late frame outside boot fails")
    ap.add_argument("--strict-layout", action="store_true", help="a layout violation fails")
    ap.add_argument("--shots", default=None, help="screenshot dir (default <out>/shots)")
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_app_e2e")
    )
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
