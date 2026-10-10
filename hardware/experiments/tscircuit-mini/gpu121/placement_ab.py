"""Actual Mini continuous placement timing; no legalized/routed result."""
import hashlib, json, math, os, statistics, time, sys
from pathlib import Path
from unittest.mock import patch
import yaml
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.model import global_place
from pnr.place.geometry import resolve_fixed_poses, outline_size
from pnr.place.metrics import hpwl

def placement_ab(graph, constraints, out):
    original = graph.to_json()
    fixed = resolve_fixed_poses(graph, constraints)
    width, height = outline_size(graph, constraints)
    rows = []
    first = {}
    determinism = []
    outputs = {}
    warmups = []

    def one(enabled, seed, iters):
        g = BoardGraph.from_json(original)
        with patch.dict(os.environ, {'PNR_BATCHED_WIRELENGTH': '1' if enabled else '0'}):
            cpu = time.process_time()
            wall = time.perf_counter()
            positions, rotations = global_place(g, constraints, width, height, seed=seed, iters=iters)
            elapsed = time.perf_counter() - wall
            cpu = time.process_time() - cpu
        assert g.to_json() == original
        assert all((math.isfinite(v) for xy in positions.values() for v in xy))
        fixed_error = max((math.dist(positions[r], xy) for r, xy in fixed.items()), default=0.0)
        assert fixed_error < 2e-05, ('fixedposechanged', fixed_error)
        placed = BoardGraph.from_json(original)
        for c in placed.components:
            c.pos = positions[c.ref]
            c.rot = rotations[c.ref]
        return (positions, rotations, dict(wall_s=elapsed, cpu_s=cpu, hpwl_mm=hpwl(placed), fixed_max_error_mm=fixed_error))
    for enabled in [False, True]:
        _, _, r = one(enabled, 999, 20)
        warmups.append(dict(batched=enabled, **r))
    for seed in [0, 1, 2]:
        for repeat in [0, 1]:
            for enabled in [False, True] if (seed + repeat) % 2 == 0 else [True, False]:
                positions, rotations, r = one(enabled, seed, 200)
                rows.append(dict(seed=seed, repeat=repeat, batched=enabled, **r))
                key = (seed, enabled)
                print(json.dumps(rows[-1]), flush=True)
                if key in first:
                    oldp, oldr = first[key]
                    determinism.append(dict(seed=seed, batched=enabled, exact=oldp == positions and oldr == rotations, max_position_delta_mm=max((math.dist(oldp[k], positions[k]) for k in oldp)), rotation_changes=[k for k in oldr if oldr[k] != rotations[k]]))
                else:
                    first[key] = (positions, rotations)
                outputs[key] = (positions, rotations)
    comparisons = []
    for seed in [0, 1, 2]:
        a, ar = outputs[seed, False]
        b, br = outputs[seed, True]
        comparisons.append(dict(seed=seed, max_position_delta_mm=max((math.dist(a[k], b[k]) for k in a)), rms_position_delta_mm=math.sqrt(sum((math.dist(a[k], b[k]) ** 2 for k in a)) / len(a)), rotation_changes=[k for k in ar if ar[k] != br[k]], legacy_positions=a, batched_positions=b))
    result = dict(kind='continuous_placement_only', iterations=200, seeds=[0, 1, 2], width_mm=width, height_mm=height, graph_sha256=hashlib.sha256(original.encode()).hexdigest(), warmups=warmups, rows=rows, determinism=determinism, comparisons=comparisons, median_wall_s={str(flag): statistics.median((r['wall_s'] for r in rows if r['batched'] == flag)) for flag in [False, True]}, qualification='No legalizer/nativeDRC: continuous poses only; acceptance remains downstream')
    assert graph.to_json() == original and all((r['exact'] for r in determinism))
    Path(out).write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != 'comparisons'}, indent=2))
    return result
if __name__ == '__main__':
    graph = BoardGraph.from_json(Path(sys.argv[1]).read_text())
    path = Path(sys.argv[2])
    constraints = compile_constraints(yaml.safe_load(path.read_text()), graph.refs, {c.address: c.ref for c in graph.components if c.address}, {f'{c.address}:{p.name}': p.net for c in graph.components if c.address for p in c.pads if p.name})
    result = placement_ab(graph, constraints, sys.argv[3])
    result['constraints_path'] = str(path.resolve())
    result['constraints_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    result['constraint_warnings'] = constraints.warnings
    Path(sys.argv[3]).write_text(json.dumps(result, indent=2))
