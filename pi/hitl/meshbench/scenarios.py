"""RF scenarios for the mesh bench: links that come and go and change length
(docs/design/mesh-hitl-rig.md §6).

A Scenario is a list of timed Steps over the controller's devices (names from the
rfctl `list`). `compile()` turns it into the controller timeline, adds the sync-LED
code the camera aligns on, and checks spacing, capacity and the matrix sneak paths
(RF-BENCH.md §3). Device naming (rfctl/board_default.c): pair "ij" has a cut switch
`cutij` and attenuators `attija/b/c`; the delay bank on pair 01 is `dlyA` + `dlyB`.
"""

from __future__ import annotations

import dataclasses
import itertools
import math
import random
from typing import Iterable, Mapping, Sequence

ATT_MAX = 31.5  # dB per DSA
CUT_DB = 180.0  # nominal loss of an open cut switch in series with the DSAs
SNEAK_LIMIT_DB = 100.0  # below this, A->B->C leaks round a cut A-C (RF-BENCH §3)
MIN_STEP_US = 50  # controller: shift + latch of 144 bits plus margin
DELAY_STEP_CM = 25
DELAY_A_CM = (0, 25, 50, 75)
DELAY_B_CM = (0, 100, 200, 300)
SYNC_CODE = (
    0.0,
    0.08,
    0.16,
    0.40,
    0.48,
    0.80,
)  # syncled toggle times (s): an unambiguous start code


@dataclasses.dataclass
class Step:
    t: float  # s from scenario start
    values: dict
    label: str | None = None


@dataclasses.dataclass
class Scenario:
    name: str
    duration: float
    steps: list
    params: dict = dataclasses.field(default_factory=dict)

    def marks(self) -> list[tuple[float, str]]:
        return [(s.t, s.label) for s in self.steps if s.label]


class Bench:
    """The pair/device model of one controller board."""

    def __init__(
        self,
        device_names: Iterable[str],
        fixed_loss_db: float = 42.0,
        cal: Mapping[str, Sequence[float]] | None = None,
    ):
        names = set(device_names)
        self.names = names
        self.pairs = sorted(n[3:] for n in names if n.startswith("cut") and len(n) == 5)
        self.nodes = sorted({int(c) for p in self.pairs for c in p})
        self.fixed_loss_db = fixed_loss_db  # pads + splitters + cables at all-zero DSAs
        self.cal = dict(cal or {})  # DSA name -> measured dB per state (64 entries)
        self.has_delay = {"dlyA", "dlyB"} <= names
        self.has_sync = "syncled" in names

    @staticmethod
    def pair(i: int, j: int) -> str:
        a, b = sorted((i, j))
        return f"{a}{b}"

    def atts(self, pair: str) -> list[str]:
        return [f"att{pair}{s}" for s in "abc" if f"att{pair}{s}" in self.names]

    def _state_db(self, dev: str, state: int) -> float:
        lut = self.cal.get(dev)
        return float(lut[state]) if lut else state * 0.5

    def loss(self, pair: str, total_db: float) -> dict:
        """Attenuator values for a pair's total path loss (dB, including the fixed
        part). Greedy over the chain, using the calibration LUT when present."""
        atts = self.atts(pair)
        need = max(0.0, total_db - self.fixed_loss_db)
        out = {}
        for k, dev in enumerate(atts):
            rest = len(atts) - k - 1
            # leave what the remaining stages can still take
            target = min(need, ATT_MAX) if rest else need
            best = min(range(64), key=lambda s: abs(self._state_db(dev, s) - target))
            out[dev] = best * 0.5
            need -= self._state_db(dev, best)
        return out

    def path_loss(self, values: Mapping[str, float], pair: str) -> float:
        """Total loss of a pair under a device state (CUT_DB when cut)."""
        if values.get(f"cut{pair}", 1) in (0, "0"):
            return CUT_DB
        return self.fixed_loss_db + sum(
            self._state_db(d, int(round(float(values.get(d, ATT_MAX)) * 2)))
            for d in self.atts(pair)
        )

    def link(self, pair: str, up: bool, loss_db: float | None = None) -> dict:
        v = {f"cut{pair}": 1 if up else 0}
        if up and loss_db is not None:
            v.update(self.loss(pair, loss_db))
        return v

    def delay(self, cm: int) -> dict:
        """Delay-bank state adding `cm` of cable on pair 01 (0..375, 25 cm steps)."""
        if not self.has_delay:
            raise ValueError("board has no delay bank")
        if cm % DELAY_STEP_CM or not 0 <= cm <= DELAY_A_CM[-1] + DELAY_B_CM[-1]:
            raise ValueError(f"delay {cm} cm: 0..375 in 25 cm steps")
        return {"dlyA": DELAY_A_CM.index(cm % 100), "dlyB": DELAY_B_CM.index(cm - cm % 100)}

    def topology(self, links: Mapping[str, float]) -> dict:
        """Every pair: up at the given loss if listed, else cut."""
        v = {}
        for p in self.pairs:
            v.update(self.link(p, p in links, links.get(p)))
        return v

    def full(self, loss_db: float = 60.0) -> dict:
        return self.topology({p: loss_db for p in self.pairs})

    def chain(self, order: Sequence[int], loss_db: float = 60.0) -> dict:
        return self.topology({self.pair(a, b): loss_db for a, b in zip(order, order[1:])})

    def sneak_paths(self, values: Mapping[str, object]) -> list[str]:
        """Cut pairs that leak round through a third node (L_ij + L_jk < limit)."""
        bad = []
        for p in self.pairs:
            if self.path_loss(values, p) < CUT_DB:
                continue
            i, k = int(p[0]), int(p[1])
            for j in self.nodes:
                if j in (i, k):
                    continue
                via = self.path_loss(values, self.pair(i, j)) + self.path_loss(
                    values, self.pair(j, k)
                )
                if via < SNEAK_LIMIT_DB:
                    bad.append(f"{p} via {j}: {via:.1f} dB")
        return bad


