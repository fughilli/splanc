#!/usr/bin/env python3
"""HITL: Pi player -> spi_ws281x SPI continuity (the 20-port FIFO risk).

Measures how continuously the Pi actually clocks a STREAM frame out of spidev, to
check the spi_ws281x core's start-of-frame slack (#370: a pause longer than
PREFILL x 10 us right after a frame starts latches the strip mid-frame).

On a reserved led-mapper Pi wired to the rig FX2's SPI tap (rig-1 splanc-max-2 =
pi-ledmapper-1: MOSI D1, CLK D3, CS D5), for each requested LED count N it:

  1. drives the player over its WSS (tunnelled through the reservation, exactly
     like hitl_fpga_ws281x.py; no Pi credentials needed) with a dim counting
     pattern of N LEDs. The player then streams a 3N+1-byte STREAM transaction
     every render tick;
  2. takes ONE untriggered multi-channel "timing" capture of CLK + CS through the
     rig's /shared/logic-analyzer broker. SPI mode 0 idles CLK low, so the
     segmenter's CLK "frames" are clock bursts and their intra-LOWs are pauses.
     CS comes back as a run-length edge stream;

     VALIDITY: the FX2 samples at 24 MS/s. That can't decode SPI, and near 2x
     SCK it aliases, so an active clock can look idle. Pauses are therefore only
     counted where they're unambiguous: SCK <= 6.4 MHz (>= 3.75 samples/cycle;
     the player's 4-port clock) and CLK held for >= 1 us (>= 24 samples). A
     capture whose measured SCK is above 6.4 MHz is reported but marked
     "valid": false. The pause length is a Pi software/DMA property, so the
     sweep varies the TRANSFER SIZE (up to 61 KB with spidev.bufsiz=65536);
  3. analyses it (spi_continuity_core): transactions, pause histogram (inside
     CS-low), CS-high histogram, the worst pause in each frame's start window,
     and stall/latch verdicts against the FIFO-slack model for PREFILL 2 and 64.

The counting pattern is cleared at the end (and on any error), so the player
returns to idle. Nothing on the Pi is touched beyond the WSS session.

    bazel run //pi/hitl/harness:spi_continuity -- --leds 2200,4096,8192,20480
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from dataclasses import asdict

import spi_continuity_core as sc
from hitl_client import Reservation
from hitl_fpga_ws281x import _dut_addr, _open_ws, _rpc, require_analyzer


async def _set_counting(ws_url: str, n: int) -> None:
    """Install a dim N-LED counting pattern (n=0 clears it)."""
    sock = await _open_ws(ws_url, time.monotonic() + 30.0)
    try:
        blocks = [] if n == 0 else [{"start": 0, "count": n, "rgb": [0.06, 0.02, 0.0]}]
        await _rpc(
            sock,
            {"type": "set_counting_pattern", "blocks": blocks, "channel": 0, "color_order": "GRB"},
            "counting_state",
        )
    finally:
        try:
            await sock.close()
        except OSError:
            pass


def _timing(server: str, unit: str, args: argparse.Namespace) -> dict:
    body = {
        "op": "timing",
        "unit": unit,
        "channels": [args.clk, args.cs],
        "samplerate": args.samplerate,
        "duration_ms": int(args.seconds * 1000),
        "reset_us": args.reset_us,
        "gap_threshold_us": args.gap_threshold_us,
        "include_frames": True,
        "max_frames": 20000,
        "include_edges": True,
        "edges_format": "uvarint",
        "max_edges": args.max_edges,
    }
    req = urllib.request.Request(
        server.rstrip("/") + "/shared/logic-analyzer",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=args.seconds + 120) as r:
        return json.loads(r.read())


def _analyse(res: dict, n_leds: int, ports_arg: int, args: argparse.Namespace) -> dict:
    chans = {c["channel"]: c for c in (res.get("channels") or [])}
    clk, cs = chans.get(args.clk.upper()), chans.get(args.cs.upper())
    if not clk or not cs:
        raise SystemExit(f"[spi] capture missing {args.clk}/{args.cs}: {list(chans)}")
    rate = clk["capture"]["sample_rate"]
    edges = cs.get("edges") or {}
    runs = sc.decode_uvarint_runs(edges.get("data", ""))
    lows = sc.level_intervals(runs, edges.get("start_level", 1), 0)  # CS active low
    highs = sc.level_intervals(runs, edges.get("start_level", 1), 1)
    txs = sc.transactions(clk.get("frames") or [], lows, rate)
    expect = 3 * n_leds + 1
    stream = [t for t in txs if abs(t.bytes - expect) <= max(8, expect // 50)]
    spi_hz = sc.spi_clock_hz(stream, expect)
    # the player clocks min(2 x ports x 0.8 MHz, 24 MHz); infer ports if not given
    ports = ports_arg or (max(1, round(spi_hz / 1.6e6)) if spi_hz else 4)
    drain_bps = ports * 8 / (sc.WS_BYTE_US * 1e-6)
    r = (spi_hz / drain_bps) if spi_hz else float("nan")
    gaps = [g.len_us for t in stream for g in t.gaps]
    cs_high_us = [(b - a) * 1e6 / rate for a, b in highs]
    starts = [t.start_us for t in stream]
    periods = sorted(b - a for a, b in zip(starts, starts[1:]))
    valid = bool(spi_hz) and spi_hz <= args.max_valid_sck_mhz * 1e6 * 1.03
    return {
        "leds": n_leds,
        "valid": valid,
        "valid_reason": (
            "SCK <= %.1f MHz and pauses >= %.1f us"
            % (args.max_valid_sck_mhz, args.gap_threshold_us)
            if valid
            else "SCK %s MHz above the %.1f MHz the 24 MS/s FX2 can bound"
            % (round(spi_hz / 1e6, 2) if spi_hz else "?", args.max_valid_sck_mhz)
        ),
        "expect_bytes": expect,
        "sample_rate": rate,
        "capture_drop_suspected": clk["capture"].get("drop_suspected"),
        "capture_notes": clk["capture"].get("notes"),
        "cs_transactions": len(txs),
        "stream_transactions": len(stream),
        "other_transaction_bytes": sorted({t.bytes for t in txs if t not in stream})[:12],
        "spi_clock_mhz": round(spi_hz / 1e6, 3) if spi_hz else None,
        "ports_assumed": ports,
        "r": round(r, 3),
        "frame_period_ms_median": round(periods[len(periods) // 2] / 1000, 2) if periods else None,
        "cs_low_ms_median": (
            round(sorted(t.cs_low_us for t in stream)[len(stream) // 2] / 1000, 3)
            if stream
            else None
        ),
        "pause_threshold_us": args.gap_threshold_us,
        "pauses_total": len(gaps),
        "pause_max_us": round(max(gaps), 2) if gaps else 0.0,
        "pause_histogram_us": sc.histogram(gaps),
        "pauses_capped_frames": sum(t.gaps_capped for t in stream),
        "cs_high_histogram_us": sc.histogram(cs_high_us),
        "cs_high_min_us": round(min(cs_high_us), 1) if cs_high_us else None,
        "verdicts": [asdict(v) for v in sc.verdicts(stream, ports, r if r == r else 1.0)],
        "worst_pauses": sorted(
            ({"len_us": round(g.len_us, 2), "byte": g.byte} for t in stream for g in t.gaps),
            key=lambda d: -d["len_us"],
        )[:10],
    }


def run(args: argparse.Namespace) -> int:
    leds = [int(x) for x in args.leds.split(",") if x]
    res = Reservation(server=args.server or None, owner=args.owner, device=args.device)
    res.acquire()
    results = []
    try:
        require_analyzer(res.server)
        addr = _dut_addr(res)
        with res.forward(addr, args.serve_port) as local_port:
            url = f"wss://localhost:{local_port}/ws"
            try:
                for n in leds:
                    asyncio.run(_set_counting(url, n))
                    time.sleep(args.settle)
                    raw = _timing(res.server, args.device, args)
                    out = _analyse(raw, n, args.ports, args)
                    results.append(out)
                    print(json.dumps(out), flush=True)
            finally:
                asyncio.run(_set_counting(url, 0))  # back to idle
    finally:
        res.release()
    if args.out:
        with open(args.out, "w") as f:
            json.dump(results, f, indent=1)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--server", default="http://hitl-rig-1:8087")
    ap.add_argument("--owner", default="hitl-spi-continuity")
    ap.add_argument("--device", default="pi-ledmapper-1")
    ap.add_argument("--serve-port", type=int, default=8443)
    ap.add_argument("--leds", default="2200,4096,8192,20480", help="total LEDs per frame")
    ap.add_argument(
        "--ports", type=int, default=0, help="player --fpga-ports; 0 = infer from SPI clock"
    )
    ap.add_argument("--clk", default="D3")
    ap.add_argument("--cs", default="D5")
    ap.add_argument("--samplerate", default="24m")
    ap.add_argument("--seconds", type=float, default=4.0)
    ap.add_argument("--settle", type=float, default=1.5)
    ap.add_argument("--reset-us", type=float, default=300.0, help="CLK idle that ends a burst")
    ap.add_argument(
        "--gap-threshold-us", type=float, default=1.0, help="smallest pause reported (CLK held)"
    )
    ap.add_argument(
        "--max-valid-sck-mhz", type=float, default=6.4, help="above this the capture is invalid"
    )
    ap.add_argument("--max-edges", type=int, default=200000)
    ap.add_argument("--out", default="")
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
