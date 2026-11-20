"""Pure logic for the mesh M3a spike HITL test (hitl_mesh_smoke.py): parse the DUT's
`[mesh] ...` console lines, reduce a scenario to delivery / retry / latency numbers, and
judge them against docs/design/mesh.md §4.4's exit criteria. No I/O, unit-tested.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# §4.4 exit: frames flow both ways in both cases with >= 95 % delivery at one hop.
DELIVERY_MIN = 0.95

_KV = re.compile(r"(\w+)=(\S+)")
_HEX = re.compile(r"^[0-9a-f]+$")


def parse_line(line: str) -> tuple[str, dict[str, str]] | None:
    """`[mesh] rx tag=1 frames=10 ...` -> ("rx", {"tag": "1", ...}); None if not a mesh
    line. A trailing bare hex word (the rxv dump) is returned under "hex"."""
    i = line.find("[mesh] ")
    if i < 0:
        return None
    rest = line[i + 7 :].strip()
    if not rest:
        return None
    kind, _, body = rest.partition(" ")
    kv = dict(_KV.findall(body))
    last = body.rsplit(" ", 1)[-1] if body else ""
    if kind == "rxv" and _HEX.match(last):
        kv["hex"] = last
    return kind, kv


def triple(v: str) -> tuple[int, int, int]:
    """'a/b/c' -> (a, b, c)."""
    a, b, c = (int(x) for x in v.split("/"))
    return a, b, c


RATE_NAMES = ["1", "2", "5.5", "11", "6", "9", "12", "18", "24", "36", "48", "54", "?"]


def rate_hist(v: str) -> dict[str, int]:
    """The rx line's `rates=` field (13 counts, `|`-grouped) as {Mb/s name: count}, non-zero."""
    counts = [int(x) for x in v.replace("|", ",").split(",")]
    return {RATE_NAMES[i]: c for i, c in enumerate(counts) if c}


@dataclass
class RxStat:
    tag: int
    src: str
    frames: int
    uniq: int
    retry_bit: int
    rssi_min: int
    rssi_avg: int
    rssi_max: int
    nf: int
    rates: dict[str, int]
    ch_ok: int
    ch_bad: int
    len_ok: int
    len_bad: int
    ts_lag_min: int
    ts_lag_max: int
    ia_n: int
    ia_err_avg: int
    ia_err_max: int
    env_dup: int = 0  # copies the envelope's replay window dropped (MAC retries)
    env_badmic: int = 0

    @classmethod
    def from_kv(cls, kv: dict[str, str]) -> "RxStat":
        lo, avg, hi = triple(kv["rssi"])
        lag_lo, lag_hi = (int(x) for x in kv["ts_lag"].split("/"))
        return cls(
            tag=int(kv["tag"]),
            src=kv["src"],
            frames=int(kv["frames"]),
            uniq=int(kv["uniq"]),
            retry_bit=int(kv["retry_bit"]),
            rssi_min=lo,
            rssi_avg=avg,
            rssi_max=hi,
            nf=int(kv["nf"]),
            rates=rate_hist(kv["rates"]),
            ch_ok=int(kv["ch_ok"]),
            ch_bad=int(kv["ch_bad"]),
            len_ok=int(kv["len_ok"]),
            len_bad=int(kv["len_bad"]),
            ts_lag_min=lag_lo,
            ts_lag_max=lag_hi,
            ia_n=int(kv["ia_n"]),
            ia_err_avg=int(kv["ia_err_avg"]),
            ia_err_max=int(kv["ia_err_max"]),
            env_dup=int(kv.get("env_dup", 0)),
            env_badmic=int(kv.get("env_badmic", 0)),
        )


@dataclass
class TxStat:
    tag: int
    rate: int
    ack: bool
    tries: int
    frames: int
    attempts: int
    confirmed: int
    failed: int
    nocompl: int
    compl_us: tuple[int, int, int]
    pongs: int
    hist: list[int]  # frames confirmed after 1..8 attempts
    st_ok: int
    st_ack_timeout: int
    st_other: int

    @classmethod
    def from_kv(cls, kv: dict[str, str]) -> "TxStat":
        return cls(
            tag=int(kv["tag"]),
            rate=int(kv["rate"]),
            ack=kv["ack"] == "1",
            tries=int(kv["tries"]),
            frames=int(kv["frames"]),
            attempts=int(kv["attempts"]),
            confirmed=int(kv["confirmed"]),
            failed=int(kv["failed"]),
            nocompl=int(kv["nocompl"]),
            compl_us=triple(kv["compl_us"]),
            pongs=int(kv["pongs"]),
            hist=[int(x) for x in kv["hist"].split(",")],
            st_ok=int(kv["st0"]),
            st_ack_timeout=int(kv["st5"]),
            st_other=int(kv["stx"]),
        )

    @property
    def retried(self) -> int:
        """Frames that needed more than one attempt and were then confirmed."""
        return sum(self.hist[1:])


