#!/usr/bin/env python3
"""Per-channel mapping capture driven entirely over BLE (no WiFi) — Halloween 2026.

The phone maps a fixture with a dense LED curtain on CH0 and a strided, diffused
LED rope on CH1 while connected ONLY over Bluetooth (the "Connect over Bluetooth
(offline)" player transport). The device plays the code pattern itself from the
pattern epoch; the app only sends start/configure/stop and finally pushes the map.
This test drives the EXACT message sequence the app's per-channel capture sends
(web/src/capture/channelCapture.ts + ui/screens/capture.ts) over GATT and asserts
each reply, with the requests paced like the app's phase rotation:

  1. hello -> welcome;
  2. start_mapping(ledCount = total, codeSpace = total, brightness 0) — the
     blank-first frame that latches black on every channel;
  3. configure(ledCount = n0, brightness 1) — stage 1, the curtain, dense; the
     code book must stay the WHOLE fixture's (same ledCount/bits);
  4. get_frame_timing — the pattern really renders while BLE is connected;
  5. configure(ledCount = total, stride S, phase 0) — stage 2, the rope, strided;
  6. configure(stridePhase = k) for every remaining phase (2S-1 in all);
  7. get_frame_timing again;
  8. stop_mapping(solveOnHost = false) -> mapping_stopped;
  9. submit_map of every LED, sharded into the app's 1024 B BLE windows ->
     chunk_ack* + result_ready (the Push at the end of the capture).

Reports the per-request BLE round trip so the timing budget is on record.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys

import hitl_e2e  # flash() + default_bundle()
from hitl_client import Reservation
from mapping_trigger_core import frame_ticks_in
from provision import reserved_board_ble_mac

_HERE = os.path.dirname(os.path.abspath(__file__))
_DRIVER = os.path.join(_HERE, "hitl_ble_player.py")
_IMPROV = os.path.join(_HERE, "hitl_improv.py")
_CODEC = os.path.join(_HERE, "improv.py")

BLE_WINDOW = 1024  # web/src/net/bleTransport.ts BLE_UPLOAD_CHUNK_BYTES


def stride_phase_count(spacing: int) -> int:
    return 1 if spacing <= 1 else 2 * spacing - 1


def build_sequence(n0: int, n1: int, stride: int, anchor: int = 3):
    """[(label, flat ClientMessage, expected reply type)] — the app's sequence."""
    total = n0 + n1
    seq = [
        (
            "hello",
            {"type": "hello", "client": "hitl_ble_capture_e2e", "app_version": "1"},
            "welcome",
        ),
        (
            "start(blank)",
            {
                "type": "start_mapping",
                "options": {
                    "ledCount": total,
                    "codeSpace": total,
                    "brightness": 0.0,
                    "symbols": 4,
                    "bitPeriodMs": 100,
                },
            },
            "mapping_started",
        ),
        (
            "stage1",
            {"type": "configure", "options": {"ledCount": n0, "brightness": 1.0}},
            "pattern_state",
        ),
        ("timing1", {"type": "get_frame_timing"}, "frame_timing"),
        (
            "stage2",
            {
                "type": "configure",
                "options": {
                    "ledCount": total,
                    "strideSpacing": stride,
                    "anchorDensity": anchor,
                    "stridePhase": 0,
                },
            },
            "pattern_state",
        ),
    ]
    for k in range(1, stride_phase_count(stride)):
        seq.append(
            (f"phase{k}", {"type": "configure", "options": {"stridePhase": k}}, "pattern_state")
        )
    seq.append(("timing2", {"type": "get_frame_timing"}, "frame_timing"))
    seq.append(("stop", {"type": "stop_mapping", "solveOnHost": False}, "mapping_stopped"))
    return seq


def map_windows(total: int):
    """submit_map for every LED, sharded like the app's BLE upload."""
    from server import proto_wire

    leds = [
        {
            "id": i,
            "xyz": [i * 0.01, (i % 15) * 0.06, 0.0],
            "confidence": 0.0 if i % 4 else 0.9,
            "nViews": 0 if i % 4 else 5,
        }
        for i in range(total)
    ]
    frame = proto_wire.encode_client(
        {"type": "submit_map", "map": {"map_id": "__ble_capture", "led_count": total, "leds": leds}}
    )
    out = []
    spans = [(off, min(off + BLE_WINDOW, len(frame))) for off in range(0, len(frame), BLE_WINDOW)]
    for seq, (off, end) in enumerate(spans):
        out.append(
            {
                "type": "upload_chunk",
                "upload_id": 7,
                "seq": seq,
                "last": end >= len(frame),
                "kind": "MAP",
                "payload": base64.b64encode(frame[off:end]).decode("ascii"),
            }
        )
    return out, len(frame)


