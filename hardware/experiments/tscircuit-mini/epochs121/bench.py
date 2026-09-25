"""Fixed signal proposal-validation replay, NOT a PnR solution benchmark."""
import argparse, hashlib, json, shutil, time, statistics, random
from collections import Counter
from pathlib import Path
import pcbnew as k
from pnr.route_epoch import evaluate_epochs
from pnr.native_drc import run_drc
from pnr.native_electrical import Oracle, add_track
from pnr.electrical import net_policy
from pnr.via_coalesce import partition, preserved, acceptable
from pnr.pad_entry import snapshot
ap = argparse.ArgumentParser()
ap.add_argument('--board', type=Path, required=True)
ap.add_argument('--rules', type=Path, required=True)
ap.add_argument('--out', type=Path, required=True)
ap.add_argument('--cli', required=True)
ap.add_argument('--edits', type=int, default=12)
ap.add_argument('--repeats', type=int, default=3)
a = ap.parse_args()
a.board = a.board.resolve()
a.out = a.out.resolve()
a.out.mkdir(parents=True, exist_ok=False)
rules = json.loads(a.rules.read_text())
keep = []
inputs = [a.board, a.rules, a.board.with_suffix('.kicad_pro'), a.board.with_suffix('.kicad_dru'), a.board.parent / 'fp-lib-table']
hashes = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs if p.exists()}

def unchanged():
    if any((not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest() != sha for p, sha in hashes.items())):
        raise RuntimeError('frozen input changed')

def savejson(path, value):
    path.write_text(json.dumps(value, indent=2, default=str))

def sidecars(dst):
    for ext in ('.kicad_pro', '.kicad_dru'):
        src = a.board.with_suffix(ext)
        if src.exists():
            shutil.copy2(src, dst.with_suffix(ext))
    table = a.board.parent / 'fp-lib-table'
    if table.exists():
        shutil.copy2(table, dst.parent / table.name)

def signature(t):
    if t.GetClass() == 'PCB_TRACK':
        return (t.GetClass(), t.GetNetname(), t.GetLayer(), t.GetWidth(), t.GetStart().x, t.GetStart().y, t.GetEnd().x, t.GetEnd().y)
    return (t.GetClass(), t.GetNetname(), t.GetPosition().x, t.GetPosition().y, t.GetWidth(k.F_Cu), t.GetDrillValue())
source = k.LoadBoard(str(a.board))
keep.append(source)
expected = Counter((signature(t) for t in source.GetTracks()))
choices = sorted([t for t in source.GetTracks() if t.GetClass() == 'PCB_TRACK' and (not t.IsLocked()) and (net_policy(t.GetNetname(), rules)['mode'] == 'signal')], key=lambda t: t.m_Uuid.AsString())[:a.edits]
if len(choices) < 4:
    raise RuntimeError('Not enough signal proposals')
proposals = []
for t in choices:
    proposals.append(dict(net=t.GetNetname(), layer=t.GetLayer(), a=(t.GetStart().x / 1000000.0, t.GetStart().y / 1000000.0), z=(t.GetEnd().x / 1000000.0, t.GetEnd().y / 1000000.0), width=t.GetWidth() / 1000000.0, uuid=t.m_Uuid.AsString(), mode='signal'))
    source.Remove(t)
    keep.append(t)
source.BuildConnectivity()
base = a.out / 'partial.kicad_pcb'
k.SaveBoard(str(base), source)
sidecars(base)
hashes[base] = hashlib.sha256(base.read_bytes()).hexdigest()
savejson(a.out / 'proposals.json', proposals)
savejson(a.out / 'inputs.json', {str(p): v for p, v in hashes.items()})
original = run_drc(a.cli, a.board, a.out / 'source.drc.json')
if original['violations'] or original['unconnected_items']:
    raise RuntimeError('Source fixture is not native clean')
summary = []

def model(state):
    b = k.LoadBoard(str(base))
    keep.append(b)
    for i in state:
        p = proposals[i]
        t = add_track(b, p['net'], p['layer'], p['a'], p['z'], p['width'])
        t.SetUuid(k.KIID(p['uuid']))
        keep.append(t)
    b.BuildConnectivity()
    return b

