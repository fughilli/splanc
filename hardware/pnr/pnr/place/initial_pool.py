"""Bounded global initial-placement exploration before the first P/R round.

The old feedback loop stops at its first legal global seed. This opt-in pool
keeps that baseline, an existing legal source pose when present, and explicit
board-wide stratified/Latin-hypercube starts. Legal candidates are screened by
width-aware demand and multilayer capacity, with pose diversity retained before
an equal-budget detailed-routing comparison. Native/electrical validation remains
downstream: this module chooses a starting placement, never a finished PCB.
"""
from __future__ import annotations

import copy
import json
import math
import os
import random
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from pnr.constraints import Constraint, Enforcement
from pnr.graph import BoardGraph, BoardOutline
from .geometry import (outline_size, resolve_fixed_poses, set_component_side, apply_hard_sides,
                       placement_rects, courtyard_rect, keepout_rects, hard_group_limits)
from .legalize import LegalizationError
from .metrics import hard_violations, hpwl
from .placer import PlacementReport, place


@dataclass(frozen=True)
class InitialPoolConfig:
    starts: int = 8
    route_finalists: int = 3
    proxy_budget: int = 8
    proxy_pitch_mm: float = 2.0
    proxy_passes: int = 2

    def __post_init__(self):
        if not 2 <= self.starts <= 128:
            raise ValueError("initial pool starts must be between 2 and128")
        if not 1 <= self.route_finalists <= min(self.starts, 16):
            raise ValueError("initial route finalists must be between1 and min(starts,16)")
        if not self.route_finalists <= self.proxy_budget <= self.starts:
            raise ValueError("initial proxy budget must cover finalists and not exceed starts")
        if not math.isfinite(self.proxy_pitch_mm) or self.proxy_pitch_mm <= 0 or not 1 <= self.proxy_passes <= 12:
            raise ValueError("invalid initial pool proxy resolution/pass count")

    @classmethod
    def from_environment(cls):
        if os.environ.get("PNR_INITIAL_POOL", "0") != "1":
            return None
        starts = int(os.environ.get("PNR_INITIAL_STARTS", "8"))
        finalists = int(os.environ.get("PNR_INITIAL_FINALISTS", str(min(3, starts))))
        return cls(starts=starts, route_finalists=finalists,
                   proxy_budget=int(os.environ.get("PNR_INITIAL_PROXY_BUDGET", str(starts))),
                   proxy_pitch_mm=float(os.environ.get("PNR_INITIAL_PROXY_PITCH", "2")),
                   proxy_passes=int(os.environ.get("PNR_INITIAL_PROXY_PASSES", "2")))


def preserve_source_locks(graph, constraints):
    """Copy constraints and make native source locks explicit to global placement.

    Explicit authored fixed poses already take precedence. A locked part without
    one retains its source XY/rotation/side. This local addition survives later
    rounds of the same enabled feedback loop, not only initial-pool generation.
    """
    result = copy.deepcopy(constraints)
    fixed = set(result.locked_refs)
    for comp in graph.components:
        if comp.locked and comp.ref not in fixed:
            result.constraints.append(Constraint("fixed", Enforcement.HARD, (comp.ref,),
                {"at": list(comp.pos), "rot": comp.rot, "side": comp.side}))
    return result


def _prepared_source(graph, constraints, rules=None):
    source = BoardGraph.from_json(graph.to_json())
    apply_hard_sides(source, constraints)
    if rules and rules.get("plane_access_intents"):
        from pnr.plane_intent import reserve_array_space
        reserve_array_space(source, rules["plane_access_intents"], rules["plane_access_fab"],
                            rules.get("fab", {}).get("edge_clearance_mm", .2))
    width, height = outline_size(source, constraints)
    source.outline = BoardOutline(width, height)
    return source



