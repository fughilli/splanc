"""HITL journey: a firmware update over Wi-Fi driven through the REAL web app.

The OTA gate (hitl_ota.py) drives the update with the Python client, which skips
cert checks and runs its own reconnect loop, so it can't see a bug in the browser
path. This journey drives the update the way a user does: headless Chromium loads
the built web app, connects to the DUT over wss, opens the Flash sheet and presses
"Update <device> over Wi-Fi". Every reconnect, resume, timeout and progress message
comes from the shipped TypeScript client (net/client.ts + net/otaUpdate.ts).

The browser reaches the DUT through `lan_relay.py`, which runs inside the reservation
container and gives the browser the socket semantics it has on the DUT's LAN: a DUT
reboot is a half-open connection that Chromium's 45 s TCP keepalive finds (the DUT's
netstack RSTs the probe), a DUT that isn't up yet is a connect that hangs, and a
DUT-side reset reaches the browser as a reset. (A bare `ssh -L` keeps the browser's
end open forever, which is not what a phone sees.) The page origin is
http://127.0.0.1:<port>, the socket is wss://127.0.0.1:<tunnel>/ws: cross-origin, so
the client runs its real cert-trust logic; the cert itself is accepted the way a user
who tapped "Trust & connect" would have (Chromium --ignore-certificate-errors).

Phases (one reservation, a C6):
  1. flash the test-key OTA bundle clean (USB) and provision Wi-Fi over the wired
     console (same as the OTA gate);
  2. load the app with the DUT as the active device; wait for "connected";
  3. Flash sheet -> "Update <name> over Wi-Fi" with the B package (test-signed);
  4. watch the sheet until it reports "Updated" or "Update failed" (or the journey's
     own deadline), recording every status change with its time, the client's console
     and the relay's connection log; then check the device runs B over the Python
     client.

PASS = the sheet reports the update done, the DUT runs B. A sheet still spinning at
the deadline is a FAIL (the user's bug: "Restarting into the updater…" forever).

    bazel run //pi/hitl/harness:web_ota_journey -- --server http://hitl-rig-2:8087 \\
        --device c6-003f08 --out /tmp/web-ota

Prints `RESULT ... verdict=PASS|FAIL|SKIP` (exit 1 on FAIL), and writes
timeline.json, console.log, relay.log and the DUT serial log under --out.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import functools
import http.server
import json
import os
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from typing import Any

RUNFILES = {
    "bundle": "HITL_OTA_BUNDLE_RUNFILE",
    "pkg": "HITL_OTA_B_RUNFILE",
    "web_dist": "HITL_WEB_DIST_RUNFILE",
}

RELAY_PORT = 9443

# Seed localStorage before the app boots: no tutorial/splash overlays.
SEED_JS = """
localStorage.setItem('ledmapper.tour', JSON.stringify({dismissed:true, hintSeen:true, completed:[]}));
localStorage.setItem('ledmapper.aiHintDismissed', '1');
try {
  const a = JSON.parse(localStorage.getItem('ledmapper.appearance') || '{}');
  a.splash = false;
  localStorage.setItem('ledmapper.appearance', JSON.stringify(a));
} catch (e) {}
"""

# Snapshot of what the user sees: the flash sheet's status line + log, and the pill.
SNAPSHOT_JS = """
() => {
  const q = (s) => document.querySelector(s);
  const st = q('.flash-status');
  const log = q('.flash-log');
  const pill = q('.k-pill');
  return {
    status: st ? st.textContent : null,
    statusClass: st ? st.className : null,
    log: log ? log.textContent : null,
    pill: pill ? pill.textContent : null,
    pillState: pill ? pill.dataset.state : null,
  };
}
"""


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(env: str) -> str | None:
    rel = os.environ.get(env)
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(rel)
    except Exception:
        return None


# -- the site: the built app + the firmware it offers --------------------------------


def stage_site(web_dist: str, bundle: str, pkg: bytes, out: str) -> str:
    """Copy the built app to `out` and stage the test-key OTA bundle under /firmware/
    as the app's bundled ("This build") firmware, with `pkg` as its OTA package."""
    site = os.path.join(out, "site")
    if os.path.exists(site):
        shutil.rmtree(site)
    shutil.copytree(web_dist, site, symlinks=False)
    os.chmod(site, 0o755)
    for root, dirs, files in os.walk(site):
        for n in dirs:
            os.chmod(os.path.join(root, n), 0o755)
        for n in files:
            os.chmod(os.path.join(root, n), 0o644)
    fw = os.path.join(site, "firmware")
    os.makedirs(fw, exist_ok=True)
    eid = "esp32c6_netstack_ota_test"
    dest = os.path.join(fw, eid)
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(bundle) as t:
        man = json.load(t.extractfile("flash.json"))
        for m in t.getmembers():
            if m.isfile():
                with open(os.path.join(dest, os.path.basename(m.name)), "wb") as f:
                    f.write(t.extractfile(m).read())
    ota_name = (man.get("ota") or {}).get("package") or "esp32c6-netstack.ota"
    man.setdefault("ota", {})["package"] = ota_name
    with open(os.path.join(dest, ota_name), "wb") as f:
        f.write(pkg)
    with open(os.path.join(dest, "flash.json"), "w") as f:
        json.dump(man, f)
    index = {
        "revision": "hitl",
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "entries": [
            {
                "id": eid,
                "label": "Netstack + OTA loader (HITL test key)",
                "chip": man.get("chip", "esp32c6"),
                "family": "esp",
                "manifest": "flash.json",
            }
        ],
    }
    with open(os.path.join(fw, "manifest.json"), "w") as f:
        json.dump(index, f)
    return site


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a) -> None:  # noqa: D401
        pass


