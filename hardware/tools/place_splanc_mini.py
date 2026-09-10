"""Reproduce Mini placement from address-based seeds and hard constraints.

Run with normal Python plus the PnR dependencies after pcbnew-based ingestion.
The seed is placement guidance, not a routing result.
"""
import argparse
import json
from pathlib import Path
import sys
import yaml

HARDWARE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HARDWARE / 'pnr'))
from pnr.graph import BoardGraph, BoardOutline
from pnr.constraints import compile_constraints, compile_routing_rules
from pnr.place.geometry import resolve_fixed_poses, keepout_rects, hard_group_limits
from pnr.place.legalize import legalize
from pnr.place.metrics import hard_violations

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('graph', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    project = HARDWARE / 'splanc_dev'
    seed = json.loads((project / 'mini-placement-seed.json').read_text())
    graph = BoardGraph.from_json(args.graph.read_text())
    for c in graph.components:
        if c.address in seed:
            previous = seed[c.address]
            c.pos, c.rot, c.side = previous['pos'], previous['rot'], previous['side']
    cc = compile_constraints(yaml.safe_load((project / 'mini-constraints.yaml').read_text()),
        graph.refs, {c.address: c.ref for c in graph.components},
        {f'{c.address}:{p.name}': p.net for c in graph.components for p in c.pads})
    poses = resolve_fixed_poses(graph, cc)
    for con in cc.constraints:
        if con.kind == 'fixed':
            for c in graph.components:
                if c.ref in con.refs:
                    c.rot = con.params.get('rot', 0)
                    c.side = con.params.get('side', 'top')
    graph = legalize(graph, 85, 65, fixed=poses,
        keepouts=keepout_rects(graph, cc, poses), group_limits=hard_group_limits(cc, poses),
        clearance=.2, grid_mm=.25)
    graph.outline = BoardOutline(85, 65)
    violations = hard_violations(graph, cc, clearance=0)
    if any(violations.values()):
        raise ValueError(violations)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / 'mini-placed.json').write_text(graph.to_json())
    (args.output_dir / 'mini-rules.json').write_text(json.dumps(
        compile_routing_rules(cc, [n.name for n in graph.nets]), indent=2))
    (args.output_dir / 'mini-placement-checks.json').write_text(json.dumps(violations, indent=2))
    print('Mini placement satisfies all hard constraints')

if __name__ == '__main__':
    main()