def _opposite_body_basins(graph, constraints):
    """Qualified starting basins beneath a large body on the other copper side.

    This is a generic placement proposal, not permission to enter RF keepouts or
    ignore plated-hole occupancy. Hold the selected pose during one global solve
    so the wirelength gradient cannot immediately erase this alternative. Other
    parts are still globally re-optimized; the temporary pose never becomes an
    authored rule and final candidates are checked against the original rules.
    """
    poses=resolve_fixed_poses(graph,constraints)
    width,height=outline_size(graph,constraints)
    fixed_graph=copy.deepcopy(graph)
    for con in constraints.constraints:
        if con.kind=='fixed':
            for ref in con.refs:
                comp=fixed_graph.component(ref);comp.pos=poses[ref]
                comp.rot=con.params.get('rot') or 0.
    fixed_components=[c for c in fixed_graph.components if c.ref in poses]
    keepouts=keepout_rects(fixed_graph,constraints,poses)
    groups=hard_group_limits(constraints,poses)
    clearance=constraints.board.default_clearance_mm
    basins=[]
    for moving in sorted(graph.components,key=lambda c:(-len(c.pads),c.ref)):
        if moving.ref in poses or moving.locked or len(moving.pads)<4:
            continue
        for host in sorted(fixed_components,key=lambda c:(-c.courtyard[0]*c.courtyard[1],c.ref)):
            if host.side==moving.side or host.courtyard[0]*host.courtyard[1] < moving.courtyard[0]*moving.courtyard[1]*1.2:
                continue
            hr=courtyard_rect(host)
            for offset in (0.,-.25,.25):
                trial=copy.deepcopy(moving)
                trial.pos=(round(host.pos[0]*4)/4,round((host.pos[1]+offset*hr.h)*4)/4)
                rect=courtyard_rect(trial)
                if not rect.inside(width,height):continue
                if any(rect.overlaps(k,gap=clearance) for k in keepouts):continue
                if any(math.dist(trial.pos,(x,y))>radius+1e-9 for x,y,radius in groups.get(trial.ref,())):continue
                if any(sa==sb and ra.overlaps(rb,gap=clearance)
                       for sa,ra in placement_rects(trial) for comp in fixed_components
                       for sb,rb in placement_rects(comp)):continue
                basins.append(dict(ref=moving.ref,at=list(trial.pos),rot=trial.rot,
                                   side=trial.side,host=host.ref))
    return basins


def initial_starts(graph, constraints, config, seed=0, orient=True):
    """Return explicit independent global starts; no perturbation of a last route.

    Baseline preserves the previous global initialization exactly. Subsequent
    arrangements cover board-wide strata or independent Latin-hypercube axes;
    sampled cardinal rotations alter pin-facing topology as well as centres.
    Hard-fixed centres/rotations are left for the existing constraint resolver.
    """
    width, height = outline_size(graph, constraints)
    fixed = set(resolve_fixed_poses(graph, constraints)) | {c.ref for c in graph.components if c.locked}
    movable = sorted((c for c in graph.components if c.ref not in fixed), key=lambda c: c.ref)
    result = [dict(id="start-00", kind="legacy-global", seed=seed, positions=None, rotations=None)]
    result.append(dict(id="start-01", kind="source-start", seed=seed+104729,
        positions={c.ref: list(c.pos) for c in movable},
        rotations={c.ref: c.rot for c in movable} if orient else None))
    count = len(movable)
    for index in range(2, config.starts):
        this_seed = seed + 104729 * index
        rng = random.Random(this_seed)
        if index % 2 == 0:
            columns = max(1, math.ceil(math.sqrt(max(1, count) * width / height)))
            rows = max(1, math.ceil(max(1, count) / columns))
            cells = [(x, y) for y in range(rows) for x in range(columns)]
            rng.shuffle(cells)
            normalized = [((x+.2+.6*rng.random())/columns,
                           (y+.2+.6*rng.random())/rows) for x, y in cells[:count]]
            kind = "stratified-global"
        else:
            x_order = list(range(count)); y_order = list(range(count))
            rng.shuffle(x_order); rng.shuffle(y_order)
            normalized = [((x+.2+.6*rng.random())/max(1,count),
                           (y+.2+.6*rng.random())/max(1,count)) for x,y in zip(x_order,y_order)]
            kind = "latin-global"
        positions = {}; rotations = {}
        for comp, (u, v) in zip(movable, normalized):
            half_x = min(width/2, comp.courtyard[0]/2)
            half_y = min(height/2, comp.courtyard[1]/2)
            positions[comp.ref] = [half_x+u*(width-2*half_x), half_y+v*(height-2*half_y)]
            if orient:
                rotations[comp.ref] = 90 * rng.randrange(4)
        result.append(dict(id="start-%02d" % index, kind=kind, seed=this_seed,
                           positions=positions, rotations=rotations if orient else None))
    # Reserve at most two of the bounded starts for otherwise easily-erased
    # under-body basins. This adds topology diversity, not more route budget.
    for start,basin in zip(result[2:4],_opposite_body_basins(graph,constraints)):
        start['kind']='opposite-body-global'
        start['basin_anchors']=[basin]
        start['positions'][basin['ref']]=basin['at']
        if start['rotations'] is not None:start['rotations'][basin['ref']]=basin['rot']
    return result