@contextlib.contextmanager
def serve(site: str):
    handler = functools.partial(_Quiet, directory=site)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()


# -- the network path: relay in the reservation + an ssh tunnel to it ----------------


def start_relay(res, ip: str) -> None:
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lan_relay.py")).read()
    b64 = base64.b64encode(src.encode()).decode()
    res.ssh(
        f"rm -f /tmp/lan_relay.blackout; echo {b64} | base64 -d > /tmp/lan_relay.py && "
        f"(nohup python3 -u /tmp/lan_relay.py --listen-port {RELAY_PORT} --target {ip}:443 "
        f"> /tmp/lan_relay.log 2>&1 &) && sleep 1 && cat /tmp/lan_relay.log",
        capture=True,
        timeout=60,
    )


@contextlib.contextmanager
def tunnel(res, remote_port: int):
    from hitl_client import _free_local_port, _wait_listen

    local = _free_local_port()
    argv = res._ssh_base() + [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        f"{local}:127.0.0.1:{remote_port}",
        f"{res.user}@{res.host}",
    ]
    proc = subprocess.Popen(argv)
    try:
        if not _wait_listen(local, timeout=20):
            raise RuntimeError("tunnel to the relay did not come up")
        yield local
    finally:
        proc.terminate()
        with contextlib.suppress(Exception):
            proc.wait(timeout=5)


# -- checking the device over the Python client ----------------------------------------


async def _welcome(port: int, deadline_s: float = 60.0) -> Any:
    import ota_core as oc
    import websockets

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    end = time.monotonic() + deadline_s
    last: Exception | None = None
    while time.monotonic() < end:
        try:
            async with websockets.connect(
                f"wss://127.0.0.1:{port}/ws", ssl=ctx, open_timeout=15
            ) as ws:
                await ws.send(oc.client(hello=oc.pb.Hello(client="hitl_web_ota", app_version="1")))
                while True:
                    arm, msg = oc.server(await asyncio.wait_for(ws.recv(), 15))
                    if arm == "welcome":
                        return msg
        except Exception as e:  # noqa: BLE001
            last = e
            await asyncio.sleep(2)
    raise TimeoutError(f"no welcome: {last}")


