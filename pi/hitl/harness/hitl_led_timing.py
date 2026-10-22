"""On-hardware WS2812 wire-timing capture: drive an animated effect on a real C6 and
record per-frame timing from the rig's shared logic analyzer (broker op=timing).

Built for the coil-lamp "LED pops + 10 s phase jumps" investigation: the suspected
cause is an RMT underrun (the C6 RMT has no DMA, and its ISR is masked during SPI
flash ops) stretching a LOW mid-frame past the WS2812 latch threshold, so the strip
latches early. That is visible ONLY on the wire — and per the "don't disturb the DUT
with metric reporting" rule, nothing here instruments the firmware. The analyzer
reports every frame's start/duration/LED count, intra-frame gaps, runt/split frames
and sample drops; this script captures the same effect under a few WiFi load modes
and summarises when anomalies happen (so a fixed period, e.g. 10 s, stands out).

Modes (each one capture of --duration-ms):
  noclient  WebSocket closed — the DUT renders with no client traffic
  idle      a client connected but silent
  busy      a client flooding time_sync_ping round-trips (RAM-only on the device)
  reconnect a fresh TLS connection every ~1.5 s (handshake load)

Usage:
    bazel run //pi/hitl/harness:led_timing -- --server http://hitl-rig-2:8087 \\
        --leds 250 --duration-ms 30000 --out /tmp/led_timing

Raw broker JSON per mode lands in --out (frames + summary; --edges adds raw edges).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import threading
import time
import urllib.request

import hitl_ws
from hitl_client import Reservation, ReserveError
from hitl_led_capture import (
    _channel_map,
    _connect_ws,
    _linear_map,
    _reserved_device,
    _resolve_ch1_pin,
    _set_channel_map,
    flash,
    require_analyzer,
)
from provision import dut_target, provision_dut


def _log(msg: str) -> None:
    print(msg, flush=True)


def _ssl_ctx(ws_url: str):
    if not ws_url.startswith("wss:"):
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _rpc(sock, flat: dict, expect: str) -> dict:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        msg = proto_wire.decode_server(
            await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
        )
        if msg.get("type") == expect:
            return msg
        if msg.get("type") == "error":
            raise SystemExit(f"[drive] device error: {msg}")


async def _submit_map(sock, leds: int) -> None:
    """Submit the linear map in upload_chunk windows (like fx_bench / the web
    client): a 250-LED map is ~4.5 KB encoded, larger than the heapless
    netstack can buffer as one TLS record. HITL_CHUNK_BYTES sizes the windows."""
    from map_upload_core import window_plan
    from server import proto_wire

    flat = _linear_map(leds)
    frame = proto_wire.encode_client(flat)
    windows = window_plan(len(frame))
    if len(windows) <= 1:
        await _rpc(sock, flat, "result_ready")
        return
    for seq, off, end, last in windows:
        chunk = {
            "type": "upload_chunk",
            "upload_id": 1,
            "seq": seq,
            "last": last,
            "kind": "MAP",
            "payload": base64.b64encode(frame[off:end]).decode("ascii"),
        }
        await _rpc(sock, chunk, "result_ready" if last else "chunk_ack")


async def _setup(ws_url: str, fxb_b64: str, leds: int, split: int) -> None:
    """Load a linear map + strip length (split across both channels when `split`
    > 0: channel 0 drives the first `split` LEDs) and activate the effect."""
    counts = ((0, split), (1, leds - split)) if split > 0 else ((0, leds),)
    # Strip lengths first: the per-LED buffers are sized at boot for the persisted
    # counts, so outgrowing them persists + restarts the device into the new size.
    sock = await _connect_ws(ws_url, _ssl_ctx(ws_url))
    async with sock:
        await _rpc(sock, {"type": "hello", "client": "led_timing", "app_version": "1"}, "welcome")
        reboot = False
        for ch, n in counts:
            st = await _rpc(
                sock, {"type": "set_led_count", "led_count": n, "channel": ch}, "led_count_state"
            )
            reboot |= bool(st.get("rebootRequired"))
    if reboot:
        _log("[drive] device restarting to resize its LED buffers; reconnecting…")
        await asyncio.sleep(10.0)
    sock = await _connect_ws(ws_url, _ssl_ctx(ws_url), 90.0)
    async with sock:
        await _rpc(sock, {"type": "hello", "client": "led_timing", "app_version": "1"}, "welcome")
        await _submit_map(sock, leds)
        await _rpc(
            sock,
            {"type": "submit_effect", "effect_id": "__ledtiming", "fxb": fxb_b64, "activate": True},
            "result_ready",
        )
    _log(
        f"[drive] {leds}-LED map + effect latched"
        + (f" (split {split}+{leds - split})" if split > 0 else "")
    )


async def _handshake_once(ws_url: str) -> None:
    sock = await _connect_ws(ws_url, _ssl_ctx(ws_url), settle_s=5.0)
    async with sock:
        await _rpc(sock, {"type": "hello", "client": "led_timing", "app_version": "1"}, "welcome")


async def _hold(ws_url: str, mode: str, stop: threading.Event, stats: dict) -> None:
    """Keep a client connected (idle), flood pings (busy), or repeatedly open a
    fresh TLS connection (reconnect) until `stop`."""
    if mode == "reconnect":
        stats["connected"] = True
        stats["handshakes"] = []
        while not stop.is_set():
            t0 = time.time()
            try:
                await asyncio.wait_for(_handshake_once(ws_url), timeout=15.0)
                stats["handshakes"].append((t0, time.time() - t0, True))
            except Exception:  # noqa: BLE001 — a failed handshake is data here, not an error
                stats["handshakes"].append((t0, time.time() - t0, False))
            await asyncio.sleep(1.5)
        return
    sock = await _connect_ws(ws_url, _ssl_ctx(ws_url))
    async with sock:
        await _rpc(sock, {"type": "hello", "client": "led_timing", "app_version": "1"}, "welcome")
        stats["connected"] = True
        while not stop.is_set():
            if mode == "busy":
                await _rpc(sock, {"type": "time_sync_ping", "t0": time.time()}, "time_sync_pong")
                stats["pings"] = stats.get("pings", 0) + 1
            else:
                await asyncio.sleep(0.2)


def _timing(server: str, unit: str, args: argparse.Namespace) -> dict:
    body = {
        "op": "timing",
        "unit": unit,
        "duration_ms": args.duration_ms,
        "include_frames": True,
        "include_edges": args.edges,
    }
    if args.pixels:
        body["include_pixels"] = True
        body["max_pixel_frames"] = args.max_pixel_frames
    if args.samplerate:
        body["samplerate"] = args.samplerate
    req = urllib.request.Request(
        server.rstrip("/") + "/shared/logic-analyzer",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120 + args.duration_ms / 1000.0) as r:
        return json.loads(r.read())


def _capture_channel(server: str, unit: str, args: argparse.Namespace, pin: str | None) -> dict:
    """One timing capture of `unit`'s channel 0 tap, or — with `pin` — of that
    analyzer channel (channel 1's tap), restoring the rig's channel map after."""
    if pin is None:
        return _timing(server, unit, args)
    original = _channel_map(server)
    key = unit if unit in original else "default"
    remapped = json.loads(json.dumps(original))
    remapped[key] = {
        "channels": [pin],
        "protocol": (original.get(key) or {}).get("protocol", "ws2812"),
    }
    _set_channel_map(server, remapped)
    try:
        return _timing(server, unit, args)
    finally:
        _set_channel_map(server, original)


def summarize(mode: str, res: dict) -> None:
    """Print the broker summary plus WHEN anomalies happen (period hunting)."""
    c, s = res.get("capture") or {}, res.get("summary") or {}
    _log(
        f"[{mode}] capture {c.get('duration_ms', 0):.0f} ms @ {c.get('sample_rate', 0)} Hz"
        f"{'  DROP SUSPECTED' if c.get('drop_suspected') else ''}"
    )
    for n in c.get("notes") or []:
        _log(f"[{mode}]   note: {n}")
    _log(
        f"[{mode}] frames {s.get('frames', 0)} (complete {s.get('complete_frames', 0)}), "
        f"modal {s.get('modal_leds', 0)} LEDs, histogram {s.get('led_histogram')}"
    )
    _log(
        f"[{mode}] runts={s.get('runts', 0)} oversize={s.get('oversize', 0)} "
        f"gaps={s.get('frames_with_gaps', 0)} short_gap_before={s.get('short_gap_before', 0)} "
        f"bad_bit={s.get('bad_bit_frames', 0)} max_intra_gap={s.get('max_intra_gap_us', 0):.1f}us"
    )
    for k in ("period_us", "duration_us", "gap_before_us", "intra_gap_max_us"):
        v = s.get(k) or {}
        _log(
            f"[{mode}]   {k:<16} min {v.get('min', 0):.1f} med {v.get('median', 0):.1f} "
            f"p99 {v.get('p99', 0):.1f} max {v.get('max', 0):.1f}"
        )
    frames = res.get("frames") or []
    flagged = [f for f in frames if f.get("flags")]
    times = [f["start_us"] / 1e6 for f in flagged]
    _log(f"[{mode}] {len(flagged)} flagged frame(s) at t(s)={[round(t, 3) for t in times[:40]]}")
    if len(times) > 1:
        d = [round(b - a, 3) for a, b in zip(times, times[1:])]
        _log(f"[{mode}]   intervals(s) {d[:40]}")
    # Long inter-frame stalls (a frame-pacing hiccup a viewer sees as a phase jump).
    gaps = sorted(
        (f for f in frames if f.get("gap_before_us") is not None),
        key=lambda f: -f["gap_before_us"],
    )[:8]
    _log(
        f"[{mode}] longest gap_before: "
        + ", ".join(f"{f['gap_before_us'] / 1e3:.1f}ms@{f['start_us'] / 1e6:.2f}s" for f in gaps)
    )
    px = res.get("pixels") or (frames[0].get("pixels") if frames else None)
    if px:
        show = lambda p: "#%02x%02x%02x" % (p["r"], p["g"], p["b"])  # noqa: E731
        _log(
            f"[{mode}]   pixels ({len(px)}): "
            + " ".join(show(p) for p in px[:3])
            + " … "
            + " ".join(show(p) for p in px[-3:])
        )
    for f in flagged[:20]:
        _log(
            f"[{mode}]   frame {f['index']} @{f['start_us'] / 1e6:.3f}s {f['leds']} LEDs "
            f"(+{f.get('trailing_bits', 0)} bits) {','.join(f['flags'])} "
            f"max_gap {f.get('max_intra_gap_us', 0):.1f}us"
        )


def run(args: argparse.Namespace) -> int:
    with open(args.fxb, "rb") as fh:
        fxb_b64 = base64.b64encode(fh.read()).decode("ascii")
    os.makedirs(args.out, exist_ok=True)
    res = Reservation(
        server=args.server or None, owner=args.owner, require="analyzer", device=args.device or None
    )
    try:
        res.acquire()
    except ReserveError as e:
        _log(f"[reserve] {e}")
        return 2
    require_analyzer(res.server)
    try:
        creds = res.wifi()
        if creds:
            ssid, pw = creds
        else:
            ssid, pw = args.wifi_ssid, args.wifi_pass
        if not args.no_flash:
            flash(res, args.bundle, args.monitor_seconds)
        redirect = provision_dut(res, ssid, pw, args.improv_timeout)
        host, port = dut_target(redirect, args.ws_scheme)
        unit = getattr(res, "device", "") or _reserved_device(res.server, getattr(res, "id", None))
        _log(f"[capture] unit {unit!r} via {res.server}")
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            asyncio.run(_setup(ws_url, fxb_b64, args.leds, args.split))
            ch1_pin = (
                _resolve_ch1_pin(res.server, unit, "auto", args.ch1_pairs)
                if args.split > 0
                else None
            )
            time.sleep(1.0)
            for mode in args.modes.split(","):
                stop, stats = threading.Event(), {}
                holder = None
                if mode in ("idle", "busy", "reconnect"):
                    holder = threading.Thread(
                        target=lambda m=mode: asyncio.run(_hold(ws_url, m, stop, stats)),
                        daemon=True,
                    )
                    holder.start()
                    for _ in range(100):
                        if stats.get("connected"):
                            break
                        time.sleep(0.3)
                    time.sleep(1.0)
                for ch in (0, 1) if args.split > 0 else (0,):
                    tag = f"{mode}" + (f"_ch{ch}" if args.split > 0 else "")
                    t_req = time.time()
                    _log(f"[{tag}] capturing {args.duration_ms} ms (requested at {t_req:.3f})")
                    result = _capture_channel(res.server, unit, args, ch1_pin if ch else None)
                    if stats.get("handshakes") is not None:
                        # Offsets from the capture request (the capture itself starts a
                        # little later, by its broker setup time).
                        result["handshakes"] = [
                            {"t_s": round(t - t_req, 3), "dur_s": round(d, 3), "ok": ok}
                            for t, d, ok in stats["handshakes"]
                        ]
                    path = os.path.join(args.out, f"timing_{tag}.json")
                    with open(path, "w") as fh:
                        json.dump(result, fh)
                    _log(
                        f"[{tag}] wrote {path}"
                        + (f" ({stats.get('pings', 0)} pings)" if stats else "")
                    )
                    summarize(tag, result)
                stop.set()
                if holder:
                    holder.join(timeout=30)
        return 0
    finally:
        res.release()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--bundle", default=_runfile("HITL_BUNDLE_RUNFILE"))
    ap.add_argument("--fxb", default=_runfile("LED_TIMING_FXB_RUNFILE"), help="animated effect")
    ap.add_argument("--leds", type=int, default=250)
    ap.add_argument("--duration-ms", type=int, default=30000)
    ap.add_argument("--samplerate", default="", help="e.g. 12m (default: broker's)")
    ap.add_argument("--edges", action="store_true", help="also return raw edges")
    ap.add_argument("--modes", default="noclient,idle,busy")
    ap.add_argument(
        "--split",
        type=int,
        default=0,
        help="drive two channels: channel 0 gets the first SPLIT LEDs, channel 1 the rest; "
        "each mode then captures both channels' taps",
    )
    ap.add_argument("--ch1-pairs", default="D6:D0,D7:D1", help="ch0->ch1 analyzer tap pairs")
    ap.add_argument("--pixels", action="store_true", help="decode pixels of the first frames")
    ap.add_argument("--max-pixel-frames", type=int, default=2, help="with --pixels: how many")
    ap.add_argument("--out", default="led_timing_out")
    ap.add_argument("--no-flash", action="store_true", help="reuse the DUT's current firmware")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", ""))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "led_timing"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE"))
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID", ""))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--monitor-seconds", type=float, default=12.0)
    ap.add_argument("--ws-scheme", default="wss", choices=["ws", "wss"])
    args = ap.parse_args()
    if not args.bundle or not args.fxb:
        _log("need --bundle and --fxb (none in runfiles)")
        return 2
    return run(args)


def _runfile(env: str):
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(os.environ[env])
    except Exception:
        return None


if __name__ == "__main__":
    raise SystemExit(main())
