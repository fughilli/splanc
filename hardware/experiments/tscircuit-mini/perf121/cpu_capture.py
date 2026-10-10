import argparse, hashlib, json, os, pickle, shutil, time
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace
from pnr.graph import BoardGraph
from pnr.route.detail import maze, router

class Captured(Exception):
    pass

def main():
    p = argparse.ArgumentParser()
    p.add_argument('diagnostics')
    p.add_argument('--out', required=True)
    p.add_argument('--nets', type=int, default=8)
    a = p.parse_args()
    root = Path(a.diagnostics).resolve()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(out).free < 25 * 1024 ** 3:
        raise RuntimeError('25GiB free-space floor')
    placed = root / 'round-01/placed.json'
    rulespath = root / 'rules.json'
    graph = BoardGraph.from_dict(json.loads(placed.read_text()))
    rules = json.loads(rulespath.read_text())
    constraints = SimpleNamespace(board=SimpleNamespace(width=None, height=None))
    state = {}

    def capture(grid, access, **kwargs):
        grid.routing_track_halos = kwargs.get('net_halo') or {}
        grid.routing_via_keepout = kwargs.get('via_keepout', 1)
        state.update(grid=grid, access=access, kwargs=kwargs)
        raise Captured()
    router.route = capture
    os.environ['PNR_PACKED_MAZE'] = '0'
    os.environ['PNR_SINGLE_TRACK_WORKERS'] = '1'
    for k in ('PNR_PROFILE_DIR', 'PNR_LIVE_DIR', 'PNR_CONTROL_FILE'):
        os.environ.pop(k, None)
    started = time.perf_counter()
    try:
        router.route_board(graph, constraints, rules)
    except Captured:
        pass
    else:
        raise RuntimeError('route intercept was not reached')
    grid, access = (state['grid'], state['access'])

    def span(name):
        cells = access[name]
        return max((c.i for c in cells)) - min((c.i for c in cells)) + max((c.j for c in cells)) - min((c.j for c in cells))
    ordered = sorted(access, key=lambda n: (span(n), n))
    count = min(a.nets, len(ordered))
    selected = [ordered[round(i * (len(ordered) - 1) / max(1, count - 1))] for i in range(count)]
    occ = defaultdict(int)
    history = {}
    jobs = []
    footprints = {}
    cost = state['kwargs']['via_cost']
    for net in selected:
        job = (access[net], net, dict(occ), dict(history), cost, 0.5, None)
        jobs.append(job)
        t = time.perf_counter()
        route = maze._route_one(grid, *job[:2], *job[2:6], blocked=job[6])
        fp = maze._footprint(grid, route.cells, grid.routing_via_keepout, grid.routing_track_halos.get(net, 0), edges=route.edges, net=net) if route else set()
        footprints[net] = fp
        for cell in fp:
            occ[cell] += 1
        print(json.dumps({'phase': 'capture fixed negotiation snapshot', 'net': net, 'span': span(net), 'seconds': time.perf_counter() - t, 'occupied_cells': len(occ)}), flush=True)
    for net in selected[::2]:
        blocked = set().union(*(fp for n, fp in footprints.items() if n != net))
        jobs.append((access[net], net, {}, {}, cost, 0.0, blocked))
    hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in (placed, rulespath)}
    metadata = {'input_sha256': hashes, 'kind': 'Reduced fixed proposal replay on exact fresh119 round1 source grid/escapes; not original full iteration', 'selected_nets': selected, 'all_routable_nets': len(access), 'jobs': len(jobs), 'grid': [grid.nlayers, grid.nx, grid.ny], 'grid_pitch': grid.pitch, 'capture_wall_s': time.perf_counter() - started, 'module_files': {m.__name__: m.__file__ for m in (maze, router)}}
    payload = pickle.dumps({'grid': grid, 'jobs': jobs, 'metadata': metadata}, protocol=pickle.HIGHEST_PROTOCOL)
    (out / 'workload.pkl').write_bytes(payload)
    metadata['workload_sha256'] = hashlib.sha256(payload).hexdigest()
    metadata['bytes'] = len(payload)
    (out / 'workload.json').write_text(json.dumps(metadata, indent=2))
    print(json.dumps(metadata, indent=2))
if __name__ == '__main__':
    main()
