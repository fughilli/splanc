import sys, json, time, statistics, hashlib
from pathlib import Path
import numpy as np, torch
from pnr.graph import BoardGraph
from pnr.place.geometry import pin_positions
from pnr.place.batched_cost import PaddedWirelength, BucketedWirelength, endpoint_arrays, endpoint_cost_numpy, TorchEndpointCost
import pnr.place.batched_cost as kernel
torch.set_num_threads(1)
g = BoardGraph.from_json(Path(sys.argv[1]).read_text())
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
rows = []

def sync(d):
    if d == 'mps':
        torch.mps.synchronize()

def bench(name, fn, d='cpu'):
    samples = []
    cpus = []
    for i in range(8):
        sync(d)
        c = time.process_time()
        t = time.perf_counter()
        r = fn()
        sync(d)
        dt = time.perf_counter() - t
        dc = time.process_time() - c
        if i == 0:
            cold = dt
        else:
            samples.append(dt)
            cpus.append(dc)
    row = dict(name=name, cold_s=cold, median_s=statistics.median(samples), cpu_s=statistics.median(cpus), samples=samples)
    rows.append(row)
    return (r, row)
key = {}
xy = []
for c in g.components:
    for p, (_, pt) in zip(c.pads, pin_positions(c)):
        key[c.ref, p.name] = len(xy)
        xy.append(pt)
nets = [[key[p] for p in n.pins if p in key] for n in g.nets]
nets = [n for n in nets if len(n) > 1]
xy = np.asarray(xy, np.float32)

def legacy(x):
    v = x.new_zeros((x.shape[0],))
    for n in nets:
        px, py = (x[:, n, 0], x[:, n, 1])
        v = v + torch.logsumexp(px, 1) + torch.logsumexp(-px, 1) + torch.logsumexp(py, 1) + torch.logsumexp(-py, 1)
    return v
for b in [1, 8, 64]:
    data = np.tile(xy, (b, 1, 1))
    x = torch.tensor(data)
    ref, row = bench(f'legacy/{b}', lambda: legacy(x))
    ref = ref.numpy()
    for d in ['cpu', 'mps']:
        fn = PaddedWirelength(nets, device=d)
        z = torch.tensor(data, device=d)
        got, row = bench(f'batch/{d}/{b}/resident', lambda: fn(z), d)
        row['error'] = float(np.abs(got.cpu().numpy() - ref).max())
        got, row = bench(f'batch/{d}/{b}/transfer', lambda: PaddedWirelength(nets, device=d)(torch.tensor(data, device=d)).cpu().numpy(), d)
        row['error'] = float(np.abs(got - ref).max())
x = torch.tensor(xy, requires_grad=True)

def oldgrad():
    x.grad = None
    y = legacy(x[None]).sum()
    y.backward()
    return y
_, r = bench('gradient/legacy', oldgrad)
ref = x.grad.clone()
for d in ['cpu', 'mps']:
    fn = PaddedWirelength(nets, device=d)
    z = torch.tensor(xy, device=d, requires_grad=True)

    def grad():
        z.grad = None
        y = fn(z)
        y.backward()
        return y
    _, r = bench(f'gradient/{d}', grad, d)
    r['gradient_error'] = float((z.grad.cpu() - ref).abs().max())
for b in [1, 8, 64]:
    data = np.tile(xy, (b, 1, 1))
    ref = legacy(torch.tensor(data)).numpy()
    for d in ['cpu', 'mps']:
        fn = BucketedWirelength(nets, device=d)
        z = torch.tensor(data, device=d)
        got, row = bench(f'bucket/{d}/{b}/resident', lambda: fn(z), d)
        row['error'] = float(np.abs(got.cpu().numpy() - ref).max())
        got, row = bench(f'bucket/{d}/{b}/transfer', lambda: BucketedWirelength(nets, device=d)(torch.tensor(data, device=d)).cpu().numpy(), d)
        row['error'] = float(np.abs(got - ref).max())
