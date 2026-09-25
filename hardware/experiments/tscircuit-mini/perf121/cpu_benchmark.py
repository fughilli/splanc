import argparse, hashlib, json, os, pickle, resource, statistics, time, random
from pathlib import Path
from pnr.route.detail import maze, parallel

def digest(route):
    if route is None:
        return None
    cells = lambda cs: [(c.layer, c.i, c.j) for c in cs]
    return hashlib.sha256(json.dumps({'cells': cells(route.cells), 'edges': [cells(edge) for edge in route.edges]}, sort_keys=True).encode()).hexdigest()

def measured(job):
    access, net, occ, history, via_cost, pres_fac, blocked = job
    cpu = time.process_time()
    wall = time.perf_counter()
    route = maze._route_one(parallel._GRID, access, net, occ, history, via_cost, pres_fac, blocked=blocked)
    return {'digest': digest(route), 'cpu_s': time.process_time() - cpu, 'wall_s': time.perf_counter() - wall, 'rss_bytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'pid': os.getpid()}

def update(out, phase, experiments):
    import shutil
    free = shutil.disk_usage(out).free
    if free < 25 * 1024 ** 3:
        raise RuntimeError('25GiB free-space floor reached')
    data = {'status': 'running', 'phase': phase, 'updated_at': time.time(), 'metrics': {'disk_free_gib': free / 1024 ** 3}, 'experiments': experiments, 'viewer_url': 'http://mac-mini.tail6b8ad3.ts.net:8772/', 'note': 'Fixed-work CPU kernel benchmark; not a new accepted Mini layout.'}
    tmp = out / 'status.tmp'
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(out / 'status.json')

def ready(_):
    time.sleep(0.05)
    return os.getpid()

def main():
    p = argparse.ArgumentParser()
    p.add_argument('workload')
    p.add_argument('--out', required=True)
    p.add_argument('--repeats', type=int, default=3)
    a = p.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    data = pickle.loads(Path(a.workload).read_bytes())
    grid, jobs = (data['grid'], data['jobs'])
    rows = []
    expected = None
    for key in ('PNR_PROFILE_DIR', 'PNR_CONTROL_FILE', 'PNR_LIVE_DIR'):
        os.environ.pop(key, None)
    variants = [(False, 1), (True, 1), (True, 2), (True, 4), (False, 2), (False, 4)]
    random.Random(121).shuffle(variants)
    for packed, workers in variants:
        os.environ['PNR_PACKED_MAZE'] = '1' if packed else '0'
        update(out, f'benchmark packed={packed}, workers={workers}', rows)
        started = time.perf_counter()
        pool = parallel.NetPool(grid, workers) if workers > 1 else None
        if pool:
            warm = ([jobs[0][0][0]], jobs[0][1], {}, {}, 3.0, 0.0, None)
            list(pool.pool.map(measured, [warm] * workers))
            seen = set()
            deadline = time.monotonic() + 20
            while len(seen) < workers:
                seen.update(pool.pool.map(ready, range(workers)))
                if time.monotonic() > deadline:
                    raise RuntimeError('worker startup timed out')
        else:
            parallel.initialize(grid)
        setup = time.perf_counter() - started
        try:
            for repeat in range(a.repeats):
                load = os.getloadavg()
                t = time.perf_counter()
                parent_cpu = time.process_time()
                values = list(pool.pool.map(measured, jobs)) if pool else [measured(job) for job in jobs]
                wall = time.perf_counter() - t
                parent = time.process_time() - parent_cpu
                signature = [v['digest'] for v in values]
                if expected is None:
                    expected = signature
                if signature != expected:
                    raise AssertionError(f'Path parity failed packed={packed},workers={workers}')
                rows.append({'packed': packed, 'workers': workers, 'repeat': repeat, 'jobs': len(jobs), 'wall_s': wall, 'leaf_cpu_s': sum((v['cpu_s'] for v in values)), 'parent_cpu_s': parent, 'setup_s': setup, 'load_before': load, 'load_after': os.getloadavg(), 'path_hashes': signature, 'job_metrics': [dict(net=job[1], **value) for job, value in zip(jobs, values)], 'worker_pids': sorted({v['pid'] for v in values}), 'worker_peak_rss_bytes': max((v['rss_bytes'] for v in values))})
                (out / 'benchmark-results.json').write_text(json.dumps({'metadata': data.get('metadata', {}), 'rows': rows, 'note': 'Leaf CPU overlaps parent CPU for workers=1. Neither is summed with parent wait time. Startup separate; serialization inside wall time.'}, indent=2))
                update(out, f'completed packed={packed},workers={workers},repeat={repeat}', rows)
        finally:
            if pool:
                pool.close()
    summary = []
    for packed, workers in variants:
        subset = [r for r in rows if r['packed'] == packed and r['workers'] == workers]
        summary.append({'packed': packed, 'workers': workers, 'median_wall_s': statistics.median((r['wall_s'] for r in subset)), 'median_leaf_cpu_s': statistics.median((r['leaf_cpu_s'] for r in subset))})
    (out / 'benchmark-summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    update(out, 'benchmark complete; all exact path hashes match', summary)
    status = json.loads((out / 'status.json').read_text())
    status['status'] = 'complete'
    (out / 'status.json').write_text(json.dumps(status, indent=2))
if __name__ == '__main__':
    main()
