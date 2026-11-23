"""FTM spike: decode the C6 MAC's fine timestamps and compute FTM-style RTTs (pure logic).

Field map, from the vendor Wi-Fi blobs (libpp `hal_mac_ftm_get_t3`,
`wDev_record_ftm_data_local`, `lmac_record_txtime`; arduino-esp32 3.3.10 / IDF 5.5) — every
timestamp is in RAW units of 1/640 µs (1.5625 ns; libnet80211 multiplies by 1562.5 for ps):

  RX vector (92 bytes ahead of every received MPDU, esp_wifi_rxctrl_t):
    t2 (frame RX)  = us(12..15)*640 - 13312 + (b11 & 0x7f)*8 + fold(bits 4..14 of u16 @34)
    t3 (ACK TX)    = (us(76..79)*80 + (b80 & 0x7f) - 640) * 8
  Per TX queue q, registers W0..W2 = 0x600A54F0 / F4 / F8 - q*0x74, valid after the ACK:
    t1 (frame TX)  = (W0*80 + (W1 & 0x7f) - 640) * 8
    t4 (ACK RX)    = us4*640 - 13312 + (W2 & 0x7f)*8 + fold((W2 >> 7) & 0x7ff),
                     us4 = (W1 & 0xffffc000) | (W2 >> 18)
  fold(x) = x if x <= 1023 else 2048 - x   (the blob's own treatment of the 11-bit field)

us = the MAC's 1 MHz counter (0x600AD000), (b & 0x7f) a 0..79 80 MHz sub-µs tick. RTT =
(t4 - t1) - (t3 - t2); one-way distance = c * RTT / 2.
"""

from __future__ import annotations

import math
import re
import statistics
from dataclasses import dataclass

RAW_NS = 1000.0 / 640.0  # 1.5625 ns
C_M_PER_NS = 0.299792458
M_PER_RAW_ONEWAY = RAW_NS * C_M_PER_NS / 2.0  # 0.2342 m per raw unit of RTT
# The decode's constant offsets don't cancel in the RTT: (-13312 + 5120) - (-5120 + 13312).
FORMULA_OFFSET_RAW = -16384


def fold(x: int) -> int:
    return x if x <= 1023 else 2048 - x


def signed11(x: int) -> int:
    return x - 2048 if x >= 1024 else x


@dataclass(frozen=True)
class Stamp:
    """A timestamp split into (µs counter, sub-µs raw units incl. fine) so differences of
    the 32-bit µs counters can wrap."""

    us: int
    sub: float  # raw units (1/640 µs), may be negative

    def minus(self, o: "Stamp") -> float:
        d = (self.us - o.us) & 0xFFFFFFFF
        if d >= 1 << 31:
            d -= 1 << 32
        return d * 640 + (self.sub - o.sub)


def _fine(x11: int, mode: str) -> int:
    return {
        "fold": fold,
        "neg": lambda v: -signed11(v),
        "signed": signed11,
        "none": lambda v: 0,
        "raw": lambda v: v,
    }[mode](x11)


def rx_t2(rxv: bytes, mode: str = "fold") -> Stamp:
    us = int.from_bytes(rxv[12:16], "little")
    x = ((rxv[35] & 0x7F) << 4) | (rxv[34] >> 4)
    return Stamp(us, -13312 + (rxv[11] & 0x7F) * 8 + _fine(x, mode))


def rx_t3(rxv: bytes) -> Stamp:
    us = int.from_bytes(rxv[76:80], "little")
    return Stamp(us, ((rxv[80] & 0x7F) - 640) * 8)


def tx_t1(w0: int, w1: int) -> Stamp:
    return Stamp(w0, ((w1 & 0x7F) - 640) * 8)


def tx_t4(w1: int, w2: int, mode: str = "fold") -> Stamp:
    us = (w1 & 0xFFFFC000) | (w2 >> 18)
    return Stamp(us, -13312 + (w2 & 0x7F) * 8 + _fine((w2 >> 7) & 0x7FF, mode))


def rx_fine_raw(rxv: bytes) -> int:
    return ((rxv[35] & 0x7F) << 4) | (rxv[34] >> 4)


def tx_fine_raw(w2: int) -> int:
    return (w2 >> 7) & 0x7FF


@dataclass
class Exchange:
    seq: int
    w0: int
    w1: int
    w2: int
    rxv: bytes
    st: int = 0

    def rtt_raw(self, mode: str = "fold") -> float:
        t1, t4 = tx_t1(self.w0, self.w1), tx_t4(self.w1, self.w2, mode)
        t2, t3 = rx_t2(self.rxv, mode), rx_t3(self.rxv)
        return t4.minus(t1) - t3.minus(t2)

    def parts(self, mode: str = "fold") -> dict:
        t1, t4 = tx_t1(self.w0, self.w1), tx_t4(self.w1, self.w2, mode)
        t2, t3 = rx_t2(self.rxv, mode), rx_t3(self.rxv)
        return {
            "init_raw": t4.minus(t1),  # sender: frame TX -> ACK RX
            "turn_raw": t3.minus(t2),  # receiver: frame RX -> ACK TX
            "tick1": self.w1 & 0x7F,
            "tick4": self.w2 & 0x7F,
            "tick2": self.rxv[11] & 0x7F,
            "tick3": self.rxv[80] & 0x7F,
            "fine2": rx_fine_raw(self.rxv),
            "fine4": tx_fine_raw(self.w2),
            "rssi": int.from_bytes(self.rxv[0:1], "little", signed=True),
        }


