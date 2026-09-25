import os, sys, pickle, json, time, statistics
from pathlib import Path
from pnr.route.detail import maze, parallel
from pnr.profile import run
from cpu_benchmark import measured
p = Path(sys.argv[1])
out = Path(sys.argv[2])
data = pickle.loads(p.read_bytes())
parallel.initialize(data['grid'])
rows = []
for enabled in [True, False, False, True]:
    os.environ['PNR_PACKED_MAZE'] = '1' if enabled else '0'
    start = time.perf_counter()
    values = [measured(j) for j in data['jobs']]
    rows.append(dict(packed=enabled, wall_s=time.perf_counter() - start, jobs=[dict(net=j[1], **v) for j, v in zip(data['jobs'], values)]))
assert all(([j['digest'] for j in r['jobs']] == [j['digest'] for j in rows[0]['jobs']] for r in rows))
(out / 'confirmation.json').write_text(json.dumps(rows, indent=2))
print(json.dumps([dict(packed=r['packed'], wall_s=r['wall_s']) for r in rows], indent=2))
os.environ['PNR_PACKED_MAZE'] = '1'
os.environ['PNR_PROFILE_DIR'] = str(out / 'profile-packed')
run('packed-fixed-proposals', lambda: [measured(j) for j in data['jobs']])