def check_replies(seq, replies, total: int, n0: int, stride: int) -> list[str]:
    """Assertion failures (empty = PASS) for the capture part of the sequence."""
    errs: list[str] = []
    bits = None
    for (label, _msg, want), r in zip(seq, replies):
        got = r.get("type")
        if got != want:
            errs.append(f"{label}: expected {want}, got {got}: {r}")
            continue
        cp = r.get("codeParams") or {}
        if want in ("mapping_started", "pattern_state"):
            if int(cp.get("ledCount") or 0) != total:
                errs.append(
                    f"{label}: code book ledCount {cp.get('ledCount')} != whole fixture {total}"
                )
            if bits is None:
                bits = cp.get("bits")
            elif cp.get("bits") != bits:
                errs.append(
                    f"{label}: code bits changed {bits} -> {cp.get('bits')} (ids would not fuse)"
                )
        if want == "pattern_state" and not r.get("active"):
            errs.append(f"{label}: capture not active: {r}")
        if label == "stage1" and int(cp.get("strideSpacing") or 0) > 1:
            errs.append(f"stage1: expected dense (no stride), got {cp}")
        if label == "stage2" and int(cp.get("strideSpacing") or 0) != stride:
            errs.append(f"stage2: expected stride {stride}, got {cp}")
        if label.startswith("phase") and int(cp.get("stridePhase") or 0) != int(label[5:]):
            errs.append(f"{label}: stridePhase {cp.get('stridePhase')}")
        if label.startswith("timing") and frame_ticks_in(r) < 1:
            errs.append(
                f"{label}: no mapping-pattern frames rendered while connected over BLE: {r}"
            )
    return errs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sku", required=True, help="hardware SKU (esp32c6)")
    ap.add_argument("--require-caps", default="improv", help="comma-separated caps to reserve by")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--bundle", default=os.environ.get("HITL_BUNDLE"), help="C6 flash bundle .tar")
    ap.add_argument("--curtain", type=int, default=300, help="CH0 LEDs (regular)")
    ap.add_argument("--rope", type=int, default=120, help="CH1 LEDs (strided)")
    ap.add_argument("--stride", type=int, default=4)
    ap.add_argument("--gap-ms", type=float, default=600.0, help="pause between requests")
    ap.add_argument("--timeout", type=float, default=40.0)
    args = ap.parse_args()

    if args.sku != "esp32c6":
        raise SystemExit(f"ble_capture_e2e has no setup path for SKU {args.sku!r}")

    from server import proto_wire  # driver-side codec (this runner, not the rig)

    total = args.curtain + args.rope
    seq = build_sequence(args.curtain, args.rope, args.stride)
    windows, map_bytes = map_windows(total)
    frames = [proto_wire.encode_client(m) for _l, m, _w in seq] + [
        proto_wire.encode_client(w) for w in windows
    ]
    frames_b64 = ",".join(base64.b64encode(f).decode("ascii") for f in frames)
    print(
        f"[ble-capture] {len(seq)} capture requests + {len(windows)} map windows "
        f"({map_bytes}B map, {total} LEDs = {args.curtain} curtain + {args.rope} rope @ stride {args.stride})",
        flush=True,
    )

    caps = [c.strip() for c in args.require_caps.split(",") if c.strip()]
    res = Reservation(server=args.server, owner=args.owner, sku=args.sku, require_caps=caps)
    res.acquire()
    print(f"[ble-capture] reserved {res.id} sku={args.sku} caps={caps} on {res.server}", flush=True)
    try:
        bundle = args.bundle or hitl_e2e.default_bundle()
        if not bundle:
            raise SystemExit("no flash bundle in runfiles; pass --bundle")
        hitl_e2e.flash(res, bundle, monitor_seconds=12)
        mac = reserved_board_ble_mac(res)
        if mac:
            print(f"[ble-capture] pinning scan to reserved board {mac}", flush=True)
        res.scp_to([_DRIVER, _IMPROV, _CODEC], "/tmp/")
        cmd = (
            f"PYTHONPATH=/tmp python3 /tmp/hitl_ble_player.py exchange "
            f"--frames-b64 {frames_b64} --timeout {args.timeout:g} --gap-ms {args.gap_ms:g}"
        )
        if mac:
            cmd += f" --address {mac}"
        proc = res.ssh(cmd, capture=True, timeout=args.timeout * 2 + 300)
        out = (proc.stdout or "").strip()
        if proc.stderr:
            sys.stderr.write(proc.stderr)
        try:
            result = json.loads(out.splitlines()[-1])
        except (ValueError, IndexError) as e:
            raise SystemExit(
                f"BLE driver gave no JSON result (exit {proc.returncode}): {out!r}"
            ) from e
        if not result.get("ok"):
            raise SystemExit(f"BLE exchange failed: {result.get('error')}")
        replies = [proto_wire.decode_server(base64.b64decode(r)) for r in result["replies_b64"]]
        rtts = result.get("rtts_ms") or []
        if len(replies) != len(frames):
            raise SystemExit(f"expected {len(frames)} replies, got {len(replies)}")

        errs = check_replies(seq, replies[: len(seq)], total, args.curtain, args.stride)
        up = replies[len(seq) :]
        for i, r in enumerate(up[:-1]):
            if r.get("type") != "chunk_ack":
                errs.append(f"map window {i}: expected chunk_ack, got {r.get('type')}: {r}")
        if up[-1].get("type") != "result_ready":
            errs.append(f"map final window: expected result_ready, got {up[-1]}")

        for (label, _m, _w), r, ms in zip(seq, replies, rtts):
            extra = f" ticks={frame_ticks_in(r)}" if label.startswith("timing") else ""
            print(
                f"[ble-capture] {label:<12} -> {r.get('type'):<16} {ms:7.1f} ms{extra}", flush=True
            )
        cap_rtts = rtts[1 : len(seq)]
        map_rtts = rtts[len(seq) :]
        print(
            f"[ble-capture] capture requests: max {max(cap_rtts):.0f} ms, "
            f"mean {sum(cap_rtts) / len(cap_rtts):.0f} ms; map push: {len(map_rtts)} windows in "
            f"{sum(map_rtts) / 1000:.1f} s ({map_bytes / max(sum(map_rtts), 1):.2f} kB/s)",
            flush=True,
        )
        if errs:
            for e in errs:
                print(f"[ble-capture] FAIL: {e}", flush=True)
            raise SystemExit(1)
        print("[ble-capture] PASS — per-channel capture + map push over BLE only", flush=True)
        return 0
    finally:
        res.release()


if __name__ == "__main__":
    sys.exit(main())
