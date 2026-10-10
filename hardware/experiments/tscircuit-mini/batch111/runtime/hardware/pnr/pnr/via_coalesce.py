"""Reuse through-vias across layer branches, with transactional native validation.

Proximity only generates candidates. Existing surface connectivity is required;
all track/pad ports are retained at their original coordinates and connected to
one existing barrel. Source-authored arrays/returns, power-width classes, plane
nets, differential pairs, blind/micro vias and locked copper are excluded.
The coordinator never holds pcbnew wrappers while spawning native DRC/fill.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace

from pnr.pad_entry import closest, snapshot, xy
from pnr.plane_access import surface_group, uid
from pnr.plane_intent import read_annotations, resolve


def vec(p):
    import pcbnew
    return pcbnew.VECTOR2I(round(p[0] * 1e6), round(p[1] * 1e6))


def copper_layers(board):
    return list(board.GetEnabledLayers().CuStack())


def partition(board):
    import pcbnew
    cn = board.GetConnectivity()
    seen, groups = set(), []
    for f in board.GetFootprints():
        for p in f.Pads():
            if uid(p) in seen:
                continue
            group = {uid(p)} | {uid(t) for t in cn.GetConnectedItems(p)
                                if isinstance(t, pcbnew.PAD) and t.GetNetCode() == p.GetNetCode()}
            seen |= group
            groups.append(sorted(group))
    return groups


def preserved(before, after):
    new = [set(g) for g in after]
    return all(any(set(g) <= n for n in new) for g in before)


def protected(board, rules, sources):
    """Resolve semantic protection from source, never reference-specific policy."""
    minimum = rules.get('fab', {}).get('track_width_mm', 0.2)
    nets = set()
    for c in rules.get('net_classes', []):
        if c.get('plane_layer') or (c.get('width_mm') or minimum) > minimum:
            nets.update(c.get('nets', []))
    for pair in rules.get('diff_pairs', []):
        nets.update([pair['p'], pair['n']])
    for group in rules.get('length_match', []):
        nets.update(group.get('nets', []))
    cs = [SimpleNamespace(ref=f.GetReference(), address=next(
        (z.GetText() for z in f.GetFields() if z.GetName() == 'atopile_address'), ''),
        pads=[SimpleNamespace(name=p.GetNumber(), net=p.GetNetname()) for p in f.Pads()])
        for f in board.GetFootprints()]
    intents = resolve(read_annotations(sources), cs) if sources else []
    # Conservative net-wide exclusion also preserves dedicated local-return and
    # thermal-reuse contracts. A later budget-aware pass may narrow this scope.
    nets.update(i['net'] for i in intents)
    return nets, intents


def touch(a, b, la):
    return a.IsOnLayer(la) and b.IsOnLayer(la) and a.GetEffectiveShape(la).Collide(b.GetEffectiveShape(la), 0)


def candidates(board, rules, sources, radius=1.5):
    import pcbnew
    excluded, intents = protected(board, rules, sources)
    vs = [v for v in board.GetTracks() if v.GetClass() == 'PCB_VIA'
          and v.GetViaType() == pcbnew.VIATYPE_THROUGH and not v.IsLocked()
          and v.GetNetCode() and v.GetNetname() not in excluded]
    result = []
    for i, a in enumerate(vs):
        for b in vs[i + 1:]:
            distance = math.dist(xy(a.GetPosition()), xy(b.GetPosition()))
            if a.GetNetCode() != b.GetNetCode() or not 0 < distance <= radius:
                continue
            # Require existing same-layer copper connection; never create a
            # shortcut between unrelated nearby components just from distance.
            shared = any(uid(b) in {uid(t) for t in surface_group(board, [a], la)}
                         for la in copper_layers(board))
            if not shared:
                continue
            for keep, remove in ((a, b), (b, a)):
                result.append(dict(keep=uid(keep), remove=uid(remove), net=a.GetNetname(),
                                   distance_mm=distance))
    return sorted(result, key=lambda p: (p['distance_mm'], p['net'], p['keep'], p['remove'])), intents


def plan(board, keep, remove, rules):
    """Plan bridges at full branch width; leave all original branch ports fixed.

    Narrow phase and native DRC reject blocked bridges. Three octilinear paths
    are tried per layer (direct only if cardinal/45 degrees). No obstacles are
    shoved and no extra via is introduced. No claim of global optimality.
    """
    import pcbnew
    if keep.IsLocked() or remove.IsLocked() or keep.GetNetCode() != remove.GetNetCode():
        raise ValueError('locked or different-net via')
    if any(v.GetViaType() != pcbnew.VIATYPE_THROUGH for v in (keep, remove)):
        raise ValueError('unsupported via span')
    if keep.GetDrillValue() < remove.GetDrillValue() or any(keep.GetWidth(la) < remove.GetWidth(la) for la in copper_layers(board)):
        raise ValueError('survivor has smaller barrel/pad')
    tracks = list(board.GetTracks())
    pads = [p for f in board.GetFootprints() for p in f.Pads()]
    ports = {}
    for la in copper_layers(board):
        attached = [t for t in tracks + pads if uid(t) not in {uid(keep), uid(remove)}
                    and t.GetNetCode() == remove.GetNetCode() and touch(t, remove, la)]
        if attached:
            ports[la] = attached
    if len(ports) < 2:
        raise ValueError('not a multilayer track/pad transition')
    if any(t.IsLocked() or t.GetClass() not in {'PCB_TRACK', 'PAD'} for ts in ports.values() for t in ts):
        raise ValueError('locked or unsupported port')
    start, end = xy(remove.GetPosition()), xy(keep.GetPosition())
    additions, trims = [], []
    for la, attached in ports.items():
        connected = {uid(t) for t in surface_group(board, [keep], la, excluded={uid(remove)})}
        # Tail ending at the removed barrel can be shortened when the survivor
        # is exactly on its centerline. This handles mid-segment via contacts.
        for t in attached:
            if t.GetClass() != 'PCB_TRACK':
                continue
            a, b = xy(t.GetStart()), xy(t.GetEnd())
            if start not in (a, b) or math.dist(closest(end, a, b), end) > 1e-6:
                continue
            if end == (b if a == start else a):
                continue  # Keep zero-length/duplicate removal out of this pass.
            # Do not trim any pad, via or branch attachment in the discarded tail.
            guard = pcbnew.PCB_TRACK(board)
            guard.SetStart(vec(start)); guard.SetEnd(vec(end)); guard.SetLayer(la)
            guard.SetWidth(t.GetWidth()); guard.SetNetCode(t.GetNetCode())
            contacts = [x for x in tracks + pads if uid(x) not in {uid(t), uid(keep), uid(remove)}
                        and x.GetNetCode() == t.GetNetCode() and touch(x, guard, la)]
            if not contacts:
                trims.append(dict(uuid=uid(t), endpoint='start' if a == start else 'end', point=end))
        # The discarded annulus cannot be evidence for surviving connectivity.
        if all(uid(t) in connected for t in attached):
            continue
        minimum = rules.get('fab', {}).get('track_width_mm', 0.2)
        width = max([minimum] + [t.GetWidth() / 1e6 for t in attached if t.GetClass() == 'PCB_TRACK'])
        dx, dy = end[0] - start[0], end[1] - start[1]
        diagonal = min(abs(dx), abs(dy))
        sx, sy = math.copysign(1, dx), math.copysign(1, dy)
        paths = [[start, (start[0] + sx * diagonal, start[1] + sy * diagonal), end],
                 [start, (end[0] - sx * diagonal, end[1] - sy * diagonal), end]]
        if abs(dx) < 1e-6 or abs(dy) < 1e-6 or abs(abs(dx) - abs(dy)) < 1e-6:
            paths.insert(0, [start, end])
        foreign = [t for t in tracks + pads if t.GetNetCode() != keep.GetNetCode() and t.IsOnLayer(la)]
        clearance = max(rules.get('default_clearance_mm', 0.2), rules.get('fab', {}).get('clearance_mm', 0.2))
        chosen = None
        for path in paths:
            segments = []
            for a, b in zip(path, path[1:]):
                if math.dist(a, b) < 1e-6:
                    continue
                t = pcbnew.PCB_TRACK(board)
                t.SetStart(vec(a)); t.SetEnd(vec(b)); t.SetLayer(la)
                t.SetWidth(round(width * 1e6)); t.SetNetCode(keep.GetNetCode())
                if any(t.GetEffectiveShape(la).Collide(x.GetEffectiveShape(la), round(clearance * 1e6)) for x in foreign):
                    break
                zones = list(board.Zones()) + [z for f in board.GetFootprints() for z in f.Zones()]
                if any(z.GetIsRuleArea() and z.IsOnLayer(la) and z.GetDoNotAllowTracks()
                       and z.GetBoundingBox().Intersects(t.GetBoundingBox()) for z in zones):
                    break
                segments.append(dict(start=a, end=b, layer=la, width_mm=width))
            else:
                chosen = segments
                break
        if chosen is None:
            raise ValueError('blocked layer bridge: ' + board.GetLayerName(la))
        additions.extend(chosen)
    return dict(keep=uid(keep), remove=uid(remove), net=keep.GetNetname(),
                keep_position=end, remove_position=start, additions=additions, trims=trims,
                layers=[board.GetLayerName(la) for la in ports])


def apply(board, proposal):
    import pcbnew
    items = {uid(t): t for t in board.GetTracks()}
    net = items[proposal['keep']].GetNetCode()
    for edit in proposal['trims']:
        t = items[edit['uuid']]
        (t.SetStart if edit['endpoint'] == 'start' else t.SetEnd)(vec(edit['point']))
    for s in proposal['additions']:
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(vec(s['start'])); t.SetEnd(vec(s['end']))
        t.SetLayer(s['layer']); t.SetWidth(round(s['width_mm'] * 1e6)); t.SetNetCode(net)
        board.Add(t); t.thisown = False
    board.Remove(items[proposal['remove']])
    board.BuildConnectivity()


def violation_keys(drc):
    return Counter((v['type'], tuple(sorted(i['uuid'] for i in v.get('items', []))))
                   for v in drc['violations'] if v['type'] not in {'track_dangling', 'via_dangling'})


def acceptable(before, after, checks):
    old, new = (Counter(v['type'] for v in d['violations']) for d in (before, after))
    return (checks['preserved'] and not checks['lost_pad_entries']
            and len(after['unconnected_items']) <= len(before['unconnected_items'])
            and not (violation_keys(after) - violation_keys(before))
            and all(new[k] <= old[k] for k in ('track_dangling', 'via_dangling')))


def worker(args, rules):
    import pcbnew
    b = pcbnew.LoadBoard(str(args.board)); b.BuildConnectivity()
    if args.worker == 'inventory':
        pairs, intents = candidates(b, rules, args.annotation_source, args.radius)
        result = dict(pairs=pairs, protected_intents=intents)
    elif args.worker == 'cycle-inventory':
        from pnr.track_graph import cycle_candidates
        result = dict(cycles=cycle_candidates(b, rules, args.annotation_source, 2 * args.radius))
    elif args.worker == 'cycle-trial':
        from pnr.track_graph import cycle_candidates, apply_cycle
        before = dict(partition=partition(b), entries=snapshot(b, rules))
        requested = json.loads(args.transaction.read_text())
        choices = cycle_candidates(b, rules, args.annotation_source, 2 * args.radius)
        proposal = next((p for p in choices if p['remove_tracks'] == requested['remove_tracks']
                         and p['net'] == requested['net'] and p['layer'] == requested['layer']), None)
        if proposal is None:
            result = dict(skipped='cycle no longer eligible')
        else:
            removed_copper = apply_cycle(b, proposal)
            pcbnew.SaveBoard(str(args.out), b)
            result = dict(before=before, proposal=proposal)
    elif args.worker == 'trial':
        before = dict(partition=partition(b), entries=snapshot(b, rules))
        items = {uid(t): t for t in b.GetTracks()}
        try:
            excluded, _ = protected(b, rules, args.annotation_source)
            if items[args.keep].GetNetname() in excluded:
                raise ValueError('protected source/routing policy')
            proposal = plan(b, items[args.keep], items[args.remove], rules)
            apply(b, proposal)
            pcbnew.SaveBoard(str(args.out), b)
            result = dict(before=before, proposal=proposal)
        except (ValueError, KeyError) as e:
            result = dict(skipped=str(e))
    elif args.worker == 'prune':
        transaction = json.loads(args.transaction.read_text())
        net = transaction['proposal']['net']
        excluded, _ = protected(b, rules, args.annotation_source)
        removed = [];removed_vias=[]
        if net not in excluded:
            for t in list(b.GetTracks()):
                if uid(t) in args.prune and not t.IsLocked() and t.GetNetname() == net:
                    is_survivor=t.GetClass()=='PCB_VIA' and uid(t)==transaction['proposal']['keep']
                    if is_survivor:
                        others=[x for x in b.GetTracks() if uid(x)!=uid(t)]+[p for f in b.GetFootprints() for p in f.Pads()]
                        layers=[la for la in copper_layers(b) if any(x.GetNetCode()==t.GetNetCode() and touch(x,t,la) for x in others) or any(not z.GetIsRuleArea() and z.GetNetCode()==t.GetNetCode() and z.IsOnLayer(la) and z.GetFilledPolysList(la).Collide(t.GetEffectiveShape(la),0) for z in b.Zones())]
                        is_survivor=len(layers)<=1
                    if t.GetClass()=='PCB_TRACK' or is_survivor:
                        removed.append(uid(t))
                        if is_survivor:removed_vias.append(uid(t))
                        b.Remove(t)
        pcbnew.SaveBoard(str(args.board), b)
        result = dict(removed=removed,removed_vias=removed_vias)
    else:
        pcbnew.ZONE_FILLER(b).Fill(b.Zones()); b.BuildConnectivity()
        before = json.loads(args.transaction.read_text())['before']
        entries = snapshot(b, rules)
        result = dict(preserved=preserved(before['partition'], partition(b)),
                      lost_pad_entries=[k for k, v in before['entries'].items() if v and not entries.get(k, False)])
        pcbnew.SaveBoard(str(args.board), b)
    # Release borrowed track wrappers while their native board is still alive.
    # KiCad 10 can otherwise destroy the board before this local lookup at return.
    if args.worker == 'trial':
        items.clear()
    args.report.write_text(json.dumps(result, indent=2) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('board', type=Path)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--rules', required=True, type=Path)
    ap.add_argument('--annotation-source', action='append', type=Path, default=[])
    ap.add_argument('--report', required=True, type=Path)
    ap.add_argument('--work-dir', type=Path)
    ap.add_argument('--kicad-cli', default='kicad-cli')
    ap.add_argument('--radius', type=float, default=1.5)
    ap.add_argument('--max-trials', type=int, default=64)
    ap.add_argument('--worker', choices=['inventory', 'trial', 'check', 'prune', 'cycle-inventory', 'cycle-trial'])
    ap.add_argument('--keep'); ap.add_argument('--remove')
    ap.add_argument('--transaction', type=Path)
    ap.add_argument('--prune', action='append', default=[])
    args = ap.parse_args()
    if not math.isfinite(args.radius) or args.radius <= 0 or args.max_trials < 1:
        ap.error('positive finite radius and trial limit required')
    rules = json.loads(args.rules.read_text())
    if args.worker:
        worker(args, rules)
        return
    if not args.out:
        ap.error('--out required')
    work = args.work_dir or Path(tempfile.mkdtemp(prefix='via-coalesce-'))
    work.mkdir(parents=True, exist_ok=True)
    current = work / 'baseline.kicad_pcb'
    shutil.copyfile(args.board, current)
    shutil.copyfile(args.board.with_suffix('.kicad_pro'), current.with_suffix('.kicad_pro'))
    if (args.board.parent / 'fp-lib-table').exists():
        (work / 'fp-lib-table').write_text((args.board.parent / 'fp-lib-table').read_text().replace('${KIPRJMOD}', str(args.board.parent.resolve())))
    common = ['--rules', str(args.rules), '--radius', str(args.radius)]
    for source in args.annotation_source:
        common += ['--annotation-source', str(source)]
    def run_worker(mode, board, report, extra=()):
        subprocess.run([sys.executable, '-m', 'pnr.via_coalesce', str(board), '--worker', mode,
                        '--report', str(report)] + common + list(extra), check=True)
        return json.loads(report.read_text())
    def drc(board):
        report = board.with_suffix('.drc.json')
        from pnr.native_drc import run_drc
        return run_drc(args.kicad_cli,board,report)
    initial_sha = hashlib.sha256(args.board.read_bytes()).hexdigest()
    before = drc(current)
    initial = before
    inventory = run_worker('inventory', current, work / 'inventory.json')
    events, removed = [], set()
    queue = list(inventory['pairs'])
    while queue and len(events) < args.max_trials:
        pair = queue.pop(0)
        if pair['keep'] in removed or pair['remove'] in removed:
            continue
        trial = work / ('trial-%03d.kicad_pcb' % len(events))
        edit_path = trial.with_suffix('.edit.json')
        edit = run_worker('trial', current, edit_path,
                          ['--out', str(trial), '--keep', pair['keep'], '--remove', pair['remove']])
        event = dict(pair, accepted=False, **edit)
        if not edit.get('skipped'):
            shutil.copyfile(current.with_suffix('.kicad_pro'), trial.with_suffix('.kicad_pro'))
            checks = run_worker('check', trial, trial.with_suffix('.checks.json'), ['--transaction', str(edit_path)])
            after = drc(trial)
            old_dangling = {i['uuid'] for v in before['violations'] if v['type'] == 'track_dangling' for i in v['items']}
            pruned = [];pruned_vias=[]
            old_via_dangling={i['uuid'] for v in before['violations'] if v['type']=='via_dangling' for i in v['items']}
            # Only newly dangling unlocked straight tails on the edited signal.
            # Each prune is reloaded/refilled; original pad/entry partition stays
            # the acceptance baseline, so deleting a required branch cannot pass.
            for prune_round in range(6):
                dead = {i['uuid'] for v in after['violations'] if v['type'] == 'track_dangling' for i in v['items']} - old_dangling
                dead_vias={i['uuid'] for v in after['violations'] if v['type']=='via_dangling' for i in v['items']}-old_via_dangling
                dead|=dead_vias & {pair['keep']}
                if not dead:
                    break
                extra = ['--transaction', str(edit_path)]
                for identity in sorted(dead):
                    extra += ['--prune', identity]
                pruning = run_worker('prune', trial, trial.with_suffix('.prune.json'), extra)
                if not pruning['removed']:
                    break
                pruned_vias+=pruning.get('removed_vias',[])
                pruned += [i for i in pruning['removed'] if i not in pruning.get('removed_vias',[])]
                checks = run_worker('check', trial, trial.with_suffix('.checks.json'), ['--transaction', str(edit_path)])
                after = drc(trial)
            event.update(checks=checks, pruned_tracks=pruned, pruned_vias=pruned_vias, opens=len(after['unconnected_items']),
                         violations=dict(Counter(v['type'] for v in after['violations'])),
                         accepted=bool(acceptable(before, after, checks)))
            if event['accepted']:
                current, before = trial, after
                removed.add(pair['remove']);removed.update(pruned_vias)
                # Recompute after every accepted transaction: the surviving via
                # now exposes extra layer ports and may be reusable again.
                refreshed = run_worker('inventory', current, work / ('inventory-%03d.json' % len(events)))
                queue = list(refreshed['pairs'])
        events.append(event)
        print(json.dumps({k: event[k] for k in ('net', 'keep', 'remove', 'accepted')} | {'skipped': edit.get('skipped')}), flush=True)
    # Always simplify after coalescence, including boards already coalesced by
    # an earlier run. Each graph proposal is a separate rollback-able transaction.
    cycle_events = []
    cycle_queue = run_worker('cycle-inventory', current, work / 'cycles.json')['cycles']
    while cycle_queue and len(events) + len(cycle_events) < args.max_trials:
        proposal = cycle_queue.pop(0)
        trial = work / ('cycle-%03d.kicad_pcb' % len(cycle_events))
        spec = trial.with_suffix('.proposal.json')
        spec.write_text(json.dumps(proposal))
        edit_path = trial.with_suffix('.edit.json')
        edit = run_worker('cycle-trial', current, edit_path,
                          ['--out', str(trial), '--transaction', str(spec)])
        event = dict(proposal, accepted=False)
        if edit.get('skipped'):
            event['skipped'] = edit['skipped']
        else:
            shutil.copyfile(current.with_suffix('.kicad_pro'), trial.with_suffix('.kicad_pro'))
            checks = run_worker('check', trial, trial.with_suffix('.checks.json'), ['--transaction', str(edit_path)])
            after = drc(trial)
            event.update(checks=checks, opens=len(after['unconnected_items']),
                         violations=dict(Counter(v['type'] for v in after['violations'])),
                         accepted=bool(acceptable(before, after, checks)))
            if event['accepted']:
                current, before = trial, after
                cycle_queue = run_worker('cycle-inventory', current,
                                         work / ('cycles-%03d.json' % len(cycle_events)))['cycles']
        cycle_events.append(event)
        print(json.dumps(event), flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ('.kicad_pcb', '.kicad_pro', '.drc.json'):
        shutil.copyfile(current.with_suffix(suffix), args.out.with_suffix(suffix))
    if (work / 'fp-lib-table').exists() and args.out.parent.resolve() != work.resolve():
        shutil.copyfile(work / 'fp-lib-table', args.out.parent / 'fp-lib-table')
    result = dict(source_sha256=initial_sha, output_sha256=hashlib.sha256(args.out.read_bytes()).hexdigest(),
                  removed_vias=len(removed), before_opens=len(initial['unconnected_items']),
                  after_opens=len(before['unconnected_items']), events=events,
                  cycle_events=cycle_events, removed_cycle_tracks=sum(len(e['remove_tracks']) for e in cycle_events if e['accepted']),
                  candidates=len(inventory['pairs']), trial_limit=args.max_trials,
                  protected_intents=inventory['protected_intents'])
    # Release borrowed track wrappers while their native board is still alive.
    # KiCad 10 can otherwise destroy the board before this local lookup at return.
    if args.worker == 'trial':
        items.clear()
    args.report.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