# -- the browser journey ------------------------------------------------------------------


def _open_flash_sheet(page) -> str:
    """Open the update flow from the connected device's sheet. Prefer the device
    sheet's own "Update firmware" entry; fall back to the add-device row's chip icon
    (older builds). Returns which entry point was used."""
    # The app-bar pill opens the device sheet from every screen (the tab bar is
    # hidden on first-run onboarding).
    page.locator(".k-pill").first.click()
    page.wait_for_selector(".k-sheet", timeout=10_000)
    page.wait_for_timeout(800)
    upd = page.get_by_role("button", name="Update firmware")
    if upd.count() > 0:
        upd.first.click()
        return "device-sheet"
    page.locator("[aria-label='Flash firmware (USB)']").first.click()
    return "chip-icon"


class Blackouts:
    """Field-network emulation through the relay (see lan_relay.py): the DUT is "off
    the network" for `restart_s` after each restart (the handoff into the updater and
    the boot into the new firmware: a slow Wi-Fi rejoin), and for `stall_s` once
    mid-transfer (a Wi-Fi stall the TCP connection survives)."""

    def __init__(self, res, restart_s: float, stall_s: float, mark) -> None:
        self.res, self.restart_s, self.stall_s, self.mark = res, restart_s, stall_s, mark
        self.done: set[str] = set()

    def _fire(self, name: str, seconds: float, delay: float) -> None:
        if seconds <= 0 or name in self.done:
            return
        self.done.add(name)
        self.mark("blackout", what=name, seconds=seconds, delay=delay)
        cmd = (
            f"s=$(date +%s); echo $((s + {int(delay)})) $((s + {int(delay + seconds)}))"
            " > /tmp/lan_relay.blackout"
        )
        threading.Thread(
            target=lambda: self.res.ssh(cmd, capture=True, timeout=30), daemon=True
        ).start()

    def on_status(self, status: str | None) -> None:
        st = status or ""
        if "Restarting into the updater" in st:
            # After the REBOOTING reply is on the wire (the app restarts 0.4 s later).
            self._fire("handoff", self.restart_s, 1)
        elif "Starting the new firmware" in st:
            self._fire("install", self.restart_s, 0)
        elif "Sending firmware" in st and "%" in st:
            pct = int(st.split("%")[0].split()[-1])
            if pct >= 30:
                self._fire("stall", self.stall_s, 0)


def ensure_browser() -> None:
    """Make sure Chromium is available to Playwright; install it once if not (the
    docs capture tool's flow — needs network the first time)."""
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            p.chromium.launch(headless=True).close()
        return
    except Exception:  # noqa: BLE001
        pass
    _log("Installing Chromium for Playwright (one-time)…")
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(x for x in sys.path if x))
    subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium-headless-shell"],
        check=True,
        env=env,
    )


