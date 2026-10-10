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
from pnr.place.geometry import resolve_fixed_poses, keepout_rects, hard_group_limits, set_component_side, apply_hard_sides
from pnr.place.legalize import legalize, refine_channels
from pnr.place.metrics import hard_violations
from pnr.place.channels import ChannelModel

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('graph', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--preserve-input-placement', action='store_true',
                        help='Use the ingested checkpoint poses instead of the old seed')
    parser.add_argument('--channel-weight', type=float, default=5.,
                        help='Surface escape pressure weight; zero gives the old legalizer')
    parser.add_argument('--movable', action='append', default=[],
                        help='Limit checkpoint refinement to these references; repeat as needed')
    parser.add_argument('--max-move-mm', type=float, default=2.)
    args = parser.parse_args()
    if args.movable and not args.preserve_input_placement:
        parser.error('--movable requires --preserve-input-placement')
    if args.max_move_mm <= 0:
        parser.error('positive movement bound required')
    project = HARDWARE / 'splanc_dev'
    seed = json.loads((project / 'mini-placement-seed.json').read_text())
    graph = BoardGraph.from_json(args.graph.read_text())
    for c in graph.components:
        if not args.preserve_input_placement and c.address in seed:
            previous = seed[c.address]
            c.pos, c.rot = previous['pos'], previous['rot']
            set_component_side(c, previous['side'] or 'top')
    config = yaml.safe_load((project / 'mini-constraints.yaml').read_text())
    width, height = config['board']['outline']['w'], config['board']['outline']['h']
    cc = compile_constraints(config,
        graph.refs, {c.address: c.ref for c in graph.components},
        {f'{c.address}:{p.name}': p.net for c in graph.components for p in c.pads})
    apply_hard_sides(graph, cc)
    # Generated mounting footprints live inside their own keepouts. Validate
    # their exact poses and retain them separately; the keepout already reserves
    # the full mechanical space during circuit-component legalization.
    holes = []
    for hole in cc.mounting_holes:
        if hole['name'] in graph.refs:
            component = graph.component(hole['name'])
            if any(abs(a-b) > 1e-6 for a,b in zip(component.pos, hole['at'])):
                raise ValueError(f"Mounting hole {component.ref} is off its required position")
            holes.append(component)
    graph.components = [c for c in graph.components if c not in holes]
    poses = resolve_fixed_poses(graph, cc)
    for con in cc.constraints:
        if con.kind == 'fixed':
            for c in graph.components:
                if c.ref in con.refs:
                    c.rot = con.params.get('rot', 0)
                    set_component_side(c, con.params.get('side') or 'top')
    # Move each seeded support cluster with its anchor before legalization.
    # Otherwise compacting the board leaves capacitors targeting the old IC site.
    shifted = set()
    for con in cc.constraints:
        if con.kind != 'group' or con.params.get('anchor') not in poses:
            continue
        anchor = graph.component(con.params['anchor'])
        if args.preserve_input_placement or anchor.address not in seed:
            continue
        old = seed[anchor.address]['pos']
        target = poses[anchor.ref]
        for ref in con.refs:
            if ref in poses or ref in shifted:
                continue
            component = graph.component(ref)
            component.pos = (component.pos[0] + target[0] - old[0],
                             component.pos[1] + target[1] - old[1])
            shifted.add(ref)
    for c in graph.components:
        if c.locked:
            poses.setdefault(c.ref, c.pos)
    if args.movable:
        unknown = set(args.movable) - set(graph.refs)
        if unknown:
            raise ValueError(f'Unknown movable references: {sorted(unknown)}')
        for c in graph.components:
            if c.ref not in args.movable:
                poses.setdefault(c.ref, c.pos)
    rules = compile_routing_rules(cc, [n.name for n in graph.nets])
    channel_model = ChannelModel(graph, rules)
    before = channel_model.report(graph, poses)
    original = graph
    placement_options = dict(fixed=poses,
        keepouts=keepout_rects(graph, cc, poses), group_limits=hard_group_limits(cc, poses),
        clearance=.2, grid_mm=.25)
    if args.preserve_input_placement:
        existing_violations = hard_violations(graph, cc, clearance=0)
        if any(existing_violations.values()):
            raise ValueError(existing_violations)
        graph = refine_channels(graph, width, height, **placement_options,
            channel_model=channel_model, channel_weight=args.channel_weight,
            max_move_mm=args.max_move_mm)
    else:
        graph = legalize(graph, width, height, **placement_options,
            channel_model=channel_model if args.channel_weight else None,
            channel_weight=args.channel_weight)
    graph.outline = BoardOutline(width, height)
    violations = hard_violations(graph, cc, clearance=0)
    if any(violations.values()):
        raise ValueError(violations)
    graph.components.extend(holes)
    original.components.extend(holes)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / 'mini-placed.json').write_text(graph.to_json())
    (args.output_dir / 'mini-rules.json').write_text(json.dumps(
        rules, indent=2))
    (args.output_dir / 'mini-channel-report.json').write_text(json.dumps(dict(
        before=before, after=channel_model.report(graph, poses),
        movements=[dict(ref=c.ref, before=original.component(c.ref).pos, after=c.pos)
                   for c in graph.components if tuple(c.pos) != tuple(original.component(c.ref).pos)]), indent=2))
    (args.output_dir / 'mini-placement-checks.json').write_text(json.dumps(violations, indent=2))
    print('Mini placement satisfies all hard constraints')

if __name__ == '__main__':
    main()
