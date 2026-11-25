"""RF scenarios for the mesh bench: links that come and go and change length
(docs/design/mesh-hitl-rig.md §6).

A Scenario is a list of timed Steps over the controller's devices (names from the
rfctl `list`). `compile()` turns it into the controller timeline, adds the sync-LED
code the camera aligns on, sequences the slow UART attenuators around the latch
edges (§5.4), and checks spacing, capacity and the matrix sneak paths (§2.1).

Two bench models, picked from the board's device names:

- **node** (the default board, `jeanoko-n4`): one attenuator per DUT, `att<i>`,
  between the DUT and its node splitter. Pair "ij" keeps a cut switch `cutij`
  (+ a fixed pad). A pair's loss is F_ij + A_i + A_j, so per-pair control is gone:
  `topology()` fits the node attenuators to the requested pair losses (least
  squares) and reports what it could not reach. A cut pair with a live common
  neighbour j leaks round through j's splitter, *bypassing* j's attenuator.
- **pair** (the legacy `pe4302` table): pair "ij" has `cutij` + `attija/b/c`, set
  independently.

The delay bank on pair 01 is `dlyA` + `dlyB` in both.
"""

from __future__ import annotations

import dataclasses
import itertools
import math
import random
import re
from typing import Iterable, Mapping, Sequence

ATT_MAX = 31.5  # dB per PE4302 DSA (pair model)
UART_ATT_MAX = 31.75  # dB per Jeanoko unit (node model)
UART_STEP_DB = 0.25
CUT_DB = 180.0  # nominal loss of an open cut switch in series with the DSAs (pair model)
SNEAK_LIMIT_DB = 100.0  # a cut pair must stay above this, counting every leak path (§2.1)
BENCH_TX_DBM = 2.0  # bench TX power until isolation is measured (RF-BENCH §5): 1M edge ~101 dB
MIN_STEP_US = 50  # controller: shift + latch plus margin
# UART attenuators (§5.4): an 8-byte command is 694 us on the wire at 115200 baud;
# the unit's MCU then sets its DSA. Until a unit is measured (its calibration's
# latency_us), assume the RF lands this long after the command starts.
UART_LEAD_US = 3000
UART_GUARD_US = 2000  # make-before: attenuators settled this long before a link opens
UART_MIN_SPACING_US = 1000  # per unit: one command at a time (694 us on the wire)
# node model defaults until bench_cal.json exists (§2.1, 2.44 GHz, 30 dB pair pads:
# the pad is the only lever on how far a cut pair's detour sits below a live link)
NODE_SIDE_DB = 12.3  # u.FL pigtail + 1 m RG400 + Wilkinson through, per side
PAIR_CHAIN_DB = 32.5  # 2 x 50 cm RG400 (1.5) + HMC849 on (1.0) + 30 dB pad (20 + 10)
NODE_FIXED_DB = 2 * NODE_SIDE_DB + PAIR_CHAIN_DB  # F_ij without the attenuators
UART_IL_DB = 1.5  # Jeanoko insertion loss at 0 dB (listing; the VNA gives the truth)
SPLITTER_ISO_DB = 20.0  # Wilkinson port-to-port isolation
CUT_ISO_DB = 55.0  # HMC849 isolation minus its insertion loss
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

_NODE_ATT = re.compile(r"^att(\d)$")
_UART_ATT = re.compile(r"^att(\d|x)$")


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
    warnings: list = dataclasses.field(default_factory=list)

    def marks(self) -> list[tuple[float, str]]:
        return [(s.t, s.label) for s in self.steps if s.label]


def _db_sum(losses: Iterable[float]) -> float:
    """Parallel leak paths add in power."""
    p = sum(10 ** (-x / 10) for x in losses)
    return -10 * math.log10(p) if p > 0 else math.inf