def _pose(graph):
    return {c.ref: [*c.pos, c.rot, c.side] for c in sorted(graph.components,key=lambda c:c.ref)}


def pose_distance(a, b, refs=None):
    """RMS board-normalized displacement plus a small orientation/side term."""
    width, height = a.outline.width, a.outline.height
    items = refs if refs is not None else sorted(a.refs)
    if not items:
        return 0.0
    terms = []
    for ref in items:
        ca, cb = a.component(ref), b.component(ref)
        angle = abs((ca.rot-cb.rot+180)%360-180)/180
        terms.append(((ca.pos[0]-cb.pos[0])/width)**2 +
                     ((ca.pos[1]-cb.pos[1])/height)**2 + .04*angle**2 + .25*(ca.side!=cb.side))
    return math.sqrt(sum(terms)/len(terms))


def diverse_shortlist(candidates, count, cost_key, mandatory=(), refs=None):
    """Keep baseline, the best screen score and geographically different poses."""
    by_id = {c['id']: c for c in candidates}
    chosen = [by_id[i] for i in mandatory if i in by_id][:count]
    ordered = sorted(candidates, key=lambda c: (c[cost_key], c['id']))
    if not chosen and ordered:
        chosen.append(ordered[0])
    if len(chosen) < count:
        best = next((c for c in ordered if c not in chosen), None)
        if best is not None:
            chosen.append(best)
    rank = {c['id']: i for i,c in enumerate(ordered)}
    while len(chosen) < min(count, len(candidates)):
        remaining = [c for c in ordered if c not in chosen]
        best = max(remaining, key=lambda c:
            (min(pose_distance(c['graph'], p['graph'], refs) for p in chosen) /
             (1 + .25*rank[c['id']]/max(1,len(ordered)-1)), -rank[c['id']]))
        chosen.append(best)
    return chosen


def _hard_and_source_errors(candidate, source, constraints):
    errors = {k:v for k,v in hard_violations(candidate, constraints).items() if v}
    before = {c.ref:c for c in source.components}
    changed = []
    if set(candidate.refs) != set(source.refs):
        changed.append("component_set")
    if [asdict(n) for n in candidate.nets] != [asdict(n) for n in source.nets]:
        changed.append("netlist")
    for comp in candidate.components:
        original = before.get(comp.ref)
        if original is None:
            continue
        if ([asdict(p) for p in comp.pads] != [asdict(p) for p in original.pads] or
            comp.side != original.side or comp.footprint != original.footprint):
            changed.append(comp.ref)
    if changed:
        errors['source_geometry_changed'] = changed
    for con in constraints.constraints:
        if con.kind != 'fixed':
            continue
        for ref in con.refs:
            comp = candidate.component(ref)
            if con.params.get('rot') is not None and abs((comp.rot-float(con.params['rot'])+180)%360-180)>1e-5:
                errors.setdefault('fixed_rotation_changed', []).append(ref)
            if con.params.get('side') and comp.side != con.params['side']:
                errors.setdefault('fixed_side_changed', []).append(ref)
    return errors


