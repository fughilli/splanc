"""HITL: a board playing a heavy effect stays reachable for NEW clients.

Field regression (1.12.3): after an effect that nearly filled its frame budget was
activated, two C6 players stopped accepting connections (no TLS/WebSocket handshake
within 8 s) while the LEDs kept animating and mDNS still answered; the persisted
effect brought the lockup back after every power cycle. The netstack loop ran below
render priority whenever no session was up and only got the few ms a near-budget
frame left of its period: too little CPU for a TLS handshake, the Wi-Fi join or DHCP.

This gate reproduces it on a rig C6 inside ONE reservation:

  1. flash this tree's netstack bundle --erase-fs, wire-provision onto the rig AP,
     open one tunnel to :443 and prove a baseline connection (else SKIP);
  2. calibrate: load a Swirl-like effect (swirlHeavy.fx: branchy atan2 + sqrt + sin +
     hsv2rgb per LED) on a probe map, read its frame cost (perf BASIC), and resize
     the map so one frame costs ~93 % of the 25 fps floor's 40 ms period;
  3. idle: close every session, wait 30 s, then NEW connections (TLS + WS + hello)
     must each complete within 8 s, 5 in a row;
  4. rejoin: PROV a missing SSID, then the rig AP again (sweep + PBKDF2 + join +
     DHCP under the heavy effect): connect within 60 s, then 3 more in a row;
  5. boot: reset with the heavy effect persisted: connect within 60 s, then 3 more.

The pass/fail policy is heavy_effect_reachability_core (unit-tested in
//pi/hitl/tests). Console windows (the firmware's [net] loop_gap_max and [ft] render
lines) are saved to --log-dir (default: the test's undeclared outputs, which CI uploads
as hitl-test-outputs) as each one closes; on FAIL every failing phase's window prints
whole, plus the Reservation's serial capture tail.

    bazel run //pi/hitl/harness:heavy_effect_reachability -- --server http://hitl-rig-1:8087

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import shlex
import ssl
import sys
import threading
import time
import uuid
from urllib.parse import urlparse

import heavy_effect_reachability_core as core
import hitl_ws


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(rel: str | None) -> str | None:
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        got = runfiles.Create().Rlocation(rel)
        return got if got and os.path.exists(got) else None
    except Exception:
        return None


def _ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _connect_once(ws_url: str, timeout: float) -> None:
    """One NEW client, the way the app / agent bridge connects: TCP + TLS + the
    WebSocket upgrade + hello -> welcome, all inside `timeout`."""
    import websockets
    from hitl_map_upload import _rpc

    async def go() -> None:
        sock = await websockets.connect(
            ws_url, max_size=2**22, ssl=_ssl_ctx(), open_timeout=timeout, close_timeout=2
        )
        try:
            await _rpc(
                sock, {"type": "hello", "client": "heavy_reach", "app_version": "1"}, "welcome"
            )
        finally:
            await sock.close()

    await asyncio.wait_for(go(), timeout=timeout)


def _attempt(ws_url: str, t0: float, timeout: float | None = None) -> dict:
    timeout = timeout or core.HANDSHAKE_S
    start = time.monotonic()
    exc: BaseException | None = None
    try:
        asyncio.run(_connect_once(ws_url, timeout + 0.5))
    except BaseException as e:  # noqa: BLE001 — every failure is a classified data point
        if isinstance(e, KeyboardInterrupt):
            raise
        exc = e
    s = time.monotonic() - start
    a = {"cat": core.classify(exc, s), "s": s, "t": time.monotonic() - t0}
    if exc is not None:
        a["err"] = f"{type(exc).__name__}: {exc}"[:160]
    _log(f"    connect @{a['t']:.1f}s: {a['cat']} in {s:.2f}s" + (f" ({a['err']})" if exc else ""))
    return a


REMOTE_DIR = "/tmp/heavyreach"


def _pidfile(tag: str) -> str:
    return f"{REMOTE_DIR}/console_{tag}.pid"


def _console(
    res, seconds: float, line: str | None = None, lead: float = 0.5, tag: str | None = None
) -> str:
    """Capture the DUT console for `seconds`, writing `line` `lead` s after the reader
    attached (provision.wire_provision_dut's tty recipe: a write wakes the C6's CDC TX;
    the Reservation's background capture is paused around it). With `tag`, the reader's
    pid lands in _pidfile(tag) once it runs: _await_console waits for it and
    _end_console ends the window early."""
    write = (
        "printf '%s\\n' {} > /dev/ttyACM0".format(shlex.quote(line))
        if line
        else "printf '\\n' > /dev/ttyACM0"
    )
    mark = f"echo $! > {_pidfile(tag)}; " if tag else ""
    cmd = (
        "stty -F /dev/ttyACM0 raw -echo 115200 2>/dev/null; "
        + f"timeout {seconds:g} cat /dev/ttyACM0 & {mark}sleep {lead:g}; "
        + write
        + "; wait"
    )
    proc = res.ssh_serialized(cmd, capture=True, timeout=seconds + 60)
    return (proc.stdout or "") + (proc.stderr or "")


def _await_console(res, tag: str, timeout: float = 90.0) -> bool:
    """Block until the tagged console reader runs (it may queue behind the rig's
    serialize lock), so what follows happens inside its window."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if res.ssh(f"test -s {_pidfile(tag)}", capture=True, timeout=30).returncode == 0:
                return True
        except Exception:  # noqa: BLE001 — retried until the deadline
            pass
        time.sleep(1.0)
    return False


def _end_console(res, tag: str) -> None:
    """End a tagged console window now (its phase is done)."""
    try:
        res.ssh(f"kill $(cat {_pidfile(tag)}) 2>/dev/null; rm -f {_pidfile(tag)}", timeout=30)
    except Exception:  # noqa: BLE001 — the window then just runs to its timeout
        pass


class _Bg:
    """Run fn() on a thread, keep its return value."""

    def __init__(self, fn) -> None:
        self.out: dict = {}

        def run() -> None:
            try:
                self.out["v"] = fn()
            except Exception as e:  # noqa: BLE001
                self.out["err"] = repr(e)

        self.th = threading.Thread(target=run, daemon=True)
        self.th.start()

    def join(self, timeout: float) -> str:
        self.th.join(timeout=timeout)
        return self.out.get("v") or ""


async def _calibrate(
    ws_url: str,
    fxb: bytes,
    args,
    duty: float = core.CAL_DUTY,
    band: tuple[float, float] = core.CAL_BAND,
    effect_id: str = "__heavyreach",
) -> dict:
    """Probe map -> frame cost -> sized map (one frame = `duty` of the floor's period),
    all in ONE session (the open session is what keeps an unfixed board reachable
    while it is set up)."""
    from hitl_map_upload import _open_ws, _rpc, _submit_chunked
    from map_upload_core import synth_output_map

    sock = await _open_ws(ws_url, True, time.monotonic() + hitl_ws.CONNECT_SETTLE)
    cal: dict = {}
    try:

        async def load(n: int, upload_id: int) -> dict:
            await _submit_chunked(
                sock, synth_output_map(n, "__heavyreach"), "MAP", upload_id, "map"
            )
            await _rpc(sock, {"type": "set_led_count", "led_count": n}, "led_count_state")
            await _rpc(
                sock,
                {
                    "type": "submit_effect",
                    "effect_id": effect_id,
                    "fxb": base64.b64encode(fxb).decode("ascii"),
                    "activate": True,
                },
                "result_ready",
            )
            await _rpc(sock, {"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
            await asyncio.sleep(args.settle)
            r = await _rpc(sock, {"type": "get_perf_report"}, "perf_report")
            await _rpc(sock, {"type": "set_perf", "mode": "OFF", "interval_ms": 0}, "perf_report")
            fs = await _rpc(sock, {"type": "set_fps", "target_fps": 0}, "fps_state")
            m = {
                "leds": n,
                "frame_cycles": r.get("frameCyclesMean") or 0,
                "frame_cycles_max": r.get("frameCyclesMax") or 0,
                "show_cycles": r.get("showCyclesMean") or 0,
                "current_fps": fs.get("currentFps"),
                "achieved_fps": fs.get("achievedFps"),
                "lagging": fs.get("lagging"),
                "heap_free": r.get("heapFree"),
            }
            m["duty"] = round(core.frame_duty(m["frame_cycles"]), 3)
            _log(f"[cal] {json.dumps(m)}")
            return m

        probe = await load(args.probe_leds, 1)
        if not probe["frame_cycles"]:
            return {}
        n = args.leds or core.leds_for_budget(probe["frame_cycles"], args.probe_leds, duty=duty)
        m = await load(n, 2)
        if not args.leds and not (band[0] <= m["duty"] <= band[1]):
            n2 = core.leds_for_budget(m["frame_cycles"], n, duty=duty)
            if n2 != n:
                m = await load(n2, 3)
        cal = {**m, "probe": probe}
    finally:
        try:
            await sock.close()
        except OSError:
            pass
    return cal


async def _hold_idle(ws_url: str, seconds: float) -> dict:
    """A live client that stays silent for `seconds` must keep its session (the
    firmware pings a quiet session to find ghosts; a live peer answers) and get an
    RPC answered at the end."""
    import websockets
    from hitl_map_upload import _rpc

    t0 = time.monotonic()
    try:
        sock = await websockets.connect(
            ws_url, max_size=2**22, ssl=_ssl_ctx(), open_timeout=hitl_ws.OPEN_TIMEOUT
        )
    except Exception as e:
        # Refused/reset before the hold began: the device RST-refused a new client
        # (load-shedding armed while the previous session was still closing).
        e.add_note(f"at connect, {time.monotonic() - t0:.1f}s in")
        raise
    try:
        await _rpc(
            sock, {"type": "hello", "client": "heavy_reach_idle", "app_version": "1"}, "welcome"
        )
        quiet = time.monotonic()
        closed_after: float | None = None
        try:
            # Sleep out the hold, but note the moment the device drops the session.
            await asyncio.wait_for(asyncio.shield(sock.wait_closed()), timeout=seconds)
            closed_after = time.monotonic() - quiet
        except asyncio.TimeoutError:
            pass
        try:
            await _rpc(sock, {"type": "set_fps", "target_fps": 0}, "fps_state", timeout=15.0)
        except Exception as e:
            # When in the hold it died, to line up with the idle console window.
            if closed_after is not None:
                e.add_note(f"session closed {closed_after:.1f}s into the quiet hold")
            raise
        return {"ok": True, "s": round(time.monotonic() - t0, 1)}
    finally:
        await sock.close()


async def _live_session(ws_url: str, seconds: float, t_win: float) -> dict:
    """ONE session driven like the agent bridge (agent/src/session.ts measureEffect +
    liveness.ts) for `seconds`: measure_effect cycles (set_perf BASIC 1 Hz, listen,
    get_perf_report, set_perf OFF, then a quiet rest) under the bridge's heartbeat: a
    time_sync_ping after HEARTBEAT_BUSY_S without a frame from the player, each allowed
    HEARTBEAT_TIMEOUT_S; HEARTBEAT_MISSES unanswered in a row (nothing else arriving)
    declare it dead, as the bridge would ("stopped answering during the call"). A dead
    or dropped session is reopened (the hub reconnects) and counted. Times in `events`
    are console-window seconds (`t_win`), to line up with the session window."""
    import websockets
    from server import proto_wire

    out: dict = {
        "opened": False,
        "deaths": 0,
        "dropped": [],
        "pings": 0,
        "pings_missed": 0,
        "reports": 0,
        "max_silence_s": 0.0,
        "events": [],
    }
    t_start = time.monotonic()
    end = t_start + seconds

    def note(what: str) -> None:
        ev = f"@{time.monotonic() - t_win:.1f}s {what}"
        out["events"].append(ev)
        _log(f"    session {ev}")

    while time.monotonic() < end:
        try:
            sock = await websockets.connect(
                ws_url,
                max_size=2**22,
                ssl=_ssl_ctx(),
                open_timeout=hitl_ws.OPEN_TIMEOUT,
                ping_interval=None,  # the bridge (Node ws) sends no WebSocket pings
            )
        except Exception as e:  # noqa: BLE001 — a failed reopen is an event, retried
            note(f"open failed: {type(e).__name__}: {e}"[:160])
            await asyncio.sleep(2.0)
            continue
        state = {"last_rx": time.monotonic(), "dead": None}
        waiters: dict[str, list[asyncio.Future]] = {}

        async def reader() -> None:
            async for raw in sock:
                now = time.monotonic()
                gap = now - state["last_rx"]
                if gap > out["max_silence_s"]:
                    out["max_silence_s"] = round(gap, 2)
                if gap > core.HEARTBEAT_BUSY_S:
                    note(f"player silent {gap:.1f}s")
                state["last_rx"] = now
                try:
                    msg = proto_wire.decode_server(raw)
                except Exception:  # noqa: BLE001 — an undecodable frame is still a sign of life
                    continue
                kind = msg.get("type")
                if kind == "perf_report":
                    out["reports"] += 1
                for fut in waiters.pop(kind, []):
                    if not fut.done():
                        fut.set_result(msg)

        async def call(flat: dict, expect: str, timeout: float) -> dict:
            fut = asyncio.get_running_loop().create_future()
            waiters.setdefault(expect, []).append(fut)
            await sock.send(proto_wire.encode_client(flat))
            return await asyncio.wait_for(fut, timeout=timeout)

        async def heartbeat() -> None:
            # liveness.ts check(): while a call is in flight (always, here) ping after
            # busyMs of silence; dead after `misses` pings with nothing arriving.
            while True:
                await asyncio.sleep(0.25)
                if time.monotonic() - state["last_rx"] < core.HEARTBEAT_BUSY_S:
                    continue
                answered = False
                for _ in range(core.HEARTBEAT_MISSES):
                    before = state["last_rx"]
                    out["pings"] += 1
                    try:
                        await call(
                            {"type": "time_sync_ping", "t0": time.time() * 1000.0},
                            "time_sync_pong",
                            core.HEARTBEAT_TIMEOUT_S,
                        )
                        answered = True
                    except asyncio.TimeoutError:
                        out["pings_missed"] += 1
                        answered = state["last_rx"] != before
                    if answered:
                        break
                if not answered:
                    silent = time.monotonic() - state["last_rx"]
                    state["dead"] = (
                        f"no reply from the player for {silent:.1f} s "
                        f"({core.HEARTBEAT_MISSES} heartbeat pings unanswered)"
                    )
                    return

        async def measure_cycles() -> None:
            await call(
                {"type": "hello", "client": "heavy_session", "app_version": "1"}, "welcome", 15.0
            )
            out["opened"] = True
            while time.monotonic() < end:
                await call(
                    {"type": "set_perf", "mode": "BASIC", "interval_ms": 1000}, "perf_report", 15.0
                )
                await asyncio.sleep(min(core.SESSION_MEASURE_S, max(0.0, end - time.monotonic())))
                await call({"type": "get_perf_report"}, "perf_report", 15.0)
                await call(
                    {"type": "set_perf", "mode": "OFF", "interval_ms": 0}, "perf_report", 15.0
                )
                await asyncio.sleep(min(core.SESSION_REST_S, max(0.0, end - time.monotonic())))

        rd = asyncio.ensure_future(reader())
        hb = asyncio.ensure_future(heartbeat())
        mc = asyncio.ensure_future(measure_cycles())
        try:
            done, _ = await asyncio.wait({rd, hb, mc}, return_when=asyncio.FIRST_COMPLETED)
            if hb in done and state["dead"]:
                out["deaths"] += 1
                note(f"DEAD: {state['dead']}")
            elif rd in done:
                exc = rd.exception()
                why = (
                    f"{type(exc).__name__}: {exc}"
                    if exc
                    else f"closed by the player ({sock.close_code})"
                )
                out["dropped"].append(f"@{time.monotonic() - t_win:.1f}s {why}"[:200])
                note(f"DROPPED: {why}"[:200])
            elif mc in done and mc.exception() is not None:
                exc = mc.exception()
                if not isinstance(exc, asyncio.TimeoutError):
                    out["dropped"].append(
                        f"@{time.monotonic() - t_win:.1f}s {type(exc).__name__}: {exc}"[:200]
                    )
                note(f"call failed: {type(exc).__name__}: {exc}"[:200])
        finally:
            for t in (rd, hb, mc):
                t.cancel()
            try:
                await asyncio.wait_for(sock.close(), timeout=5.0)
            except Exception:  # noqa: BLE001
                pass
    out["s"] = round(time.monotonic() - t_start, 1)
    return out


async def _reconnect_churn(ws_url: str, cycles: int) -> dict:
    """The agent bridge's (and the app's) reconnect pattern: open, hello, close, and
    reconnect AT ONCE, `cycles` times. The device must never RST-refuse the closing
    client's own reconnect (load-shedding re-armed while the old session waited for the
    peer's FIN). A reconnect that merely waits for the slot is fine; a reset is not."""
    import websockets
    from hitl_map_upload import _rpc

    out = {"cycles": cycles, "ok": 0, "reset": 0, "other": 0, "errs": []}
    for i in range(cycles):
        try:
            sock = await websockets.connect(
                ws_url,
                max_size=2**22,
                ssl=_ssl_ctx(),
                open_timeout=hitl_ws.OPEN_TIMEOUT,
                close_timeout=2,
            )
            try:
                await _rpc(
                    sock,
                    {"type": "hello", "client": "heavy_churn", "app_version": "1"},
                    "welcome",
                    timeout=15.0,
                )
            finally:
                await sock.close()
            out["ok"] += 1
        except Exception as e:  # noqa: BLE001 — classified below
            reset = isinstance(e, ConnectionResetError) or "reset" in str(e).lower()
            out["reset" if reset else "other"] += 1
            out["errs"].append(f"#{i} {type(e).__name__}: {e}"[:120])
    return out


def _run_attempts(ws_url: str, t0: float, deadline_s: float, follow: int, gap: float) -> list[dict]:
    """Dial until the first good connection (or `deadline_s` after t0), then `follow`
    more attempts."""
    out: list[dict] = []
    while time.monotonic() - t0 < deadline_s:
        a = _attempt(ws_url, t0)
        out.append(a)
        if a["cat"] == core.OK:
            break
        time.sleep(gap)
    if out and out[-1]["cat"] == core.OK:
        for _ in range(follow):
            time.sleep(gap)
            out.append(_attempt(ws_url, t0))
    return out


def _save_log(log_dir: str | None, name: str, text: str) -> None:
    """Write one console window to --log-dir as soon as it closes (a later crash or
    timeout must not lose it)."""
    if not log_dir:
        return
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, f"heavy_reach_{name}.log"), "w", encoding="utf-8") as f:
        f.write(text)


def _rig_ok(res) -> bool:
    try:
        return res.ssh("true", capture=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _session_phase(res, ws_url: str, args, phases: dict, logs: dict, consoles: dict) -> None:
    """[6/6] an effect past the floor (SESSION_DUTY) + one agent-style live session with
    heartbeat pings for SESSION_S, then a silent hold at the same effect."""
    _log(f"[6/6] session: a {core.SESSION_DUTY:g}x effect + an agent-style heartbeat session")
    with open(args.session_fxb, "rb") as fh:
        sfxb = fh.read()
    try:
        scal = asyncio.run(
            _calibrate(
                ws_url,
                sfxb,
                argparse.Namespace(**{**vars(args), "leds": args.session_leds}),
                duty=core.SESSION_DUTY,
                band=core.SESSION_BAND,
                effect_id="__heavysession",
            )
        )
    except (SystemExit, OSError, RuntimeError, asyncio.TimeoutError) as e:
        _log(f"  session calibration could not run: {e!r}")
        scal = {}
    if not scal:
        phases["session"] = {"verdict": "SKIP", "why": "session effect never calibrated"}
        return
    consoles["session_cal"] = {k: scal.get(k) for k in ("leds", "duty", "achieved_fps", "lagging")}
    window = core.session_window_s(args.session_s, args.hold_idle, hitl_ws.OPEN_TIMEOUT)
    res.ssh(f"mkdir -p {REMOTE_DIR}; rm -f {_pidfile('session')}", timeout=30)
    bg = _Bg(lambda: _console(res, window, tag="session"))
    t_win = time.monotonic()
    if not _await_console(res, "session"):
        _log("  session console window did not attach; continuing without it")
    _log(f"  session console window ({window:g}s) open")
    live = asyncio.run(_live_session(ws_url, args.session_s, t_win))
    summary = {k: v for k, v in live.items() if k != "events"}
    _log(f"  live session: {summary}")
    held = None
    if args.hold_idle > 0:
        try:
            held = asyncio.run(_hold_idle(ws_url, args.hold_idle))
        except Exception as e:  # noqa: BLE001 — reported, graded below
            notes = " ".join(getattr(e, "__notes__", []))
            held = {"ok": False, "err": f"{type(e).__name__}: {e} {notes}".strip()[:200]}
        held["window_end_s"] = round(time.monotonic() - t_win, 1)
        _log(f"  quiet session held {args.hold_idle:g}s at the session effect: {held}")
    churn = asyncio.run(_reconnect_churn(ws_url, core.CHURN_CYCLES))
    _log(f"  reconnect churn: {churn}")
    live["churn"] = churn
    _end_console(res, "session")
    logs["session"] = bg.join(window + 120)
    _save_log(args.log_dir, "session", logs["session"])
    phases["session"] = core.grade_session(live, held, rig_ok=_rig_ok(res))
    consoles["session"] = {
        **core.summarize_console(logs["session"]),
        "events": live.get("events", [])[-20:],
        "held": held,
    }
    _log(f"  session: {json.dumps(phases['session'])} console={consoles['session']}")


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, ensure_booted, wire_provision_dut

    with open(args.fxb, "rb") as fh:
        fxb = fh.read()
    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    baseline_ok = False
    cal: dict = {}
    phases: dict[str, dict] = {}
    logs: dict[str, str] = {}
    consoles: dict[str, dict] = {}
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        if not args.no_flash:
            res.ssh("mkdir -p /tmp/heavyreach")
            res.scp_to([args.bundle], "/tmp/heavyreach/")
            remote = f"/tmp/heavyreach/{os.path.basename(args.bundle)}"
            _log("[1/6] flash --erase-fs + wired PROV onto the rig AP")
            proc = res.ssh_serialized(
                f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds 10",
                capture=True,
                timeout=320,
            )
            if proc.returncode != 0:
                raise HarnessError(f"hitl-flash exited {proc.returncode}")
            ensure_booted(res, (proc.stdout or "") + (proc.stderr or ""), 10.0)
        try:
            url = wire_provision_dut(res, ssid, password, args.lease_timeout)
        except HarnessError as e:
            _log(f"  provisioning failed: {e}")
            url = ""
        if url:
            ip = urlparse(url).hostname
            with res.forward(ip, 443) as port:
                ws_url = f"wss://localhost:{port}/ws"
                base = _attempt(ws_url, time.monotonic(), timeout=hitl_ws.OPEN_TIMEOUT)
                baseline_ok = base["cat"] == core.OK
                if not baseline_ok:
                    # A freshly provisioned board may still be issuing its LAN cert.
                    time.sleep(10)
                    baseline_ok = (
                        _attempt(ws_url, time.monotonic(), hitl_ws.OPEN_TIMEOUT)["cat"] == core.OK
                    )
                if baseline_ok:
                    _log("[2/6] calibrate the heavy effect to the 25 fps floor")
                    try:
                        cal = asyncio.run(_calibrate(ws_url, fxb, args))
                    except (SystemExit, OSError, RuntimeError, asyncio.TimeoutError) as e:
                        _log(f"  calibration could not run: {e!r}")
                if cal:
                    if "idle" in args.phases:
                        _log(
                            f"[3/6] idle: sessions closed {args.idle_wait:g}s, then NEW connections"
                        )
                        window = core.idle_window_s(
                            args.hold_idle, args.idle_wait, args.gap, hitl_ws.OPEN_TIMEOUT
                        )
                        res.ssh(f"mkdir -p {REMOTE_DIR}; rm -f {_pidfile('idle')}", timeout=30)
                        bg = _Bg(lambda: _console(res, window, tag="idle"))
                        t_win = time.monotonic()
                        if not _await_console(res, "idle"):
                            _log("  idle console window did not attach; continuing without it")
                        _log(f"  idle console window ({window:g}s) open")
                        if args.hold_idle > 0:
                            try:
                                held = asyncio.run(_hold_idle(ws_url, args.hold_idle))
                            except Exception as e:  # noqa: BLE001 — reported, graded below
                                notes = " ".join(getattr(e, "__notes__", []))
                                held = {
                                    "ok": False,
                                    "err": f"{type(e).__name__}: {e} {notes}".strip()[:200],
                                }
                            # When the hold ended, in idle-console-window time.
                            held["window_end_s"] = round(time.monotonic() - t_win, 1)
                            _log(f"  quiet session held {args.hold_idle:g}s: {held}")
                            consoles["held_session"] = held
                        time.sleep(args.idle_wait)
                        t0 = time.monotonic()
                        attempts: list[dict] = []
                        while len(attempts) < core.MAX_ATTEMPTS:
                            attempts.append(_attempt(ws_url, t0))
                            if core.longest_ok_run([a["cat"] for a in attempts]) >= core.STREAK:
                                break
                            time.sleep(args.gap)
                        _end_console(res, "idle")
                        logs["idle"] = bg.join(window + 120)
                        _save_log(args.log_dir, "idle", logs["idle"])
                        phases["idle"] = core.grade_idle(
                            attempts,
                            rig_ok=_rig_ok(res),
                            held=consoles.get("held_session", {}).get("ok", True),
                        )
                        consoles["idle"] = core.summarize_console(logs["idle"])
                        _log(f"  idle: {json.dumps(phases['idle'])} console={consoles['idle']}")
                    if "rejoin" in args.phases:
                        bogus = f"hitl-no-such-ap-{uuid.uuid4().hex[:6]}"
                        _log(f"[4/6] rejoin: PROV {bogus!r}, then the rig AP again")
                        logs["rejoin_drop"] = _console(res, 8.0, f"PROV {bogus} not-a-real-pass")
                        _save_log(args.log_dir, "rejoin_drop", logs["rejoin_drop"])
                        bg = _Bg(
                            lambda: _console(
                                res, core.REJOIN_DEADLINE_S + 30, f"PROV {ssid} {password}"
                            )
                        )
                        time.sleep(0.6)  # the PROV goes out 0.5 s into the capture
                        t0 = time.monotonic()
                        attempts = _run_attempts(
                            ws_url, t0, core.REJOIN_DEADLINE_S + 20, core.FOLLOW_STREAK, args.gap
                        )
                        logs["rejoin"] = bg.join(core.REJOIN_DEADLINE_S + 120)
                        _save_log(args.log_dir, "rejoin", logs["rejoin"])
                        phases["rejoin"] = core.grade_reconnect(
                            attempts, core.REJOIN_DEADLINE_S, rig_ok=_rig_ok(res)
                        )
                        consoles["rejoin"] = {
                            **core.summarize_console(logs["rejoin"]),
                            "leased": core.leased(logs["rejoin"]),
                        }
                        _log(
                            f"  rejoin: {json.dumps(phases['rejoin'])} console={consoles['rejoin']}"
                        )
                    if "boot" in args.phases:
                        _log("[5/6] boot: reset with the heavy effect persisted")
                        bg = _Bg(
                            lambda: (lambda p: (p.stdout or "") + (p.stderr or ""))(
                                res.ssh_serialized(
                                    f"hitl-monitor --reset --seconds {core.BOOT_DEADLINE_S + 20:g}",
                                    capture=True,
                                    timeout=core.BOOT_DEADLINE_S + 120,
                                )
                            )
                        )
                        t0 = time.monotonic()
                        time.sleep(3.0)
                        attempts = _run_attempts(
                            ws_url, t0, core.BOOT_DEADLINE_S + 20, core.FOLLOW_STREAK, args.gap
                        )
                        logs["boot"] = bg.join(core.BOOT_DEADLINE_S + 180)
                        _save_log(args.log_dir, "boot", logs["boot"])
                        booted = core.booted(logs["boot"])
                        phases["boot"] = core.grade_reconnect(
                            attempts, core.BOOT_DEADLINE_S, booted=booted, rig_ok=_rig_ok(res)
                        )
                        consoles["boot"] = {
                            **core.summarize_console(logs["boot"]),
                            "leased": core.leased(logs["boot"]),
                        }
                        _log(f"  boot: {json.dumps(phases['boot'])} console={consoles['boot']}")
                    if "session" in args.phases:
                        _session_phase(res, ws_url, args, phases, logs, consoles)
    finally:
        res.release()

    g = core.verdict(baseline_ok, bool(cal), phases)
    if g["verdict"] == "FAIL":
        for name, whole in core.windows_to_print(phases, list(logs)):
            text = logs[name]
            if whole or len(text) <= core.PASS_WINDOW_TAIL:
                _log(f"----- {name} console window (whole, {len(text)} chars) -----")
                _log(text)
            else:
                _log(f"----- {name} console window (tail; whole file in the test outputs) -----")
                _log(text[-core.PASS_WINDOW_TAIL :])
        tail = res.serial_tail()
        if tail:
            _log(tail)
    cal_short = {k: cal.get(k) for k in ("leds", "duty", "current_fps", "achieved_fps", "lagging")}
    _log(
        "HEAVY_REACH_JSON "
        + json.dumps(
            {"cal": cal, "phases": phases, "consoles": consoles, **g}, sort_keys=True, default=str
        )
    )
    _log(core.result_line(res._unit or "?", cal_short if cal else {}, phases, g))
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE") or None)
    ap.add_argument("--bundle", default=_runfile(os.environ.get("HITL_BUNDLE_RUNFILE")))
    ap.add_argument("--fxb", default=_runfile(os.environ.get("HEAVY_FXB_RUNFILE")))
    ap.add_argument("--no-flash", action="store_true", help="test the firmware already on the DUT")
    ap.add_argument("--probe-leds", type=int, default=128, help="calibration probe map size")
    ap.add_argument("--leds", type=int, default=0, help="skip calibration: use this map size")
    ap.add_argument("--settle", type=float, default=3.0, help="perf window before a cost read (s)")
    ap.add_argument("--idle-wait", type=float, default=core.IDLE_WAIT_S)
    ap.add_argument(
        "--hold-idle",
        type=float,
        default=core.HOLD_IDLE_S,
        help="first hold one silent session this long; it must still answer (0 = skip)",
    )
    ap.add_argument("--gap", type=float, default=2.0, help="pause between connection attempts (s)")
    ap.add_argument("--phases", default="idle,rejoin,boot,session")
    ap.add_argument(
        "--session-fxb",
        default=_runfile(os.environ.get("SESSION_FXB_RUNFILE")),
        help="the session phase's effect (heavySession.fxb)",
    )
    ap.add_argument("--session-leds", type=int, default=0, help="session map size (0 = calibrate)")
    ap.add_argument(
        "--session-s", type=float, default=core.SESSION_S, help="live heartbeat session (s)"
    )
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument(
        "--log-dir",
        default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"),
        help="save each console window here (default: the test outputs dir)",
    )
    args = ap.parse_args()
    if not args.fxb or (not args.bundle and not args.no_flash):
        raise SystemExit("need --bundle and --fxb (run via bazel)")
    if "session" in args.phases and not args.session_fxb:
        raise SystemExit("the session phase needs --session-fxb (run via bazel)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
