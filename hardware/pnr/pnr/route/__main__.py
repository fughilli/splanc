"""CLI: run the full place↔route loop on an ingested board (design §6/Phase 4).

    python -m pnr.route graph.json constraints.yaml \
        --dump-json placed.json --dump-svg placed.svg

Loads a :class:`pnr.graph.BoardGraph` (from ``pnr.ingest --dump-json``) and its
``constraints.yaml``, runs :func:`pnr.route.feedback.route_and_place` to a
routable placement, and writes the placed graph. This is the torch-side step of
the end-to-end ``<board>.fab`` flow: ingest (pcbnew) → **this** → writeback
(pcbnew) → detailed route. Exit non-zero if the loop does not converge.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from pnr.constraints import compile_constraints, compile_routing_rules
from pnr.graph import BoardGraph
from pnr.ingest import dump_svg
from pnr.route.feedback import route_and_place


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("graph", help="BoardGraph JSON (pnr.ingest --dump-json)")
    ap.add_argument("constraints", help="constraints.yaml")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--iters", type=int, default=600)
    ap.add_argument("--max-rounds", type=int, default=6)
    ap.add_argument("--gcell-mm", type=float, default=2.5)
    ap.add_argument("--dump-json", metavar="PATH")
    ap.add_argument("--dump-svg", metavar="PATH")
    ap.add_argument(
        "--dump-rules",
        metavar="PATH",
        help="write resolved net-class/diff-pair/length-match rules (rules.json) "
        "for the pcbnew writeback + quality steps",
    )
    ap.add_argument(
        "--allow-unconverged",
        action="store_true",
        help="exit 0 even if the loop did not drive overflow to 0 (for previews)",
    )
    args = ap.parse_args(argv)

    import yaml

    with open(args.graph, encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    with open(args.constraints, encoding="utf-8") as fh:
        constraints = compile_constraints(yaml.safe_load(fh), graph.refs)

    placed, report = route_and_place(
        graph,
        constraints,
        seed=args.seed,
        iters=args.iters,
        max_rounds=args.max_rounds,
        gcell_mm=args.gcell_mm,
    )
    print(report.summary())

    if args.dump_json:
        with open(args.dump_json, "w", encoding="utf-8") as fh:
            fh.write(placed.to_json())
    if args.dump_svg:
        with open(args.dump_svg, "w", encoding="utf-8") as fh:
            fh.write(dump_svg(placed))
    if args.dump_rules:
        net_names = [n.name for n in graph.nets]
        with open(args.dump_rules, "w", encoding="utf-8") as fh:
            json.dump(compile_routing_rules(constraints, net_names), fh, indent=2, sort_keys=True)

    ok = report.converged or args.allow_unconverged
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