# ------------------------------------------------------------------ the library


def baseline(b: Bench, duration: float = 30.0, loss_db: float = 60.0) -> Scenario:
    return Scenario(
        "baseline", duration, [Step(0.0, b.full(loss_db), "full")], {"loss_db": loss_db}
    )


def link_flap(
    b: Bench,
    pair: str = "01",
    period: float = 10.0,
    down: float = 3.0,
    cycles: int = 6,
    loss_db: float = 60.0,
) -> Scenario:
    """One link goes away for `down` s every `period` s: the mesh must re-route (when
    it can) and keep every display in step through it."""
    steps = [Step(0.0, b.full(loss_db), "full")]
    for k in range(cycles):
        t = 2.0 + k * period
        steps.append(Step(t, b.link(pair, False), f"down:{pair}"))
        steps.append(Step(t + down, b.link(pair, True, loss_db), f"up:{pair}"))
    return Scenario(
        "link_flap",
        2.0 + cycles * period,
        steps,
        {"pair": pair, "period": period, "down": down, "cycles": cycles},
    )


def chain_reroute(
    b: Bench,
    order: Sequence[int] = (0, 1, 2, 3),
    backup: tuple[int, int] = (0, 2),
    loss_db: float = 60.0,
    backup_db: float = 85.0,
    t_cut: float = 10.0,
    t_heal: float = 25.0,
    duration: float = 40.0,
) -> Scenario:
    """A 3-hop chain with one weak backup link; the middle link fails, so traffic
    for the far end re-routes over the backup, then the chain heals."""
    links = {b.pair(x, y): loss_db for x, y in zip(order, order[1:])}
    links[b.pair(*backup)] = backup_db
    mid = b.pair(order[1], order[2])
    steps = [
        Step(0.0, b.topology(links), "chain"),
        Step(t_cut, b.link(mid, False), f"down:{mid}"),
        Step(t_heal, b.link(mid, True, loss_db), f"up:{mid}"),
    ]
    return Scenario(
        "chain_reroute", duration, steps, {"order": list(order), "backup": list(backup)}
    )


def partition_heal(
    b: Bench,
    groups: Sequence[Sequence[int]] = ((0, 1), (2, 3)),
    loss_db: float = 60.0,
    t_cut: float = 10.0,
    t_heal: float = 30.0,
    duration: float = 50.0,
) -> Scenario:
    """The mesh splits in two (each side keeps its own time), then heals: after the
    heal both sides must converge on one time again."""
    cut = {}
    for g1, g2 in itertools.combinations(groups, 2):
        for i in g1:
            for j in g2:
                cut.update(b.link(b.pair(i, j), False))
    heal = {}
    for p in cut:
        heal.update(b.link(p[3:], True, loss_db))
    steps = [
        Step(0.0, b.full(loss_db), "full"),
        Step(t_cut, cut, "partition"),
        Step(t_heal, heal, "heal"),
    ]
    return Scenario("partition_heal", duration, steps, {"groups": [list(g) for g in groups]})


def length_steps(
    b: Bench,
    cms: Sequence[int] = tuple(range(0, 400, 25)),
    dwell: float = 4.0,
    loss_db: float = 60.0,
) -> Scenario:
    """Step pair 01's cable length through the delay bank (0..375 cm, 0.36 m free
    space per step). Each switch-over is a ~us break of the path: links change
    length under the mesh without being cut for longer."""
    steps = [Step(0.0, {**b.full(loss_db), **b.delay(0)}, "len:0")]
    for k, cm in enumerate(cms):
        steps.append(Step(1.0 + k * dwell, b.delay(cm), f"len:{cm}"))
    return Scenario("length_steps", 1.0 + len(cms) * dwell, steps, {"cms": list(cms)})


