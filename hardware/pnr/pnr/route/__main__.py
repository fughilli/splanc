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
        "--dump-routes",
        metavar="PATH",
        help="run the own detailed router on the placed board and write its "
        "mm-space tracks/vias (routes.json) for write-back to emit",
    )
    ap.add_argument(
        "--route-pitch",
        type=float,
        default=0.0,
        help="detailed-router grid pitch (mm); 0 = auto from the fab profile "
        "(track+clearance floor, so a tighter fab routes finer)",
    )
    ap.add_argument(
        "--route-iters", type=int, default=12, help="detailed-router negotiation passes"
    )
    ap.add_argument(
        "--no-escape",
        action="store_true",
        help="disable pin-escape planning (via-in-pad / dog-bone) for A/B comparison",
    )
    ap.add_argument(
        "--place-spread",
        type=float,
        default=1.0,
        help="floor on the legalizer's per-part footprint inflation, so placement "
        "leaves routing channels between all footprints (1.0 = pack tight; "
        "1.3-1.6 = spread for routability)",
    )
    ap.add_argument(
        "--detail-loop",
        action="store_true",
        help="close the place<->route loop on the DRC-clean detailed router "
        "(unrouted signals drive placement inflation) instead of the fast global "
        "lookahead — the honest 'route must succeed or fail the build' loop",
    )
    ap.add_argument(
        "--auto-outline",
        action="store_true",
        help="rubber-band the board outline: if it won't fully route at the target "
        "size, grow the outline (aspect preserved) and retry until it routes or "
        "--outline-max-scale — the smallest outline that fully routes wins",
    )
    ap.add_argument(
        "--outline-max-scale",
        type=float,
        default=2.0,
        help="max rubber-band outline scale (linear; 2.0 => up to 4x area)",
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

    net_names = [n.name for n in graph.nets]
    rules = compile_routing_rules(constraints, net_names)
    route_pitch = args.route_pitch or None  # 0 => auto from the fab profile

    placed, report = route_and_place(
        graph,
        constraints,
        seed=args.seed,
        iters=args.iters,
        max_rounds=args.max_rounds,
        gcell_mm=args.gcell_mm,
        # Close the loop on the DRC-clean detailed router when asked — the emitted
        # route must actually succeed, so it steers placement, not the lookahead.
        detail_rules=rules if args.detail_loop else None,
        detail_pitch_mm=route_pitch,
        detail_iters=args.route_iters,
        auto_outline=args.auto_outline,
        outline_max_scale=args.outline_max_scale,
        spread=args.place_spread,
    )
    print(report.summary())

    if args.dump_json:
        with open(args.dump_json, "w", encoding="utf-8") as fh:
            fh.write(placed.to_json())
    if args.dump_svg:
        with open(args.dump_svg, "w", encoding="utf-8") as fh:
            fh.write(dump_svg(placed))
    if args.dump_rules:
        with open(args.dump_rules, "w", encoding="utf-8") as fh:
            json.dump(rules, fh, indent=2, sort_keys=True)

    if args.dump_routes:
        from pnr.route.detail.router import route_board

        board = route_board(
            placed,
            constraints,
            rules,
            pitch=route_pitch,
            max_iters=args.route_iters,
            escape_via_in_pad=not args.no_escape,
            escape_dogbone=not args.no_escape,
        )
        print(board.summary())
        routes = {
            "tracks": [
                [net, la, [a[0], a[1]], [b[0], b[1]], w] for net, la, a, b, w in board.tracks
            ],
            "vias": [[net, x, y] for (net, x, y) in board.vias],
            "unrouted": board.result.unrouted,
        }
        with open(args.dump_routes, "w", encoding="utf-8") as fh:
            json.dump(routes, fh, indent=2, sort_keys=True)

    ok = report.converged or args.allow_unconverged
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