x = torch.tensor(xy, requires_grad=True)
legacy(x[None]).sum().backward()
ref = x.grad.clone()
for d in ['cpu', 'mps']:
    fn = BucketedWirelength(nets, device=d)
    z = torch.tensor(xy, device=d, requires_grad=True)

    def grad():
        z.grad = None
        y = fn(z)
        y.backward()
        return y
    _, r = bench(f'gradient/bucket/{d}', grad, d)
    r['gradient_error'] = float((z.grad.cpu() - ref).abs().max())
comp = g.component('TP1')
terminals = {}
for other in g.components:
    for pad, (_, xy0) in zip(other.pads, pin_positions(other)):
        terminals.setdefault(pad.net, []).append((other.ref, xy0))
xs = np.arange(1, g.outline.width, 2)
ys = np.arange(1, g.outline.height, 2)
points = np.asarray([(x, y) for y in ys for x in xs], np.float64)
t = time.perf_counter()
arrays = endpoint_arrays(g, comp)
prep_seconds = time.perf_counter() - t

def endpoint_scalar(positions):
    scores = []
    for position in positions:
        dx, dy = (position[0] - comp.pos[0], position[1] - comp.pos[1])
        score = 0.0
        for pad, (_, xy0) in zip(comp.pads, pin_positions(comp)):
            peers = [q for ref, q in terminals.get(pad.net, []) if ref != comp.ref]
            if peers:
                score += min((abs(xy0[0] + dx - q[0]) + abs(xy0[1] + dy - q[1]) for q in peers))
        scores.append(score)
    return np.asarray(scores)

def endpoint_check(row, got, reference):
    got = np.asarray(got)
    order = np.argsort(got, kind='stable')
    truth = reference[order]
    row.update(max_abs_error=float(np.abs(got - reference).max()), exact_ranking_equal=bool(np.array_equal(order, np.argsort(reference, kind='stable'))), max_order_violation_mm=float(np.max(np.maximum.accumulate(truth) - truth)), selected_best_regret_mm=float(reference[np.argmin(got)] - reference.min()))
endpoint_shape = dict(ref=comp.ref, candidates=len(points), pads=len(arrays[0]), max_peers=arrays[1].shape[1], array_prepare_s=prep_seconds)
for label, positions in [('actual', points), ('stress8x', np.tile(points, (8, 1)))]:
    ref, row = bench('endpoint/python/' + label, lambda: endpoint_scalar(positions))
    got, row = bench('endpoint/numpy/' + label, lambda: endpoint_cost_numpy(positions, arrays))
    endpoint_check(row, got, ref)
    if label == 'actual':
        heatmap = dict(nx=len(xs), ny=len(ys), values=got.tolist(), minimum=float(got.min()), maximum=float(got.max()), units='mm', kind='unfiltered_nearest_peer_manhattan')
    for device in ['cpu', 'mps']:
        scorer = TorchEndpointCost(arrays, device=device)
        pos = torch.tensor(positions, dtype=torch.float32, device=device)
        got, row = bench('endpoint/' + device + '/' + label + '/resident', lambda: scorer(pos), device)
        endpoint_check(row, got.cpu().numpy(), ref)
        got, row = bench('endpoint/' + device + '/' + label + '/transfer', lambda: TorchEndpointCost(arrays, device=device)(torch.tensor(positions, dtype=torch.float32, device=device)).cpu().numpy(), device)
        endpoint_check(row, got, ref)
data = {'endpoint_shape': endpoint_shape, 'heatmap': heatmap, 'rows': rows, 'components': len(g.components), 'pins': len(xy), 'nets': len(nets), 'torch': torch.__version__, 'graph_sha256': hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest(), 'kernel_path': kernel.__file__, 'kernel_sha256': hashlib.sha256(Path(kernel.__file__).read_bytes()).hexdigest()}
(out / 'results.json').write_text(json.dumps(data, indent=2))
print(json.dumps(data, indent=2))