def lost_seqs(bits_hex: str, n: int) -> list[int]:
    """Probe seqs in 0..n the receiver's `got` bitmap (LSB-first per byte) lacks."""
    b = bytes.fromhex(bits_hex)
    return [i for i in range(min(n, len(b) * 8)) if not b[i // 8] >> (i % 8) & 1]


def percentile(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    s = sorted(xs)
    k = (len(s) - 1) * p / 100.0
    i = int(k)
    j = min(i + 1, len(s) - 1)
    return s[i] + (s[j] - s[i]) * (k - i)


@dataclass
class Scenario:
    """One measured transmit job: what the sender did, what the receiver saw."""

    name: str
    sent: int
    tx: TxStat | None
    rx: RxStat | None
    rtts_us: list[int] = field(default_factory=list)
    turns_us: list[int] = field(default_factory=list)
    lost: list[int] | None = None  # probe seqs (< 256) the receiver never accepted

    @property
    def delivered(self) -> int:
        if self.rtts_us:  # ping: a pong back is a delivered round trip
            return len(self.rtts_us)
        return self.rx.uniq if self.rx else 0

    @property
    def delivery(self) -> float:
        return self.delivered / self.sent if self.sent else 0.0

    def latency_ms(self) -> dict[str, float]:
        r = [x / 1000.0 for x in self.rtts_us]
        one_way = [(a - b) / 2000.0 for a, b in zip(self.rtts_us, self.turns_us)]
        return {
            "rtt_p50": percentile(r, 50),
            "rtt_p90": percentile(r, 90),
            "rtt_max": max(r) if r else float("nan"),
            "air_p50": percentile(one_way, 50),
        }

    def row(self) -> dict:
        d = {
            "scenario": self.name,
            "sent": self.sent,
            "delivered": self.delivered,
            "delivery": round(self.delivery, 4),
        }
        if self.rx:
            d.update(
                rssi=f"{self.rx.rssi_min}/{self.rx.rssi_avg}/{self.rx.rssi_max}",
                rx_rates=self.rx.rates,
                retry_bit=self.rx.retry_bit,
                frames_on_air=self.rx.frames,
            )
        if self.tx:
            d.update(
                attempts=self.tx.attempts,
                confirmed=self.tx.confirmed,
                retried=self.tx.retried,
                ack_timeouts=self.tx.st_ack_timeout,
                nocompl=self.tx.nocompl,
            )
        if self.rtts_us:
            d.update({k: round(v, 2) for k, v in self.latency_ms().items()})
        if self.lost is not None:
            d["lost_seqs"] = self.lost
        return d


def retries_proven(ghost: Scenario) -> bool:
    """Unicast to a MAC nobody answers: the sender must time out every attempt and the
    overhearing receiver must see each MPDU `tries` times, the copies after the first with
    the Retry bit."""
    tx, rx = ghost.tx, ghost.rx
    if not tx or not rx or tx.tries < 2:
        return False
    return (
        tx.confirmed == 0
        and tx.st_ack_timeout >= tx.frames
        and rx.uniq > 0
        and rx.frames >= rx.uniq * (tx.tries - 1)
        and rx.retry_bit >= rx.uniq * (tx.tries - 2)
    )


def timestamp_found(
    rx: RxStat | None, max_ia_err_us: int = 2000, max_lag_spread_us: int = 50_000
) -> bool:
    """The RX-vector timestamp is a µs clock stamped at reception: consecutive probes' Δts
    at the receiver match the sender's Δt (its software stamp before TX) within MAC
    contention jitter, and it sits a constant offset behind the receiver's esp_timer (the
    reap lag only spreads by how long a frame waited in the ring)."""
    return bool(
        rx
        and rx.ia_n >= 10
        and rx.ia_err_avg <= max_ia_err_us
        and 0 <= rx.ts_lag_max - rx.ts_lag_min < max_lag_spread_us
    )


def verdict(scenarios: dict[str, Scenario], required: list[str]) -> tuple[bool, list[str]]:
    """PASS iff every required scenario reached DELIVERY_MIN. Returns (ok, reasons)."""
    why = []
    for name in required:
        s = scenarios.get(name)
        if s is None:
            why.append(f"{name}: not measured")
        elif s.delivery < DELIVERY_MIN:
            why.append(f"{name}: delivery {s.delivery:.1%} < {DELIVERY_MIN:.0%}")
    return not why, why
