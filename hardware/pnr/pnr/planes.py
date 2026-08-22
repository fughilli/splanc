"""Pour ground / power planes on the routed board (design §9.6 follow-on).

Runs **after** the detailed route (FreeRouting drops pre-poured zones through its
DSN/SES round-trip). For each ``plane_layer`` net class in ``rules.json`` it pours
a filled copper zone bound to the net on that inner layer and via-stitches every
pad of the net down to it — see :func:`pnr.writeback.apply_planes`. High-fanout
ground / power nets (e.g. `lv` at 75 pads) are hopeless to trace-route; a plane +
via drops removes them from the routing problem entirely.

Runs under the KiCad ``pcbnew`` python (``@kicad_python``); ``pcbnew`` is imported
lazily so the module imports fine elsewhere.

    python -m pnr.planes routed.kicad_pcb --rules rules.json
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from pnr.writeback import apply_planes, patch_project_rules


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pcb", help="the routed .kicad_pcb (modified in place)")
    ap.add_argument("--rules", required=True, help="rules.json (pnr.route --dump-rules)")
    args = ap.parse_args(argv)

    import pcbnew

    with open(args.rules, encoding="utf-8") as fh:
        rules = json.load(fh)

    board = pcbnew.LoadBoard(args.pcb)
    board.BuildConnectivity()
    n = apply_planes(board, rules)
    pcbnew.SaveBoard(args.pcb, board)
    # Authoritatively stamp the design rules into the project file *after* the last
    # board save — DRC reads the .kicad_pro, and the board's live settings detach
    # from it across SetCopperLayerCount/BuildConnectivity (see patch_project_rules).
    pro = args.pcb[: -len(".kicad_pcb")] + ".kicad_pro" if args.pcb.endswith(".kicad_pcb") else None
    if pro and patch_project_rules(pro):
        print(f"planes: poured {n} plane(s); design rules stamped into {pro}")
    else:
        print(f"planes: poured {n} plane(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