def run_browser(
    site_port: int,
    ws_port: int,
    out: str,
    deadline_s: float,
    headless: bool = True,
    blackouts: Blackouts | None = None,
) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    timeline: list[dict[str, Any]] = []
    console: list[str] = []
    t0 = time.monotonic()

    def mark(kind: str, **kw) -> None:
        e = {"t": round(time.monotonic() - t0, 2), "kind": kind, **kw}
        timeline.append(e)
        _log(f"  [web t={e['t']:7.2f}] {kind} {json.dumps(kw)[:300]}")

    result: dict[str, Any] = {"timeline": timeline}
    if blackouts is not None:
        blackouts.mark = mark
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=["--ignore-certificate-errors"],
        )
        ctx = browser.new_context(
            viewport={"width": 412, "height": 900},
            ignore_https_errors=True,
            service_workers="block",
        )
        ctx.add_init_script(SEED_JS)
        # Hermetic: only the local site + the DUT (the release index etc. stay offline,
        # so the sheet falls back to the bundled test firmware).
        ctx.route(
            "**/*",
            lambda route: (
                route.continue_()
                if route.request.url.startswith(("http://127.0.0.1", "wss://127.0.0.1"))
                else route.abort()
            ),
        )
        page = ctx.new_page()
        page.on(
            "console",
            lambda m: console.append(f"{time.monotonic() - t0:8.2f} {m.type}: {m.text}"),
        )
        page.on(
            "websocket",
            lambda ws: (
                mark("ws-open", url=ws.url),
                ws.on("close", lambda _w: mark("ws-close", url=ws.url)),
            ),
        )
        url = f"http://127.0.0.1:{site_port}/?url=wss://127.0.0.1:{ws_port}/ws"
        page.goto(url)
        mark("loaded", url=url)
        page.wait_for_function(
            "() => { const p = document.querySelector('.k-pill');"
            " return p && p.dataset.state === 'connected'; }",
            timeout=120_000,
        )
        mark("connected", **page.evaluate(SNAPSHOT_JS))
        result["entry"] = _open_flash_sheet(page)
        mark("flash-sheet", entry=result["entry"])
        btn = page.get_by_role("button", name="over Wi-Fi")
        btn.first.wait_for(timeout=60_000)
        legacy_note = page.locator("text=one-time USB update")
        if legacy_note.count() > 0:
            mark("legacy-layout-note")
        btn.first.click()
        mark("update-pressed")
        last: dict[str, Any] = {}
        end = time.monotonic() + deadline_s
        outcome = "deadline"
        while time.monotonic() < end:
            snap = page.evaluate(SNAPSHOT_JS)
            if blackouts:
                blackouts.on_status(snap.get("status"))
            if (snap.get("status"), snap.get("pill")) != (last.get("status"), last.get("pill")):
                mark("ui", status=snap.get("status"), pill=snap.get("pill"))
            if snap.get("log") != last.get("log") and snap.get("log"):
                new = snap["log"][len(last.get("log") or "") :].strip()
                if new:
                    mark("log", text=new)
            last = snap
            cls = snap.get("statusClass") or ""
            if "flash-status--ok" in cls:
                outcome = "ok"
                break
            if "flash-status--err" in cls:
                outcome = "failed"
                break
            page.wait_for_timeout(500)
        result["outcome"] = outcome
        result["final"] = last
        with contextlib.suppress(Exception):
            page.screenshot(path=os.path.join(out, "final.png"))
        browser.close()
    with open(os.path.join(out, "console.log"), "w") as f:
        f.write("\n".join(console))
    result["console_tail"] = console[-40:]
    return result