def walk_fade(
    b: Bench,
    pair: str = "01",
    duration: float = 20.0,
    rate_hz: float = 100.0,
    loss_db: float = 70.0,
    depth_db: float = 30.0,
    seed: int = 1,
) -> Scenario:
    """A person walking past: Rayleigh-like fast fading (sum of sinusoids, 8 Hz
    Doppler) plus body-shadow dips of 3-15 dB lasting 0.3-2 s (RF-BENCH §6)."""
    rng = random.Random(seed)
    fd = 8.0
    comps = [
        (rng.uniform(0, 2 * math.pi), fd * math.cos(2 * math.pi * (k + 0.5) / 16))
        for k in range(16)
    ]
    dips = []
    t = 2.0
    while t < duration:
        dips.append((t, rng.uniform(0.3, 2.0), rng.uniform(3, 15)))
        t += rng.uniform(3, 10)
    steps = [Step(0.0, b.full(loss_db), "full")]
    n = int(duration * rate_hz)
    for k in range(1, n):
        t = k / rate_hz
        re = sum(math.cos(2 * math.pi * f * t + ph) for ph, f in comps) / 4.0
        im = sum(math.sin(2 * math.pi * f * t + ph) for ph, f in comps) / 4.0
        fade = -10 * math.log10(max(re * re + im * im, 10 ** (-depth_db / 10)))
        shadow = sum(d for t0, w, d in dips if t0 <= t < t0 + w)
        steps.append(Step(t, b.loss(pair, loss_db + fade + shadow)))
    return Scenario("walk_fade", duration, steps, {"pair": pair, "rate_hz": rate_hz, "seed": seed})


def from_meshsim(
    b: Bench,
    rows: Iterable[tuple[float, int, int, float]],
    tx_sim_dbm: float = 20.0,
    tx_bench_dbm: float = 2.0,
    edge_db: float = 119.0,
    name: str = "meshsim",
) -> Scenario:
    """Replay a `meshsim --export-bench` trace (t, i, j, PL_dB). The bench runs at
    lower TX power, so PL shifts by (TX_sim - TX_bench); past the link edge the pair
    is cut (RF-BENCH §8)."""
    shift = tx_sim_dbm - tx_bench_dbm
    by_t: dict = {}
    for t, i, j, pl in rows:
        p = b.pair(i, j)
        if p not in b.pairs:
            continue
        v = by_t.setdefault(round(t, 6), {})
        if pl >= edge_db:  # beyond the link edge at the simulated power
            v.update(b.link(p, False))
        else:
            v.update(b.link(p, True, pl - shift))
    steps = [Step(t, v) for t, v in sorted(by_t.items())]
    dur = (steps[-1].t + 1.0) if steps else 1.0
    return Scenario(name, dur, steps, {"tx_sim_dbm": tx_sim_dbm, "tx_bench_dbm": tx_bench_dbm})


LIBRARY = {
    "baseline": baseline,
    "link_flap": link_flap,
    "chain_reroute": chain_reroute,
    "partition_heal": partition_heal,
    "length_steps": length_steps,
    "walk_fade": walk_fade,
}


# --------------------------------------------------------------------- compile


@dataclasses.dataclass
class Compiled:
    timeline: list  # [(t_rel_us, {device: value})]
    marks: list  # [(t_rel_us, label)]
    sync_us: list  # syncled toggle instants (t_rel_us)
    warnings: list


def compile(sc: Scenario, b: Bench, lead_s: float = 1.0, cap: int = 8192) -> Compiled:
    """Timeline relative to play's t0. The scenario starts `lead_s` after t0, after
    the sync code on the sync LED; every labelled step also toggles the LED, so the
    camera sees each event's instant."""
    merged: dict = {}
    marks = []
    sync = []
    warnings = []
    led = 0

    def add(t_us: int, values: dict) -> None:
        merged.setdefault(t_us, {}).update(values)

    if b.has_sync:
        for t in SYNC_CODE:
            led ^= 1
            t_us = int(round(t * 1e6))
            add(t_us, {"syncled": led})
            sync.append(t_us)
    state: dict = {}
    seen_warn = set()
    for s in sorted(sc.steps, key=lambda s: s.t):
        t_us = int(round((lead_s + s.t) * 1e6))
        changed = {k: v for k, v in s.values.items() if state.get(k) != v}
        if changed:
            add(t_us, changed)
        state.update(s.values)
        if s.label:
            marks.append((t_us, s.label))
            if b.has_sync:
                led ^= 1
                add(t_us, {"syncled": led})
                sync.append(t_us)
        if s.label or not warnings:
            for w in b.sneak_paths(state):
                if w not in seen_warn:
                    seen_warn.add(w)
                    warnings.append(f"t={s.t:.3f}s sneak path: {w}")
    if b.has_sync and led:
        t_end = int(round((lead_s + sc.duration) * 1e6))
        add(t_end, {"syncled": 0})
        sync.append(t_end)
    times = sorted(merged)
    for t0, t1 in zip(times, times[1:]):
        if t1 - t0 < MIN_STEP_US:
            raise ValueError(f"{sc.name}: steps {t0} and {t1} us are closer than {MIN_STEP_US} us")
    for t, v in merged.items():
        unknown = set(v) - b.names
        if unknown:
            raise ValueError(f"{sc.name}: unknown devices {sorted(unknown)} at {t} us")
    n = sum(len(v) for v in merged.values())
    if n > cap:
        raise ValueError(f"{sc.name}: {n} timeline entries > controller capacity {cap}")
    return Compiled([(t, merged[t]) for t in times], marks, sync, warnings)
