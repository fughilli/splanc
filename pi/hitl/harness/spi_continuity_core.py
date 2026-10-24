"""Pure analysis for the Pi -> spi_ws281x SPI-continuity capture.

The spi_ws281x core streams: it starts driving a frame once every active port
has PREFILL bytes buffered, and a per-port FIFO only builds a lead while SPI
outruns the strips (r = SPI byte rate / drain rate > 1). A Pi-side pause inside a
transfer drains that lead. A pause longer than the lead stalls the strips. A
stall longer than the WS2812 latch (> 50 us) splits the frame
(fpga/spi_ws281x/README.md; sim in #370). This module turns one rig capture into:

* the SPI transactions (CS-low intervals) and the inter-transaction CS-high
  gaps,
* every pause inside a transaction (CLK idle >= the threshold), placed by byte
  offset into the transfer,
* the worst pause in each STREAM's start window -- the opcode, the PREFILL bytes
  per port the core waits for, and the first PREFILL bytes per port it emits
  (1 + 2*PREFILL*ports bytes, where the FIFO lead is <= ~2*PREFILL bytes) -- and
  every pause against a FIFO-slack model at its offset, for PREFILL = 2
  (in-tree) and 64 (proposed).

Inputs are the hitl-reserve analyzer "timing" op result
(shared/analyzer/timing*.go): CLK frames come from the WS2812-style segmenter
(SPI mode 0 idles CLK low, so a CLK "frame" is a burst of clock and its intra
LOWs are pauses), and CS comes as a uvarint run-length edge stream. Everything
here is pure and unit-tested in //pi/hitl/tests:hitl_test.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

WS_BYTE_US = 9.963  # one WS byte on the 54 MHz core: 8 x 67 clk + 2 (POP/LOAD) at 54 MHz
LATCH_US = 50.0  # WS2812B reset: a LOW at least this long latches (splits the frame)
GAP_BINS_US: Tuple[float, ...] = (1, 5, 10, 20, 50, 100, 600)


def decode_uvarint_runs(data_b64: str) -> List[int]:
    """Decode the analyzer's `uvarint` edge encoding (base64 LEB128 run lengths)."""
    raw = base64.b64decode(data_b64 or "")
    runs: List[int] = []
    val, shift = 0, 0
    for byte in raw:
        val |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
        else:
            runs.append(val)
            val, shift = 0, 0
    return runs


def level_intervals(runs: Sequence[int], start_level: int, level: int) -> List[Tuple[int, int]]:
    """[start, end) sample intervals at `level`, for COMPLETE intervals only (the
    first and last runs may be cut by the capture window, so they're dropped)."""
    out: List[Tuple[int, int]] = []
    pos, lvl = 0, start_level
    for i, n in enumerate(runs):
        if lvl == level and 0 < i < len(runs) - 1:
            out.append((pos, pos + n))
        pos += n
        lvl ^= 1
    return out


def histogram(values: Sequence[float], bins: Sequence[float] = GAP_BINS_US) -> Dict[str, int]:
    """Counts per bin: '<1', '1-5', ..., '>=600' (us)."""
    labels = (
        [f"<{bins[0]:g}"] + [f"{a:g}-{b:g}" for a, b in zip(bins, bins[1:])] + [f">={bins[-1]:g}"]
    )
    counts = {lab: 0 for lab in labels}
    for v in values:
        k = 0
        while k < len(bins) and v >= bins[k]:
            k += 1
        counts[labels[k]] += 1
    return counts


@dataclass
class Gap:
    at_us: float  # from the transaction's first CLK edge
    len_us: float
    byte: int  # stream byte offset (0 = the opcode)


@dataclass
class Transaction:
    start_us: float
    cs_low_us: float
    bits: int
    gaps: List[Gap] = field(default_factory=list)
    gaps_capped: bool = False  # some frame listed fewer gaps than it counted

    @property
    def bytes(self) -> int:
        return self.bits // 8


