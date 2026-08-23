"""Post-route quality analysis (design §9.6 — the Phase 6 quality pass).

Once the board is routed (FreeRouting), this measures the things a placement/route
loop can't see until copper exists: **routed length** and **via count** per net,
**differential-pair length skew**, and **length-match** group compliance. It turns
the ``diff_pair`` / ``length_match`` / ``net_class`` guidance (see
``docs/hardware/pnr-inputs.md``) into concrete pass/fail checks, and reports the
totals used for via/length optimization.

Two layers, mirroring the rest of the engine:

- :func:`analyze` is **pure** (per-net length/via dicts + the resolved rules → a
  :class:`QualityReport`), so it is unit-testable with no KiCad.
- :func:`net_lengths` loads the routed ``.kicad_pcb`` via ``pcbnew`` (lazy import,
  ``@kicad_python``) — summing ``PCB_TRACK`` lengths and counting ``PCB_VIA`` per
  net.

The rules come from ``rules.json`` (emitted by ``pnr.route`` from the compiled
constraints), so this step needs neither pyyaml nor torch — it runs under the same
KiCad python as ingest/writeback.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

_NM_PER_MM = 1_000_000.0


@dataclass
class DiffPairResult:
    name: str
    p: str
    n: str
    len_p_mm: float
    len_n_mm: float
    skew_mm: float
    tol_mm: float
    routed: bool  # both nets have copper

    @property
    def ok(self) -> bool:
        return self.routed and self.skew_mm <= self.tol_mm + 1e-6


@dataclass
class LengthMatchResult:
    name: str
    nets: List[str]
    lengths_mm: List[float]
    spread_mm: float
    tol_mm: float
    routed: bool  # every member has copper

    @property
    def ok(self) -> bool:
        return self.routed and self.spread_mm <= self.tol_mm + 1e-6


@dataclass
class QualityReport:
    total_length_mm: float
    total_vias: int
    routed_nets: int
    unrouted: int = 0  # remaining ratsnest connections (0 == fully routed)
    diff_pairs: List[DiffPairResult] = field(default_factory=list)
    length_matches: List[LengthMatchResult] = field(default_factory=list)
    net_class_length_mm: Dict[str, float] = field(default_factory=dict)

    @property
    def fully_routed(self) -> bool:
        return self.unrouted == 0

    @property
    def ok(self) -> bool:
        """Fully routed AND all diff-pair + length-match checks pass."""
        return (
            self.fully_routed
            and all(d.ok for d in self.diff_pairs)
            and all(m.ok for m in self.length_matches)
        )

    def summary(self) -> str:
        route = "fully routed" if self.fully_routed else f"{self.unrouted} UNROUTED connections"
        lines = [
            f"routed length {self.total_length_mm:.0f} mm, {self.total_vias} vias, "
            f"{self.routed_nets} nets with copper — {route}"
        ]
        for c, ln in sorted(self.net_class_length_mm.items()):
            lines.append(f"  net-class {c}: {ln:.0f} mm")
        for d in self.diff_pairs:
            status = "OK" if d.ok else ("UNROUTED" if not d.routed else "FAIL")
            lines.append(
                f"  diff-pair {d.name}: skew {d.skew_mm:.2f} mm " f"(tol {d.tol_mm:.2f}) [{status}]"
            )
        for m in self.length_matches:
            status = "OK" if m.ok else ("UNROUTED" if not m.routed else "FAIL")
            lines.append(
                f"  length-match {m.name}: spread {m.spread_mm:.2f} mm "
                f"(tol {m.tol_mm:.2f}) [{status}]"
            )
        lines.append(f"quality: {'PASS' if self.ok else 'FAIL'}")
        return "\n".join(lines)


def analyze(
    lengths: Dict[str, float],
    vias: Dict[str, int],
    rules: Dict,
    unrouted: int = 0,
) -> QualityReport:
    """Score routed per-net ``lengths`` (mm) + ``vias`` against ``rules`` (the
    ``rules.json`` dict). ``unrouted`` is the remaining ratsnest count (0 == fully
    routed). Pure — no KiCad."""
    total_len = float(sum(lengths.values()))
    total_vias = int(sum(vias.values()))
    routed = sum(1 for v in lengths.values() if v > 0)

    diff_pairs: List[DiffPairResult] = []
    for dp in rules.get("diff_pairs", []):
        lp = lengths.get(dp["p"], 0.0)
        ln = lengths.get(dp["n"], 0.0)
        is_routed = lp > 0 and ln > 0
        diff_pairs.append(
            DiffPairResult(
                name=dp["name"],
                p=dp["p"],
                n=dp["n"],
                len_p_mm=lp,
                len_n_mm=ln,
                skew_mm=abs(lp - ln),
                tol_mm=float(dp.get("skew_mm", 0.5)),
                routed=is_routed,
            )
        )

    length_matches: List[LengthMatchResult] = []
    for lm in rules.get("length_match", []):
        nets = list(lm.get("nets", []))
        lns = [lengths.get(n, 0.0) for n in nets]
        is_routed = all(v > 0 for v in lns) and len(lns) >= 2
        spread = (max(lns) - min(lns)) if lns else 0.0
        length_matches.append(
            LengthMatchResult(
                name=lm["name"],
                nets=nets,
                lengths_mm=lns,
                spread_mm=spread,
                tol_mm=float(lm.get("tolerance_mm", 1.0)),
                routed=is_routed,
            )
        )

    nc_len: Dict[str, float] = {}
    for nc in rules.get("net_classes", []):
        nc_len[nc["name"]] = float(sum(lengths.get(n, 0.0) for n in nc.get("nets", [])))

    return QualityReport(
        total_length_mm=total_len,
        total_vias=total_vias,
        routed_nets=routed,
        unrouted=int(unrouted),
        diff_pairs=diff_pairs,
        length_matches=length_matches,
        net_class_length_mm=nc_len,
    )


def net_lengths(board) -> Tuple[Dict[str, float], Dict[str, int]]:
    """Per-net routed track length (mm) and via count from an open ``pcbnew.BOARD``."""
    import pcbnew

    lengths: Dict[str, float] = {}
    vias: Dict[str, int] = {}
    for t in board.GetTracks():
        net = t.GetNetname()
        if isinstance(t, pcbnew.PCB_VIA):
            vias[net] = vias.get(net, 0) + 1
        else:
            lengths[net] = lengths.get(net, 0.0) + t.GetLength() / _NM_PER_MM
    return lengths, vias


def unrouted_count(board) -> int:
    """Remaining ratsnest connections (unrouted pin pairs). 0 == fully routed."""
    try:
        conn = board.GetConnectivity()
        return int(conn.GetUnconnectedCount(True))
    except Exception:  # pragma: no cover - version shim
        return 0


def load(pcb_path: str) -> Tuple[Dict[str, float], Dict[str, int], int]:
    import pcbnew

    board = pcbnew.LoadBoard(pcb_path)
    board.BuildConnectivity()
    lengths, vias = net_lengths(board)
    return lengths, vias, unrouted_count(board)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pcb", help="the routed .kicad_pcb")
    ap.add_argument("--rules", help="rules.json (pnr.route --dump-rules); optional")
    ap.add_argument("--out", metavar="PATH", help="write the report text")
    ap.add_argument("--gate", action="store_true", help="exit nonzero if any check fails")
    ap.add_argument(
        "--require-routed",
        action="store_true",
        help="exit nonzero if any net is unrouted (the routing-completeness gate)",
    )
    args = ap.parse_args(argv)

    lengths, vias, unrouted = load(args.pcb)
    rules = {}
    if args.rules:
        with open(args.rules, encoding="utf-8") as fh:
            rules = json.load(fh)

    report = analyze(lengths, vias, rules, unrouted=unrouted)
    text = report.summary()
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")

    if args.require_routed and not report.fully_routed:
        sys.stderr.write(
            "pnr: routing incomplete — %d unrouted connection(s); board is not "
            "fab-ready\n" % report.unrouted
        )
        return 4
    if args.gate and not report.ok:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
