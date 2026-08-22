"""CLI: place a board from an ingested graph + constraints.

    python -m pnr.place graph.json constraints.yaml \
        --dump-svg placed.svg --dump-json placed.json

Loads a :class:`pnr.graph.BoardGraph` (from ``pnr.ingest --dump-json``) and its
``constraints.yaml``, runs the placer, and prints the report. Optionally writes
the placed graph and an SVG of the result.
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from pnr.constraints import compile_constraints
from pnr.graph import BoardGraph
from pnr.ingest import dump_svg
from pnr.place import place


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("graph", help="BoardGraph JSON (pnr.ingest --dump-json)")
    ap.add_argument("constraints", help="constraints.yaml")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--iters", type=int, default=800)
    ap.add_argument("--grid-mm", type=float, default=0.5)
    ap.add_argument("--dump-svg", metavar="PATH")
    ap.add_argument("--dump-json", metavar="PATH")
    args = ap.parse_args(argv)

    import yaml

    with open(args.graph, encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    with open(args.constraints, encoding="utf-8") as fh:
        constraints = compile_constraints(yaml.safe_load(fh), graph.refs)

    placed, report = place(
        graph, constraints, seed=args.seed, iters=args.iters, grid_mm=args.grid_mm
    )
    print(report.summary())
    if not report.legal:
        print("  overlaps:", report.overlaps[:5])
        print("  outside:", report.outside_outline[:5])
        print("  keepout:", report.keepout[:5])

    if args.dump_json:
        with open(args.dump_json, "w", encoding="utf-8") as fh:
            fh.write(placed.to_json())
    if args.dump_svg:
        with open(args.dump_svg, "w", encoding="utf-8") as fh:
            fh.write(dump_svg(placed))
    return 0 if report.legal else 1


if __name__ == "__main__":
    sys.exit(main())