class Bench:
    """The pair/device model of one controller board.

    `cal` is a bench calibration (atten_cal.py, schema meshbench.bench_cal/1), or,
    for the pair model, the legacy {DSA name: [dB per state x 64]} mapping."""

    def __init__(
        self,
        device_names: Iterable[str],
        fixed_loss_db: float | None = None,
        cal: Mapping | None = None,
    ):
        names = set(device_names)
        self.names = names
        self.pairs = sorted(n[3:] for n in names if n.startswith("cut") and len(n) == 5)
        self.nodes = sorted({int(c) for p in self.pairs for c in p})
        self.node_atts = {
            int(m.group(1)): n for n in names if (m := _NODE_ATT.match(n)) and n != "attx"
        }
        self.model = "node" if self.node_atts else "pair"
        self.uart_devs = {n for n in names if _UART_ATT.match(n)} if self.model == "node" else set()
        cal = dict(cal or {})
        self.bench_cal = cal if "schema" in cal else {}
        self.cal = {} if self.bench_cal else cal  # legacy DSA LUTs (pair model)
        bc = self.bench_cal
        self.node_side_db = float(bc.get("node_side_db", NODE_SIDE_DB))
        self.splitter_iso_db = float(bc.get("splitter_isolation_db", SPLITTER_ISO_DB))
        self.cut_iso_db = float(bc.get("cut_isolation_db", CUT_ISO_DB))
        default_fixed = 42.0 if self.model == "pair" else NODE_FIXED_DB
        self.fixed_loss_db = default_fixed if fixed_loss_db is None else float(fixed_loss_db)
        self.pair_fixed = {
            p: float(bc.get("pair_fixed_db", {}).get(p, self.fixed_loss_db)) for p in self.pairs
        }
        self.atten_cal = dict(bc.get("atten", {}))  # dev -> {"loss_db": [128], "latency_us"}
        self.has_delay = {"dlyA", "dlyB"} <= names
        self.has_sync = "syncled" in names
        self.last_fit: dict = {}  # pair -> (target_db, achieved_db) of the last topology()
        self.warnings: list = []  # fit shortfalls; compile() reports and clears them

    @classmethod
    def from_rfctl(cls, devices, **kw) -> "Bench":
        return cls(devices, **kw)

    @staticmethod
    def pair(i: int, j: int) -> str:
        a, b = sorted((i, j))
        return f"{a}{b}"

    # ---------------------------------------------------------------- attenuators

    def atts(self, pair: str) -> list[str]:
        """The attenuators in series with a pair: its 3 DSAs (pair model), or the
        two endpoint units (node model)."""
        if self.model == "node":
            return [self.node_atts[int(c)] for c in pair if int(c) in self.node_atts]
        return [f"att{pair}{s}" for s in "abc" if f"att{pair}{s}" in self.names]

    def _state_db(self, dev: str, state: int) -> float:
        lut = self.cal.get(dev)
        return float(lut[state]) if lut else state * 0.5

    def unit_loss(self, dev: str, setting_db: float) -> float:
        """Loss through a UART unit at a setting, insertion loss included."""
        q = int(round(float(setting_db) / UART_STEP_DB))
        q = max(0, min(127, q))
        c = self.atten_cal.get(dev)
        if c and c.get("loss_db"):
            return float(c["loss_db"][q])
        return UART_IL_DB + q * UART_STEP_DB

    def unit_setting(self, dev: str, loss_db: float) -> float:
        """The setting (dB, 0.25 steps) whose calibrated loss is nearest loss_db."""
        c = self.atten_cal.get(dev)
        if c and c.get("loss_db"):
            lut = c["loss_db"]
            q = min(range(len(lut)), key=lambda k: abs(lut[k] - loss_db))
        else:
            q = int(round((loss_db - UART_IL_DB) / UART_STEP_DB))
        return max(0, min(127, q)) * UART_STEP_DB

    def uart_lead_us(self, dev: str) -> int:
        """Command start -> RF settled, from the unit's calibration if measured."""
        c = self.atten_cal.get(dev) or {}
        lat = c.get("latency_us")
        return int(lat) if lat else UART_LEAD_US

    def _att_value(self, values: Mapping, dev: str) -> float:
        return float(values.get(dev, UART_ATT_MAX if self.model == "node" else ATT_MAX))

    def min_loss_db(self) -> float:
        """The lowest through loss any pair reaches (every attenuator at 0)."""
        if self.model == "pair":
            return self.fixed_loss_db
        return min(
            self.pair_fixed[p] + sum(self.unit_loss(d, 0.0) for d in self.atts(p))
            for p in self.pairs
        )

    def loss(self, pair: str, total_db: float, state: Mapping | None = None) -> dict:
        """Attenuator values for a pair's total path loss (dB, including the fixed
        part). Pair model: greedy over the pair's DSAs (calibrated when a LUT is
        present). Node model: the higher-numbered endpoint's unit moves and the other
        keeps its value in `state` (so every link of that node moves with it)."""
        if self.model == "node":
            i, j = int(pair[0]), int(pair[1])
            di, dj = self.node_atts[i], self.node_atts[j]
            ai = self._att_value(state or {}, di) if state else 0.0
            need = total_db - self.pair_fixed[pair] - self.unit_loss(di, ai)
            return {dj: self.unit_setting(dj, need)}
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

    # ---------------------------------------------------------------- path loss

    @staticmethod
    def _is_cut(values: Mapping, pair: str) -> bool:
        return values.get(f"cut{pair}", 1) in (0, "0")

    def through_loss(self, values: Mapping, pair: str) -> float:
        """A pair's loss with its cut switch closed (through)."""
        if self.model == "node":
            return self.pair_fixed[pair] + sum(
                self.unit_loss(d, self._att_value(values, d)) for d in self.atts(pair)
            )
        return self.fixed_loss_db + sum(
            self._state_db(d, int(round(float(values.get(d, ATT_MAX)) * 2)))
            for d in self.atts(pair)
        )

    def _leg(self, values: Mapping, pair: str) -> float:
        """Splitter port to splitter port through a pair chain (node model)."""
        chain = self.pair_fixed[pair] - 2 * self.node_side_db
        return chain + (self.cut_iso_db if self._is_cut(values, pair) else 0.0)

    def leak_paths(self, values: Mapping, pair: str) -> list[tuple[str, float]]:
        """Node model: every path from i to k, [(via, dB)]: 'direct' (through the
        pair's own chain, cut or not) and each one-hop detour through node j's
        splitter, which skips j's attenuator."""
        i, k = int(pair[0]), int(pair[1])
        ends = sum(self.unit_loss(d, self._att_value(values, d)) for d in self.atts(pair))
        out = [
            (
                "direct",
                self.through_loss(values, pair)
                + (self.cut_iso_db if self._is_cut(values, pair) else 0.0),
            )
        ]
        for j in self.nodes:
            if j in (i, k):
                continue
            via = (
                ends
                + 2 * self.node_side_db
                + self._leg(values, self.pair(i, j))
                + self.splitter_iso_db
                + self._leg(values, self.pair(j, k))
            )
            out.append((str(j), via))
        return out

    def path_loss(self, values: Mapping[str, float], pair: str) -> float:
        """Total loss of a pair under a device state. Pair model: CUT_DB when cut.
        Node model: a cut pair's effective loss, every leak path added in power."""
        if self.model == "node":
            if not self._is_cut(values, pair):
                return self.through_loss(values, pair)
            return _db_sum(x for _, x in self.leak_paths(values, pair))
        if self._is_cut(values, pair):
            return CUT_DB
        return self.through_loss(values, pair)

    # ---------------------------------------------------------------- topologies

    def link(self, pair: str, up: bool, loss_db: float | None = None) -> dict:
        """Open or close one pair. In the node model the loss of a link is what its
        two node attenuators give: `loss_db` is ignored (use topology/loss)."""
        v = {f"cut{pair}": 1 if up else 0}
        if up and loss_db is not None and self.model == "pair":
            v.update(self.loss(pair, loss_db))
        return v

    def fit(self, targets: Mapping[str, float | None], iters: int = 200) -> dict:
        """Node model: unit settings for target pair losses (None = don't care),
        least squares in dB over the live pairs, 0..31.75 dB, then quantised to the
        nearest calibrated step. Nodes with no live link go to max. Records
        last_fit = {pair: (target, achieved)}."""
        live = list(targets)
        want = {p: t for p, t in targets.items() if t is not None}
        nodes_live = {int(c) for p in live for c in p}
        a = {n: 0.0 for n in self.node_atts}  # loss of each unit (dB, IL included)
        lo = {n: self.unit_loss(self.node_atts[n], 0.0) for n in a}
        hi = {n: self.unit_loss(self.node_atts[n], UART_ATT_MAX) for n in a}
        for n in a:
            a[n] = lo[n] if n in nodes_live else hi[n]
        for _ in range(iters):
            moved = 0.0
            for n in a:
                if n not in nodes_live:
                    continue
                terms = [
                    want[p] - self.pair_fixed[p] - a[int(p[1]) if int(p[0]) == n else int(p[0])]
                    for p in want
                    if str(n) in p
                ]
                if not terms:
                    continue
                new = min(hi[n], max(lo[n], sum(terms) / len(terms)))
                moved = max(moved, abs(new - a[n]))
                a[n] = new
            if moved < 1e-4:
                break
        out = {self.node_atts[n]: self.unit_setting(self.node_atts[n], a[n]) for n in a}
        self.last_fit = {p: (want[p], self.through_loss(out, p)) for p in want}
        return out

    def topology(self, links: Mapping[str, float | None]) -> dict:
        """Every pair: up at the given loss if listed, else cut."""
        v = {}
        for p in self.pairs:
            v.update(self.link(p, p in links, links.get(p)))
        if self.model == "node":
            v.update(self.fit({p: links[p] for p in self.pairs if p in links}))
            self.warnings += self.fit_warnings()
        return v

    def fit_warnings(self, tol_db: float = 1.0) -> list[str]:
        return [
            f"pair {p}: wanted {t:.1f} dB, the node attenuators give {got:.1f} dB"
            for p, (t, got) in sorted(self.last_fit.items())
            if abs(got - t) > tol_db
        ]

    def delay(self, cm: int) -> dict:
        """Delay-bank state adding `cm` of cable on pair 01 (0..375, 25 cm steps)."""
        if not self.has_delay:
            raise ValueError("board has no delay bank")
        if cm % DELAY_STEP_CM or not 0 <= cm <= DELAY_A_CM[-1] + DELAY_B_CM[-1]:
            raise ValueError(f"delay {cm} cm: 0..375 in 25 cm steps")
        return {"dlyA": DELAY_A_CM.index(cm % 100), "dlyB": DELAY_B_CM.index(cm - cm % 100)}

    def full(self, loss_db: float = 60.0) -> dict:
        return self.topology({p: loss_db for p in self.pairs})

    def chain(self, order: Sequence[int], loss_db: float = 60.0) -> dict:
        return self.topology({self.pair(a, b): loss_db for a, b in zip(order, order[1:])})

    def sneak_paths(self, values: Mapping[str, object]) -> list[str]:
        """Cut pairs that leak round through a third node. Pair model: L_ij + L_jk
        below the limit. Node model: the pair's effective loss (all leak paths)
        below the limit, naming the strongest path."""
        bad = []
        for p in self.pairs:
            if not self._is_cut(values, p):
                continue
            if self.model == "node":
                eff = self.path_loss(values, p)
                if eff < SNEAK_LIMIT_DB:
                    via, x = min(self.leak_paths(values, p), key=lambda t: t[1])
                    bad.append(f"{p} via {via}: {eff:.1f} dB (strongest path {x:.1f} dB)")
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
    backup_db: float | None = None,
    t_cut: float = 10.0,
    t_heal: float = 25.0,
    duration: float = 40.0,
) -> Scenario:
    """A 3-hop chain with one backup link; the middle link fails, so traffic for
    the far end re-routes over the backup, then the chain heals.

    Pair model: the backup is weak (default 85 dB). Node model: a backup's loss is
    a_i + a_j + F like every link, so a backup weaker than the chain links it
    joins can't be set (design §6.1); the default (None) is an equal-strength
    backup. A weak backup needs a heavier fixed pad on that pair's chain, entered
    in bench_cal.json's pair_fixed_db."""
    if backup_db is None and b.model == "pair":
        backup_db = 85.0
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
    loss_db: float | None = None,
    depth_db: float = 30.0,
    seed: int = 1,
) -> Scenario:
    """A person walking past: Rayleigh-like fast fading (sum of sinusoids, 8 Hz
    Doppler) plus body-shadow dips of 3-15 dB lasting 0.3-2 s (RF-BENCH §6).

    Node model: the fade moves the attenuator of the pair's higher node, so every
    link of that node fades together (a person beside that fixture), and a fade
    can only go as deep as that unit's headroom (31.75 dB minus its base setting).
    The default base loss is then the bench minimum + 4 dB, which leaves ~30 dB.
    Pair model default: 70 dB."""
    if loss_db is None:
        loss_db = 70.0 if b.model == "pair" else round(b.min_loss_db() + 4.0, 1)
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
    base = b.full(loss_db)
    steps = [Step(0.0, base, "full")]
    n = int(duration * rate_hz)
    clipped = 0
    for k in range(1, n):
        t = k / rate_hz
        re_ = sum(math.cos(2 * math.pi * f * t + ph) for ph, f in comps) / 4.0
        im_ = sum(math.sin(2 * math.pi * f * t + ph) for ph, f in comps) / 4.0
        fade = -10 * math.log10(max(re_ * re_ + im_ * im_, 10 ** (-depth_db / 10)))
        shadow = sum(d for t0, w, d in dips if t0 <= t < t0 + w)
        v = b.loss(pair, loss_db + fade + shadow, state=base)
        if b.model == "node":
            got = b.through_loss({**base, **v}, pair)
            clipped += got < loss_db + fade + shadow - 0.5
        steps.append(Step(t, v))
    sc = Scenario(
        "walk_fade",
        duration,
        steps,
        {"pair": pair, "rate_hz": rate_hz, "seed": seed, "loss_db": loss_db},
    )
    if clipped:
        sc.warnings.append(
            f"walk_fade: {clipped} of {n - 1} samples clipped at the unit's 31.75 dB "
            f"(base {loss_db:.1f} dB leaves less than {depth_db:.0f} dB of headroom)"
        )
    return sc


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
        if p in b.pairs:
            by_t.setdefault(round(t, 6), {})[p] = pl
    steps = []
    warnings = []
    cur: dict = {}  # pair -> bench loss (None = cut), carried across rows
    for t, upd in sorted(by_t.items()):
        for p, pl in upd.items():
            cur[p] = None if pl >= edge_db else pl - shift  # beyond the edge: cut
        if b.model == "node":
            # every live pair constrains the 4..6 node attenuators: fit, then cut
            v = {f"cut{p}": 0 if l is None else 1 for p, l in cur.items()}
            v.update(b.fit({p: l for p, l in cur.items() if l is not None}))
            warnings += [f"t={t:.3f}s {w}" for w in b.fit_warnings(tol_db=3.0)]
        else:
            v = {}
            for p in upd:
                v.update(b.link(p, cur[p] is not None, cur[p]))
        steps.append(Step(t, v))
    dur = (steps[-1].t + 1.0) if steps else 1.0
    sc = Scenario(name, dur, steps, {"tx_sim_dbm": tx_sim_dbm, "tx_bench_dbm": tx_bench_dbm})
    sc.warnings = warnings
    return sc


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
    # UART attenuator changes: (t_issue_us, t_land_us, device, value). The command
    # starts at t_issue (the latch edge of that step); the RF lands at t_land.
    uart: list = dataclasses.field(default_factory=list)