def transactions(
    clk_frames: Sequence[dict],
    cs_low: Sequence[Tuple[int, int]],
    rate_hz: int,
) -> List[Transaction]:
    """Group CLK bursts (timing-op frames) by the CS-low interval containing them.
    A pause long enough to end a CLK "frame" (>= reset_us) inside one CS-low
    interval shows up as the next burst's `gap_before_us`, so it is a pause too."""
    us = 1e6 / rate_hz
    out: List[Transaction] = []
    frames = sorted(clk_frames, key=lambda f: f["start_sample"])
    fi = 0
    for a, b in cs_low:
        while fi < len(frames) and frames[fi]["start_sample"] < a:
            fi += 1
        inside: List[dict] = []
        j = fi
        while j < len(frames) and frames[j]["start_sample"] < b:
            inside.append(frames[j])
            j += 1
        if not inside:
            continue
        t0 = inside[0]["start_us"]
        tx = Transaction(start_us=t0, cs_low_us=(b - a) * us, bits=0)
        for k, f in enumerate(inside):
            if k > 0 and f.get("gap_before_us") is not None:
                tx.gaps.append(
                    Gap(f["start_us"] - f["gap_before_us"] - t0, f["gap_before_us"], tx.bits // 8)
                )
            for g in f.get("gaps") or []:
                tx.gaps.append(
                    Gap(f["start_us"] - t0 + g["at_us"], g["len_us"], (tx.bits + g["bit"]) // 8)
                )
            if (f.get("gap_count") or 0) > len(f.get("gaps") or []):
                tx.gaps_capped = True
            tx.bits += f.get("bits") or 0
        out.append(tx)
        fi = j
    return out


def slack_us(byte: int, prefill: int, ports: int, r: float) -> float:
    """FIFO lead (us of strip time) available at stream byte `byte` (1 = first
    pixel byte). Before every port has `prefill` bytes the core hasn't started
    emitting, so a pause there only delays the frame (infinite slack). After the
    start, each port holds prefill + (bytes_per_port - prefill) * (1 - 1/r)."""
    per_port = max(byte - 1, 0) / ports
    if per_port < prefill:
        return float("inf")
    lead = prefill + (per_port - prefill) * max(0.0, 1.0 - 1.0 / r)
    return lead * WS_BYTE_US


@dataclass
class Verdict:
    prefill: int
    window_bytes: int
    max_gap_in_window_us: float
    worst_excess_us: float  # max over gaps of (len - slack); <= 0 means no stall
    stalls: int  # pauses longer than their slack
    latches: int  # pauses whose excess > LATCH_US (frame split)


def verdicts(
    txs: Sequence[Transaction], ports: int, r: float, prefills: Sequence[int] = (2, 64)
) -> List[Verdict]:
    out = []
    for p in prefills:
        win = 1 + 2 * p * ports  # prefill + the first PREFILL bytes/port emitted
        mwin, worst, stalls, latches = 0.0, float("-inf"), 0, 0
        for tx in txs:
            for g in tx.gaps:
                if g.byte < win:
                    mwin = max(mwin, g.len_us)
                ex = g.len_us - slack_us(g.byte, p, ports, r)
                worst = max(worst, ex)
                if ex > 0:
                    stalls += 1
                if ex > LATCH_US:
                    latches += 1
        out.append(Verdict(p, win, mwin, worst if worst != float("-inf") else 0.0, stalls, latches))
    return out


def spi_clock_hz(txs: Sequence[Transaction], expect_bytes: int) -> Optional[float]:
    """SPI clock from STREAM transactions of the expected size: bits over the
    CS-low time minus the pauses (median). None if no such transaction."""
    vals = []
    for tx in txs:
        if abs(tx.bytes - expect_bytes) <= max(8, expect_bytes // 50):
            busy = tx.cs_low_us - sum(g.len_us for g in tx.gaps)
            if busy > 0:
                vals.append(expect_bytes * 8 / (busy * 1e-6))
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2]