def trial(label, epoch, indices, bypass_proxy=False):
    folder = a.out / label
    folder.mkdir()
    cache = {}
    oracles = {}
    gate_log = []
    proxy_seconds = 0.0

    def state_model(state):
        if state not in cache:
            unchanged()
            b = model(state)
            path = folder / ('state-%03d.kicad_pcb' % len(cache))
            filler = k.ZONE_FILLER(b)
            filler.Fill(b.Zones())
            keep.append(filler)
            k.SaveBoard(str(path), b)
            sidecars(path)
            started = time.perf_counter()
            report = run_drc(a.cli, path, path.with_suffix('.drc.json'))
            elapsed = time.perf_counter() - started
            cache[state] = (b, path, report, partition(b), snapshot(b, rules))
            gate_log.append(dict(state=state, drc_seconds=elapsed, opens=len(report['unconnected_items']), violations=len(report['violations'])))
        return cache[state]
    initial = state_model(())[0]
    oracles[()] = Oracle(initial, rules)

    def apply(state, i):
        unchanged()
        if i in state:
            raise RuntimeError('duplicate/stale proposal')
        return state + (i,)

    def proxy(state, candidate, i):
        nonlocal proxy_seconds
        started = time.perf_counter()
        p = proposals[i]
        oracle = oracles[state].fork()
        policy = net_policy(p['net'], rules)
        clean = p['mode'] == 'signal' and p['width'] >= policy['outer_width_mm'] - 1e-09 and oracle.clear(p['net'], p['layer'], p['a'], p['z'], p['width'])
        if clean or bypass_proxy:
            oracle.reserve_track(p['net'], p['layer'], p['a'], p['z'], p['width'])
            oracles[candidate] = oracle
        proxy_seconds += time.perf_counter() - started
        return bool(clean or bypass_proxy)

    def gate(before, after):
        unchanged()
        old = state_model(before)
        new = state_model(after)
        checks = dict(preserved=preserved(old[3], new[3]), lost_pad_entries=[key for key, value in old[4].items() if value and (not new[4].get(key, False))])
        return bool(acceptable(old[2], new[2], checks))

    def emit(event):
        status = dict(status='benchmarking', phase=label, updated_at=time.time(), metrics=dict(epoch_size=epoch, proposals=len(indices)), experiments=summary, viewer_url='http://mac-mini.tail6b8ad3.ts.net:8773/', latest_event=event, qualification='Fixed proposal replay; provisional until full native boundary. No new routing search.')
        savejson(a.out.parent / 'status.json', status)
        if shutil.disk_usage(a.out).free < 25 * 1024 ** 3:
            raise RuntimeError('disk reserve reached')
    started = time.perf_counter()
    result = evaluate_epochs((), indices, apply=apply, proxy=proxy, native_gate=gate, eligible=lambda i: proposals[i]['mode'] == 'signal', max_edits=epoch, emit=emit)
    final = state_model(result.state)
    elapsed = time.perf_counter() - started
    metrics = dict(label=label, epoch=epoch, elapsed_seconds=elapsed, proxy_seconds=proxy_seconds, native_calls=result.native_calls, accepted=len(result.accepted), dropped=len(result.rejected), batch_failures=sum((e['status'] == 'rollback_and_bisect' for e in result.events)), opens=len(final[2]['unconnected_items']), violations=len(final[2]['violations']), exact_source_copper=Counter((signature(t) for t in final[0].GetTracks())) == expected, gate_log=gate_log, events=result.events, final_board=str(final[1]), bypass_proxy_negative_control=bypass_proxy)
    savejson(folder / 'result.json', metrics)
    summary.append(metrics)
    savejson(a.out / 'summary.json', summary)
    print(json.dumps({k: v for k, v in metrics.items() if k not in ('events', 'gate_log')}), flush=True)
    return metrics
normal = list(range(len(proposals)))
order = [(repeat, epoch) for repeat in range(a.repeats) for epoch in (1, 4, 8)]
random.Random(121).shuffle(order)
for repeat, epoch in order:
    m = trial('repeat-%d-epoch-%d' % (repeat, epoch), epoch, normal)
    if m['opens'] or m['violations'] or (not m['exact_source_copper']):
        raise RuntimeError('Fixed-work comparison failed quality parity')
p = dict(proposals[0])
p['width'] = 0.001
p['uuid'] = k.KIID().AsString()
proposals.append(p)
bad = len(proposals) - 1
m = trial('native-negative-width', 4, normal[:3] + [bad], bypass_proxy=True)
final_report = json.loads(Path(m['final_board']).with_suffix('.drc.json').read_text())
if m['dropped'] < 1 or any((v['type'] not in ('track_dangling', 'via_dangling') for v in final_report['violations'])):
    raise RuntimeError('Native negative control failed closed')
p = dict(proposals[0])
p['width'] = 5.0
p['uuid'] = k.KIID().AsString()
proposals.append(p)
bad = len(proposals) - 1
m = trial('proxy-negative-wide', 4, normal[:3] + [bad])
if m['dropped'] < 1:
    raise RuntimeError('Clearance proxy failed to reject wide track')
m = trial('native-negative-wide', 4, normal[:3] + [bad], bypass_proxy=True)
final_report = json.loads(Path(m['final_board']).with_suffix('.drc.json').read_text())
if m['dropped'] < 1 or any((v['type'] not in ('track_dangling', 'via_dangling') for v in final_report['violations'])):
    raise RuntimeError('Native clearance boundary failed')
probe = a.out / 'stale-rules.json'
probe.write_bytes(a.rules.read_bytes())
hashes[probe] = hashlib.sha256(probe.read_bytes()).hexdigest()
original_probe = probe.read_bytes()
try:
    probe.write_text('{}')
    try:
        unchanged()
    except RuntimeError:
        savejson(a.out / 'stale-control.json', dict(rejected=True, reason='bound rules hash changed before proposal/gate'))
    else:
        raise AssertionError('changed rule hash was accepted')
finally:
    probe.write_bytes(original_probe)
unchanged()
savejson(a.out.parent / 'status.json', dict(status='complete', phase='fixed-work-replay-complete', updated_at=time.time(), metrics=dict(experiments=len(summary)), experiments=summary, viewer_url='http://mac-mini.tail6b8ad3.ts.net:8773/', note='No complete PnR A/B. Negative controls leave intentional opens; rollback is not routing repair.'))