def _cut_moves(state: Mapping, values: Mapping) -> tuple[bool, bool]:
    """(makes, breaks): does this step close (through) or open (cut) any pair?"""
    makes = breaks = False
    for k, v in values.items():
        if not (k.startswith("cut") and len(k) == 5):
            continue
        was = state.get(k, 0) not in (0, "0")
        now = v not in (0, "0")
        makes |= now and not was
        breaks |= was and not now
    return makes, breaks


def compile(sc: Scenario, b: Bench, lead_s: float = 1.0, cap: int = 8192) -> Compiled:
    """Timeline relative to play's t0. The scenario starts `lead_s` after t0, after
    the sync code on the sync LED; every labelled step also toggles the LED, so the
    camera sees each event's instant.

    Switches (cuts, delay bank, sync LED) change on the step's latch edge, to the
    microsecond. UART attenuators (node model) are sequenced around it (design
    §5.4): in a step that closes a link, their commands go out early enough to
    have landed UART_GUARD_US before the latch (make-before); in a step that only
    opens links, they go out on the latch edge itself (break-before); in an
    attenuator-only step, early by the unit's latency, so the RF lands on time."""
    merged: dict = {}
    marks = []
    sync = []
    warnings = list(sc.warnings) + list(dict.fromkeys(b.warnings))
    b.warnings.clear()
    uart_log = []
    last_issue: dict = {}
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
    spacing_warned = set()
    for s in sorted(sc.steps, key=lambda s: s.t):
        t_us = int(round((lead_s + s.t) * 1e6))
        changed = {k: v for k, v in s.values.items() if state.get(k) != v}
        sw = {k: v for k, v in changed.items() if k not in b.uart_devs}
        at = {k: v for k, v in changed.items() if k in b.uart_devs}
        if sw:
            add(t_us, sw)
        if at:
            makes, breaks = _cut_moves(state, sw)
            for dev, val in at.items():
                lead = b.uart_lead_us(dev)
                if makes:
                    t_issue = t_us - lead - UART_GUARD_US
                elif breaks:
                    t_issue = t_us
                else:
                    t_issue = t_us - lead
                t_issue = max(0, t_issue)
                prev = last_issue.get(dev)
                if prev is not None and t_issue < prev + UART_MIN_SPACING_US:
                    t_issue = prev + UART_MIN_SPACING_US
                    if dev not in spacing_warned:
                        spacing_warned.add(dev)
                        warnings.append(
                            f"t={s.t:.3f}s {dev}: commands closer than "
                            f"{UART_MIN_SPACING_US} us, later ones delayed"
                        )
                last_issue[dev] = t_issue
                add(t_issue, {dev: val})
                uart_log.append((t_issue, t_issue + lead, dev, val))
        state.update(s.values)
        if s.label:
            marks.append((t_us, s.label))
            if b.has_sync:
                led ^= 1
                add(t_us, {"syncled": led})
                sync.append(t_us)
        if s.label or not warnings:
            for w in b.sneak_paths(state):
                key = w.split(":")[0]
                if key not in seen_warn:
                    seen_warn.add(key)
                    warnings.append(f"t={s.t:.3f}s sneak path: {w}")
    if b.has_sync and led:
        t_end = int(round((lead_s + sc.duration) * 1e6))
        add(t_end, {"syncled": 0})
        sync.append(t_end)
    # a UART-only step within MIN_STEP_US of another step joins it (us don't matter
    # to a command that lands milliseconds later)
    times = sorted(merged)
    k = 0
    while k + 1 < len(times):
        t0, t1 = times[k], times[k + 1]
        if t1 - t0 < MIN_STEP_US:
            for a, keep in ((t1, t0), (t0, t1)):
                if set(merged[a]) <= b.uart_devs:
                    for dev, val in merged.pop(a).items():
                        merged[keep].setdefault(dev, val)
                    times.remove(a)
                    break
            else:
                raise ValueError(
                    f"{sc.name}: steps {t0} and {t1} us are closer than {MIN_STEP_US} us"
                )
            continue
        k += 1
    for t, v in merged.items():
        unknown = set(v) - b.names
        if unknown:
            raise ValueError(f"{sc.name}: unknown devices {sorted(unknown)} at {t} us")
    n = sum(len(v) for v in merged.values())
    if n > cap:
        raise ValueError(f"{sc.name}: {n} timeline entries > controller capacity {cap}")
    return Compiled([(t, merged[t]) for t in times], marks, sync, warnings, uart_log)