_KV = re.compile(r"(\w+)=(\S+)")


def _kv(text: str) -> dict:
    return dict(_KV.findall(text))


def parse_logs(tx_lines: list[str], rx_lines: list[str], tag: int) -> list[Exchange]:
    """Join a job's `[mesh] ftmtx` (sender) and `[mesh] ftmrx` (receiver) lines by seq.
    Only first-attempt deliveries (a=1, st=0) with a non-retry RX count."""
    tx: dict[int, dict] = {}
    for t in tx_lines:
        if "[mesh] ftmtx " not in t:
            continue
        kv = _kv(t)
        try:
            if int(kv["tag"]) != tag or kv.get("a") != "1":
                continue
            tx[int(kv["seq"])] = kv
        except (KeyError, ValueError):
            continue
    out = []
    for t in rx_lines:
        if "[mesh] ftmrx " not in t:
            continue
        kv = _kv(t)
        try:
            if int(kv["tag"]) != tag or kv.get("retry") != "0":
                continue
            seq = int(kv["seq"])
            rxv = bytes.fromhex(kv["rxv"])
        except (KeyError, ValueError):
            continue
        k = tx.get(seq)
        if not k or len(rxv) != 92 or k.get("st") != "0":
            continue
        try:
            out.append(Exchange(seq, int(k["w0"], 16), int(k["w1"], 16), int(k["w2"], 16), rxv))
        except ValueError:
            continue
    return out


def robust(xs: list[float]) -> dict:
    """median, MAD-sigma, mean/stdev after dropping > 5 MAD outliers, n."""
    if not xs:
        return {"n": 0}
    med = statistics.median(xs)
    mad = statistics.median([abs(x - med) for x in xs]) * 1.4826
    keep = [x for x in xs if mad == 0 or abs(x - med) <= 5 * mad]
    return {
        "n": len(xs),
        "kept": len(keep),
        "median": med,
        "mad_sigma": mad,
        "mean": statistics.fmean(keep),
        "stdev": statistics.stdev(keep) if len(keep) > 1 else 0.0,
    }


def inliers(xs: list[float], k: float = 5.0) -> list[float]:
    """xs without the > k MAD outliers, order kept."""
    if not xs:
        return []
    med = statistics.median(xs)
    mad = statistics.median([abs(x - med) for x in xs]) * 1.4826
    return [x for x in xs if mad == 0 or abs(x - med) <= k * mad]


def averaging_curve(xs: list[float], ks=(1, 4, 16, 64)) -> dict:
    """Spread (stdev) of the mean of k consecutive inliers, in the input's units."""
    xs = inliers(xs)
    out = {}
    for k in ks:
        means = [statistics.fmean(xs[i : i + k]) for i in range(0, len(xs) - k + 1, k)]
        if len(means) >= 3:
            out[k] = statistics.stdev(means)
    return out


def exchanges_for(sigma_one: float, target: float) -> int:
    """Exchanges an estimate needs for a target sigma, if the errors are independent."""
    return max(1, math.ceil((sigma_one / target) ** 2))


def relative_ppm(ex: list[Exchange]) -> float | None:
    """The receiver's clock rate against the sender's, (rx - tx) in ppm, from the same
    stamps: the slope of (t2 - t1) over t1 across the exchanges (no extra traffic). Least
    squares, then again without > 5 MAD residuals."""
    if len(ex) < 10:
        return None
    t1 = [tx_t1(e.w0, e.w1) for e in ex]
    t2 = [rx_t2(e.rxv) for e in ex]
    xs = [a.minus(t1[0]) for a in t1]
    ys = [b.minus(t2[0]) - x for b, x in zip(t2, xs)]

    def fit(px, py):
        n = len(px)
        mx, my = sum(px) / n, sum(py) / n
        sxx = sum((x - mx) ** 2 for x in px)
        if sxx == 0:
            return None
        k = sum((x - mx) * (y - my) for x, y in zip(px, py)) / sxx
        return k, my - k * mx

    f = fit(xs, ys)
    if not f:
        return None
    res = [y - (f[0] * x + f[1]) for x, y in zip(xs, ys)]
    med = statistics.median([abs(r) for r in res]) * 1.4826 + 1.0
    keep = [(x, y) for x, y, r in zip(xs, ys, res) if abs(r) <= 5 * med]
    f = fit([k[0] for k in keep], [k[1] for k in keep]) or f
    return f[0] * 1e6


def rtt_drift_corrected(e: Exchange, ppm: float, mode: str = "fold") -> float:
    """RTT with the turnaround (timed on the receiver's clock) mapped onto the sender's:
    RTT = (t4 - t1) - (t3 - t2) * (1 - ppm*1e-6) ~ raw + turn * ppm*1e-6."""
    return e.rtt_raw(mode) + e.parts(mode)["turn_raw"] * ppm * 1e-6