def run(args) -> int:
    import ota_core as oc
    from hitl_client import Reservation
    from provision import HarnessError, ensure_booted, wire_provision_dut

    os.makedirs(args.out, exist_ok=True)
    pkg = open(args.pkg, "rb").read()
    want_version = oc.split_package(pkg)[2].version
    site = stage_site(args.web_dist, args.bundle, pkg, args.out)
    ensure_browser()  # before reserving: never hold a DUT while downloading a browser
    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    checks: list[oc.Check] = []
    report: dict[str, Any] = {}
    res.acquire()
    try:
        creds = res.wifi()
        if not creds:
            raise HarnessError("rig serves no AP")
        ssid, password = creds
        res.ssh("mkdir -p /tmp/webota")
        res.scp_to([args.bundle], "/tmp/webota/")
        remote = f"/tmp/webota/{os.path.basename(args.bundle)}"
        _log("[flash] test-key OTA bundle, clean")
        proc = res.ssh_serialized(
            f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds 12",
            capture=True,
            timeout=400,
        )
        log = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            raise HarnessError(f"hitl-flash exited {proc.returncode}: {log[-1500:]}")
        ensure_booted(res, log, 12.0)
        url = wire_provision_dut(res, ssid, password, 60.0)
        ip = url.split("/")[2]
        _log(f"[provision] DUT at {ip}")
        res.assert_reachable(ip, ports=(443,))
        start_relay(res, ip)
        with tunnel(res, RELAY_PORT) as ws_port, serve(site) as site_port:
            before = asyncio.run(_welcome(ws_port))
            report["before"] = {"fw_version": before.fw_version, "mac": before.mac}
            _log(f"[device] before: {report['before']}")
            t_start = time.monotonic()
            web = run_browser(
                site_port,
                ws_port,
                args.out,
                args.deadline,
                not args.headed,
                Blackouts(res, args.restart_blackout, args.stall, None),
            )
            report["web"] = {k: v for k, v in web.items() if k != "console_tail"}
            report["web_seconds"] = round(time.monotonic() - t_start, 1)
            checks.append(
                oc.Check(
                    "web.update_reported_done",
                    web["outcome"] == "ok",
                    f"{web['outcome']}: {(web.get('final') or {}).get('status')}",
                )
            )
            if web["outcome"] == "deadline":
                checks.append(
                    oc.Check(
                        "web.no_indefinite_spinner",
                        False,
                        f"still '{(web.get('final') or {}).get('status')}' after {args.deadline:.0f}s",
                    )
                )
            try:
                after = asyncio.run(_welcome(ws_port, 240))
                report["after"] = {"fw_version": after.fw_version, "in_loader": oc.in_loader(after)}
            except Exception as e:  # noqa: BLE001
                report["after"] = {"error": str(e)}
            _log(f"[device] after: {report['after']}")
            st = report["after"]
            checks.append(
                oc.Check(
                    "device.runs_b",
                    bool(st.get("fw_version", "").endswith("+b")) and not st.get("in_loader"),
                    json.dumps(st),
                )
            )
            resumes = sum(
                1 for e in web["timeline"] if e["kind"] == "log" and "Reconnecting" in e["text"]
            )
            report["resumes_seen"] = resumes
            report["want_version"] = want_version
        relay = res.ssh("cat /tmp/lan_relay.log", capture=True, timeout=30)
        with open(os.path.join(args.out, "relay.log"), "w") as f:
            f.write(relay.stdout or "")
    except HarnessError as e:
        _log(f"infrastructure: {e}")
        checks.append(oc.Check("infrastructure", None, str(e)))
    except Exception as e:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        checks.append(oc.Check("unexpected", False, f"{type(e).__name__}: {e}"))
    finally:
        with contextlib.suppress(Exception):
            res.ssh("pkill -f lan_relay.py || true", capture=True, timeout=20)
        res.release()
    for name, text in res.serial_logs.items():
        with open(os.path.join(args.out, f"serial-{name}.log"), "w") as f:
            f.write(text)
    with open(os.path.join(args.out, "timeline.json"), "w") as f:
        json.dump(report, f, indent=1, default=str)
    v = oc.verdict(checks)
    if v == "FAIL":
        _log(res.serial_tail())
    for c in checks:
        _log(f"  {'PASS' if c.ok else ('SKIP' if c.ok is None else 'FAIL')} {c.name} {c.detail}")
    _log(f"RESULT unit={res._unit} verdict={v}")
    return 1 if v == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: OTA update through the real web app")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-003f08)")
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR") or tempfile.mkdtemp()
    )
    ap.add_argument(
        "--deadline",
        type=float,
        default=900.0,
        help="seconds the sheet may take to report an outcome (a spinner past it FAILs)",
    )
    ap.add_argument("--headed", action="store_true")
    ap.add_argument(
        "--restart-blackout",
        type=float,
        default=0.0,
        help="emulate a slow Wi-Fi rejoin: the DUT is unreachable this long after each restart",
    )
    ap.add_argument(
        "--stall",
        type=float,
        default=0.0,
        help="emulate a mid-transfer Wi-Fi stall of this many seconds (at 30%%)",
    )
    for k, env in RUNFILES.items():
        ap.add_argument("--" + k.replace("_", "-"), default=_runfile(env))
    args = ap.parse_args()
    missing = [k for k in RUNFILES if not getattr(args, k)]
    if missing:
        raise SystemExit(f"missing inputs {missing} (run via bazel run, or pass them)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