def _route_metrics(board):
    unresolved = set(board.result.unrouted)-set(board.deferred_nets)
    missing = sum(max(1, board.result.nets[n].remaining_connections) for n in unresolved)
    length = sum(math.dist(a,b) for _,_,a,b,_ in board.tracks)
    # These are screening metrics, not DRC/electrical qualification. Deferred
    # modes remain explicitly listed and all finalists receive the same budget.
    return dict(missing_connections=missing, unresolved_nets=sorted(unresolved),
                deferred_nets=sorted(board.deferred_nets), vias=len(board.vias),
                copper_length_mm=length,
                objective=[missing, len(unresolved), len(board.vias), length])


def select_initial_placement(graph, constraints, rules, *, config=None, seed=0,
                             iters=600, orient=True, spread=1., pitch=None,
                             route_iters=10, output=None, proxy_only=False):
    """Return selected graph, placement report, cached route and diagnostics.

    ``proxy_only`` skips detailed routing entirely. The returned pose is only a
    screen recommendation; the report has selected=None and no accepted routing
    result. This mode is for initial-placement diagnostics, not PCB acceptance.
    """
    from .capacity_proxy import cheap_score, score
    from pnr.route.detail.router import route_board
    config = config or InitialPoolConfig()
    constraints = preserve_source_locks(graph, constraints)
    source = _prepared_source(graph, constraints, rules)
    fixed = set(resolve_fixed_poses(source, constraints))
    movable_refs = [c.ref for c in source.components if c.ref not in fixed]
    root = Path(output) if output else None
    if root:
        root.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = dict(schema='initial-placement-pool-v1', config=asdict(config), seed=seed,
                  mode='bounded_initial_exploration', plateau_observed=False,
                  selected=None, candidates=[], route_finalists=[],
                  qualification='Placement/detail screening only; native all-net electrical acceptance remains required.')
    legal = []; seen = {}
    for start in initial_starts(source, constraints, config, seed, orient):
        record = dict(start, status='started')
        report['candidates'].append(record)
        folder = root/start['id'] if root else None
        if folder:
            folder.mkdir(exist_ok=True)
            (folder/'start.json').write_text(json.dumps(start, indent=2))
        t = time.monotonic()
        try:
            source_errors = _hard_and_source_errors(source, source, constraints)
            if start['kind'] == 'source-start' and not source_errors:
                # Retain an existing legal incumbent exactly, including its chosen
                # rotations. The optimizer would otherwise erase this baseline.
                placed = BoardGraph.from_json(source.to_json())
                prep = PlacementReport(placed.outline.width, placed.outline.height,
                                       hpwl(source), hpwl(placed))
                record['kind'] = 'source-incumbent'
            else:
                placement_constraints=constraints
                if start.get('basin_anchors'):
                    placement_constraints=copy.deepcopy(constraints)
                    for anchor in start['basin_anchors']:
                        placement_constraints.constraints.append(Constraint('fixed',Enforcement.HARD,
                            (anchor['ref'],),{key:anchor[key] for key in ('at','rot','side')}))
                try:
                    placed, prep = place(source, placement_constraints, seed=start['seed'], iters=iters,
                        orient=orient, spread=spread, channel_rules=rules,
                        initial_positions=start['positions'], initial_rotations=start['rotations'])
                except LegalizationError as error:
                    if not start.get('basin_anchors') or not legal:
                        raise
                    # A difficult unrelated hard group must not erase a valid
                    # opposite-side alternative. Reuse the first already-legal
                    # global arrangement and legalize the new large-scale basin.
                    # This extra bounded attempt is reported, not called a new
                    # independent optimized global placement.
                    from .legalize import legalize
                    from .channels import ChannelModel
                    seed_graph=copy.deepcopy(legal[0]['graph'])
                    poses=resolve_fixed_poses(seed_graph,placement_constraints)
                    for anchor in start['basin_anchors']:
                        comp=seed_graph.component(anchor['ref'])
                        comp.pos=anchor['at'];comp.rot=anchor['rot']
                    record.update(global_legalization_failure=str(error),
                                  basin_fallback_from=legal[0]['id'],
                                  method='global_start_then_legal_incumbent_basin')
                    placed=legalize(seed_graph,source.outline.width,source.outline.height,
                        fixed=poses,keepouts=keepout_rects(seed_graph,placement_constraints,poses),
                        group_limits=hard_group_limits(placement_constraints,poses),
                        clearance=placement_constraints.board.default_clearance_mm,grid_mm=.25,
                        allow_rotation=orient,channel_model=ChannelModel(seed_graph,rules),
                        spread=min(spread,1.3))
                    prep=PlacementReport(placed.outline.width,placed.outline.height,
                        hpwl(source),hpwl(placed),**hard_violations(placed,constraints))
            errors = _hard_and_source_errors(placed, source, constraints)
            if errors or not prep.legal:
                record.update(status='rejected_hard_constraints', errors=errors)
                continue
            identity = json.dumps(_pose(placed), sort_keys=True)
            record.update(placement_seconds=time.monotonic()-t, poses=_pose(placed),
                          hpwl_mm=hpwl(placed), cheap_score=cheap_score(placed,rules))
            if identity in seen:
                record.update(status='duplicate', duplicate_of=seen[identity])
                continue
            seen[identity] = start['id']
            record['status'] = 'legal'
            entry = dict(id=start['id'], graph=placed, prep=prep, record=record,
                         cheap_score=record['cheap_score'])
            legal.append(entry)
            if folder:
                (folder/'placed.json').write_text(placed.to_json())
            print('Initial placement %s: %s, legal, cheap demand %.3f' %
                  (start['id'],record['kind'],record['cheap_score']),flush=True)
        except LegalizationError as error:
            record.update(status='legalization_failed', error=str(error),
                          placement_seconds=time.monotonic()-t)
        finally:
            if folder:
                (folder/'placement-result.json').write_text(json.dumps(record,indent=2))
    if not legal:
        report.update(termination='no_legal_initial_placement', elapsed_seconds=time.monotonic()-started)
        if root:
            (root/'report.json').write_text(json.dumps(report,indent=2))
        raise LegalizationError('Initial placement pool exhausted without a legal candidate')
    # Always keep the conventional initial result if legal; if it fails, retain
    # the first legal source/global result as the reference candidate.
    baseline = next((c for c in legal if c['id']=='start-00'), legal[0])
    incumbent = next((c for c in legal if c['record']['kind']=='source-incumbent'), None)
    mandatory = [baseline['id']]
    if incumbent and incumbent['id'] not in mandatory and config.route_finalists>1:
        mandatory.append(incumbent['id'])
    proxy_candidates = diverse_shortlist(legal, config.proxy_budget, 'cheap_score',
                                         mandatory=mandatory, refs=movable_refs)
    for candidate in proxy_candidates:
        record = candidate['record']
        try:
            proxy = score(candidate['graph'], rules, pitch=config.proxy_pitch_mm,
                          passes=config.proxy_passes)
            candidate['proxy_score'] = proxy['score']
            record['proxy'] = {k:v for k,v in proxy.items() if k not in ('heatmap','rounds')}
            if root:
                (root/candidate['id']/'capacity-proxy.json').write_text(json.dumps(proxy,indent=2))
        except ValueError as error:
            # Unsupported proxy geometry may not exclude a legal native design.
            # The missing proxy is explicit; equal-budget routing still decides.
            candidate['proxy_score'] = float('inf')
            record['proxy_error'] = str(error)
        record['proxy_evaluated'] = True
    finalists = diverse_shortlist(proxy_candidates, config.route_finalists, 'proxy_score',
                                   mandatory=mandatory, refs=movable_refs)
    report.update(baseline=baseline['id'], legal_count=len(legal),
                  unique_placement_count=len(seen), proxy_evaluations=len(proxy_candidates),
                  detailed_evaluations=0, fixed_refs=sorted(fixed),
                  movable_refs=sorted(movable_refs),
                  shortlisted_finalists=[c['id'] for c in finalists],
                  placement_optimizer_iterations_per_start=iters,
                  minimum_finalist_pose_distance=min((pose_distance(a['graph'],b['graph'],movable_refs)
                      for i,a in enumerate(finalists) for b in finalists[i+1:]),default=0.),
                  maximum_pose_distance=max((pose_distance(a['graph'],b['graph'],movable_refs)
                      for i,a in enumerate(legal) for b in legal[i+1:]),default=0.))
    if proxy_only:
        recommendation = min(proxy_candidates, key=lambda c:(c['proxy_score'],c['id']))
        report.update(mode='initial_placement_proxy_only',
                      recommendation=recommendation['id'],
                      termination='proxy_only_budget_completed',
                      elapsed_seconds=time.monotonic()-started,
                      qualification='Proxy-only recommendation; no detailed routing or native electrical acceptance performed.')
        if root:
            (root/'report.json').write_text(json.dumps(report,indent=2))
        return recommendation['graph'], recommendation['prep'], None, report
    evaluated = []
    for candidate in finalists:
        name = candidate['id']; record = candidate['record']
        print('Initial placement %s: detailed route finalist (%d/%d)' %
              (name,len(evaluated)+1,len(finalists)),flush=True)
        t = time.monotonic()
        # Each complete placement has a separate live lane; route workers inherit it.
        # Restore the caller's lane even if a finalist fails.
        from pnr.live import emit
        previous_lane = os.environ.get('PNR_LIVE_CANDIDATE')
        os.environ['PNR_LIVE_CANDIDATE'] = (previous_lane or 'source') + '/initial-' + name
        try:
            emit('candidate_start', layout=json.loads(candidate['graph'].to_json()),
                 data=dict(phase='initial-placement signals', provisional=True,
                           finalist=name, proxy=record.get('proxy'), budget=dict(pitch_mm=pitch,max_iters=route_iters)))
            route = route_board(candidate['graph'], constraints, rules, pitch=pitch, max_iters=route_iters)
            emit('candidate_complete', data=dict(phase='initial-placement screening complete',
                 provisional=True, **_route_metrics(route)))
        finally:
            if previous_lane is None:
                os.environ.pop('PNR_LIVE_CANDIDATE', None)
            else:
                os.environ['PNR_LIVE_CANDIDATE'] = previous_lane
        metrics = _route_metrics(route)
        record.update(status='routed_finalist', routing=metrics,
                      routing_seconds=time.monotonic()-t,
                      routing_budget=dict(pitch_mm=pitch,max_iters=route_iters))
        candidate['route'] = route; candidate['metrics'] = metrics
        evaluated.append(candidate); report['route_finalists'].append(name)
        if root:
            (root/name/'routes.json').write_text(json.dumps(dict(tracks=route.tracks,vias=route.vias,
                unrouted=route.result.unrouted,deferred=sorted(route.deferred_nets)),indent=2))
            (root/name/'routing-result.json').write_text(json.dumps(dict(**metrics,
                escape_diagnostics=route.escape_diagnostics,seconds=record['routing_seconds'],
                budget=record['routing_budget']),indent=2))
    chosen = min(evaluated, key=lambda c:(c['metrics']['objective'], c['id']))
    report.update(selected=chosen['id'], detailed_evaluations=len(evaluated),
                  termination='initial_pool_budget_completed', elapsed_seconds=time.monotonic()-started)
    if root:
        (root/'report.json').write_text(json.dumps(report,indent=2))
    return chosen['graph'], chosen['prep'], chosen['route'], report
