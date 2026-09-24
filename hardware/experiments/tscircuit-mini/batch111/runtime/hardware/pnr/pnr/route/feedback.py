"""The place↔route feedback loop (design doc §6 — "the heart", Phase 4).

Placement quality can only be judged after routing, but routing needs a
placement. This closes that loop as a damped fixed-point iteration:

1. **Place** the board (:func:`pnr.place.place`).
2. **Lookahead global route** (:func:`pnr.route.global_route.global_route`) for
   ground-truth congestion — where copper demand exceeds capacity (*overflow*).
3. If overflow is 0 the lookahead passes; native routing still needs validation.
4. Otherwise **accumulate** each congested region's overflow into a persistent
   history map and turn it into per-component **inflation** (RePlAce cell
   inflation): a part sitting in a region that stays congested across rounds gets
   a monotonically larger spreading footprint, so the next placement round pushes
   it into lower-density space. Re-place and repeat.

The accumulation is the design's key idea (§6): feeding back a *persistent*
PathFinder-style history term — not a one-shot overflow snapshot — is what turns
an oscillating place⇄route hand-off into a convergent one. A round cap and a
no-improvement guard bound the loop either way.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph
from pnr.place import place
from pnr.place.geometry import outline_size, pad_rects, resolve_fixed_poses
from pnr.place.placer import PlacementReport

from .global_route import GlobalRouteResult, global_route


@dataclass
class FeedbackReport:
    """Outcome of the place↔route loop."""

    rounds: int
    overflow_history: List[float] = field(default_factory=list)
    converged: bool = False
    placement: Optional[PlacementReport] = None
    route: Optional[GlobalRouteResult] = None
    outline: Optional[Tuple[float, float]] = None  # (w, h) mm actually used
    detail_result: object = field(default=None, repr=False)
    connection_history: List[int] = field(default_factory=list)
    deferred_nets: List[str] = field(default_factory=list)
    best_round: int = 0
    termination: str = "round_limit"
    outline_scale: float = 1.0  # rubber-band factor applied to the target outline

    @property
    def final_overflow(self) -> float:
        return self.overflow_history[-1] if self.overflow_history else float("inf")

    @property
    def monotone_nonincreasing(self) -> bool:
        """True if overflow never rose round-to-round (the damping worked)."""
        h = self.overflow_history
        return all(h[i + 1] <= h[i] + 1e-9 for i in range(len(h) - 1))

    def summary(self) -> str:
        hist = " -> ".join(f"{o:.0f}" for o in self.overflow_history)
        estimate = ""
        if self.connection_history:
            estimate = "; estimated missing signal connections [" + " -> ".join(
                str(n) for n in self.connection_history) + "]"
        outline = ""
        if self.outline:
            outline = "; outline %.1fx%.1f mm (x%.2f)" % (
                self.outline[0],
                self.outline[1],
                self.outline_scale,
            )
        return (
            f"place<->route {self.rounds} round(s): overflow [{hist}], "
            f"converged={self.converged}; best round={self.best_round}; stop={self.termination}; deferred to native={len(self.deferred_nets)}"
            + outline + estimate
            + (f"; {self.placement.summary()}" if self.placement else "")
            + (f"; {self.route.summary()}" if self.route else "")
        )


def derive_inflation(
    graph: BoardGraph,
    accum_cell: np.ndarray,
    gcell_mm: float,
    *,
    fixed: Dict[str, Tuple[float, float]],
    alpha: float = 0.6,
    max_inflation: float = 2.5,
) -> Dict[str, float]:
    """Map accumulated per-gcell congestion to a per-component spreading factor.

    A movable component in a congested gcell (and its immediate neighbours) gets
    ``1 + alpha · normalized_congestion``, capped at ``max_inflation``. Congestion
    is normalized by the busiest gcell so the factor is scale-free. Fixed parts
    are never inflated (they cannot move). Deterministic.
    """
    nx, ny = accum_cell.shape
    peak = float(accum_cell.max())
    if peak <= 0.0:
        return {}

    def cong_at(i: int, j: int) -> float:
        # 3x3 neighbourhood max — a part just outside a hot gcell still feels it.
        i0, i1 = max(0, i - 1), min(nx, i + 2)
        j0, j1 = max(0, j - 1), min(ny, j + 2)
        return float(accum_cell[i0:i1, j0:j1].max())

    out: Dict[str, float] = {}
    for c in graph.components:
        if c.ref in fixed:
            continue
        i = min(nx - 1, max(0, int(c.pos[0] / gcell_mm)))
        j = min(ny - 1, max(0, int(c.pos[1] / gcell_mm)))
        cong = cong_at(i, j) / peak
        if cong > 0.0:
            out[c.ref] = min(max_inflation, 1.0 + alpha * cong)
    return out


def detail_congestion(
    board_route,
    graph: BoardGraph,
    width: float,
    height: float,
    gcell_mm: float,
) -> np.ndarray:
    """Prefer localized static escape failures; fall back to net bounding boxes.

    Local observations come from bounded searches on this placement's routing
    grid. They are heuristics, not proofs of native routability. Avoid marking
    an entire long bus congested when an inaccessible terminal was identified.
    """
    nx = max(1, int(np.ceil(width / gcell_mm)))
    ny = max(1, int(np.ceil(height / gcell_mm)))
    cong = np.zeros((nx, ny))
    events=getattr(board_route,'pressure_events',None)
    if events is not None:
        for event in events:
            for x,y in event['points']:
                i=min(nx-1,max(0,int(x/gcell_mm)));j=min(ny-1,max(0,int(y/gcell_mm)))
                cong[i,j]+=event['weight']
        return cong
    unrouted = set(board_route.result.unrouted) - set(getattr(board_route,"deferred_nets",()))
    if not unrouted:
        return cong
    for net, points in getattr(board_route, "failure_sites", {}).items():
        if net not in unrouted or not points:
            continue
        for x, y in set(map(tuple, points)):
            if not (0 <= x < width and 0 <= y < height):
                raise ValueError("failure site outside engine board coordinates")
            cong[min(nx - 1, int(x / gcell_mm)), min(ny - 1, int(y / gcell_mm))] += 1.0
        unrouted.remove(net)
    # Absolute pad centres per net (only pins we can place).
    pad_xy: Dict[str, List[Tuple[float, float]]] = {}
    for comp in graph.components:
        for _name, net, r in pad_rects(comp):
            if net in unrouted:
                pad_xy.setdefault(net, []).append((r.cx, r.cy))
    for net, pts in pad_xy.items():
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        i0 = min(nx - 1, max(0, int(min(xs) / gcell_mm)))
        i1 = min(nx - 1, max(0, int(max(xs) / gcell_mm)))
        j0 = min(ny - 1, max(0, int(min(ys) / gcell_mm)))
        j1 = min(ny - 1, max(0, int(max(ys) / gcell_mm)))
        cong[i0 : i1 + 1, j0 : j1 + 1] += float(len(pts))
    return cong


def local_feedback_placement(graph,constraints,rules,pressure,tried):
    """Perturb a legal checkpoint when global legalization exhausts its seeds.

    Score source-derived channel relief near observed routing pressure. Every
    candidate retains hard placement rules and source array reservations; only
    a subsequent complete detailed route decides whether it is an improvement.
    """
    import math
    from pnr.place.channels import ChannelModel
    from pnr.place.metrics import hard_violations,hpwl
    g=BoardGraph.from_json(graph.to_json());fixed=resolve_fixed_poses(g,constraints)
    model=ChannelModel(g,rules or {});options=[]
    for c in sorted(g.components,key=lambda c:(-pressure.get(c.ref,1),c.ref))[:]:
        if c.ref in fixed or c.locked or pressure.get(c.ref,1)<=1:continue
        others=[o for o in g.components if o.ref!=c.ref];old=tuple(c.pos)
        points=[(old[0]+dx*d,old[1]+dy*d) for d in (.25,.5,1.) for dx,dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1))]
        baseline=float(model.penalty(c,others,*old));costs=model.penalty(c,others,np.array([q[0] for q in points]),np.array([q[1] for q in points]))
        for point,cost in zip(points,costs):
            identity=(c.ref,round(point[0],6),round(point[1],6),c.rot)
            if identity in tried:continue
            c.pos=point
            if not any(hard_violations(g,constraints).values()):
                gain=baseline-float(cost)
                score=pressure[c.ref]*(gain+.01)-.001*math.dist(old,point)
                options.append((score,c.ref,point,identity,gain))
        c.pos=old
    if not options:return None
    score,ref,point,identity,gain=max(options,key=lambda t:(t[0],t[1],t[2]))
    tried.add(identity);c=g.component(ref);old=c.pos;c.pos=point
    width,height=outline_size(g,constraints);bad=hard_violations(g,constraints)
    report=PlacementReport(width,height,hpwl(graph),hpwl(g),**bad)
    return g,report,dict(ref=ref,original=list(old),position=list(point),predicted_channel_gain=gain)


def _place_route_loop(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    *,
    seed: int,
    iters: int,
    orient: bool,
    max_rounds: int,
    gcell_mm: float,
    track_pitch_mm: float,
    route_passes: int,
    detail_rules: Optional[dict],
    detail_pitch_mm: Optional[float],
    detail_iters: int,
    spread: float,
) -> Tuple[BoardGraph, FeedbackReport]:
    """One place↔route loop at the *current* ``constraints`` outline (the inner loop
    the rubber-band wraps). See :func:`route_and_place`."""
    width, height = outline_size(graph, constraints)
    layers = int(constraints.board.layers)
    fixed = resolve_fixed_poses(graph, constraints)

    accum: Optional[np.ndarray] = None
    inflation: Dict[str, float] = {}
    report = FeedbackReport(rounds=0, outline=(width, height))
    placed = graph
    best_placed = graph
    best_overflow = float("inf")
    best_unfinished = float("inf")
    stale = 0
    local_only=False;local_tried=set()
    import os
    elastic_mode=os.environ.get("PNR_PLACEMENT_MODE")=="elastic"
    relocate_mode=os.environ.get("PNR_PLACEMENT_MODE")=="relocate"
    previous_route=None
    from pnr.place.anneal import Plateau
    import random
    relocation_plateau=Plateau()
    relocation_rng=random.Random(seed)
    mesh_reference_scale=None

    for r in range(max_rounds):
        report.rounds = r + 1
        from pnr.place.legalize import LegalizationError
        from pathlib import Path
        import os,json,time
        started=time.monotonic()
        requested_inflation=dict(inflation)
        last_error = LegalizationError('global search exhausted') if local_only else None
        local_move=None
        placement_attempt_log=[]
        if relocate_mode and r:
            from pnr.place.relocate import propose
            if previous_route is None:
                raise ValueError('relocation requires detailed routing feedback')
            proposal=propose(placed,constraints,detail_rules or {},previous_route.tracks,
                             previous_route.vias,pressure=inflation,tried=local_tried,
                             temperature=relocation_plateau.temperature,rng=relocation_rng)
            if proposal is None:
                report.termination='relocation_candidate_pool_exhausted'
                break
            placed,prep,local_move=proposal;damping=0.;trial_seed=None;last_error=None
            print('PnR global relocation: '+json.dumps(local_move['moves']),flush=True)
        if elastic_mode and r:
            from pnr.place.elastic import deform
            # Fixed reference scale retains the magnitude of accumulated pressure.
            pressure={}
            if accum is not None:
                for c in placed.components:
                    i=min(accum.shape[0]-1,max(0,int(c.pos[0]/gcell_mm)))
                    j=min(accum.shape[1]-1,max(0,int(c.pos[1]/gcell_mm)))
                    pressure[c.ref]=float(accum[max(0,i-1):i+2,max(0,j-1):j+2].max())/(mesh_reference_scale or 1.)
            attempts={}
            proposal=deform(placed,constraints,detail_rules or {},pressure,
                           strength=min(8.,1.5**stale),diagnostics=attempts)
            if proposal is None:
                report.termination='elastic_no_legal_proposal'
                diagnostic=os.environ.get('PNR_ROUND_DIAGNOSTICS')
                if diagnostic:Path(diagnostic,'elastic-rejection.json').write_text(json.dumps(attempts,indent=2))
                break
            placed,prep,local_move=proposal;damping=0.;trial_seed=None;last_error=None
            print('PnR elastic mesh: moved %d parts, channel %.2f -> %.2f, strength %.2f' %
                  (len(local_move['moves']),local_move['channel_before'],local_move['channel_after'],local_move['strength']),flush=True)
        for trial_seed in ([] if local_only or ((elastic_mode or relocate_mode) and r) else range(seed + r, seed + r + 4)):
            for damping in ((1.,.5,.25,0.) if inflation else (1.,)):
                try:
                    placed,prep=place(graph,constraints,seed=trial_seed,iters=iters,orient=orient,
                        inflation={k:1+(v-1)*damping for k,v in inflation.items()},
                        spread=spread,channel_rules=detail_rules)
                    placement_attempt_log.append(dict(seed=trial_seed,damping=damping,legal=True))
                    last_error = None
                    break
                except LegalizationError as error:
                    last_error = error
                    placement_attempt_log.append(dict(seed=trial_seed,damping=damping,legal=False,error=str(error)))
            if last_error is None:
                break
        if last_error is not None:
            if best_overflow == float("inf"):raise last_error
            fallback=local_feedback_placement(best_placed,constraints,detail_rules,inflation,local_tried)
            if fallback is None:
                report.termination = "placement_search_exhausted"
                break
            placed,prep,local_move=fallback;damping=0.;trial_seed=None;local_only=True
            print('PnR local placement feedback: '+json.dumps(local_move),flush=True)
        diagnostic=os.environ.get('PNR_ROUND_DIAGNOSTICS')
        folder=Path(diagnostic)/('round-%02d'%(r+1)) if diagnostic else None
        if folder:
            folder.mkdir(parents=True,exist_ok=True)
            (folder/'placed.json').write_text(placed.to_json())
        print('PnR round %d: placement legal=%s, inflation factor=%s; routing started'%(r+1,prep.legal,damping),flush=True)
        if detail_rules is not None:
            # Grid connectivity guides placement; native DRC remains authoritative.
            from .detail.router import route_board

            broute = route_board(
                placed, constraints, detail_rules, pitch=detail_pitch_mm, max_iters=detail_iters
            )
            if folder and getattr(broute,'pressure_events',None) is not None:
                (folder/'pressure-events.json').write_text(json.dumps(broute.pressure_events,indent=2))
            previous_route=broute
            report.deferred_nets=sorted(broute.deferred_nets)
            n_unrouted = len(set(broute.result.unrouted)-broute.deferred_nets)
            missing = sum(max(1, broute.result.nets[n].remaining_connections)
                          for n in set(broute.result.unrouted) - broute.deferred_nets)
            report.connection_history.append(missing)
            if folder:
                (folder/'routes.json').write_text(json.dumps(dict(tracks=broute.tracks,vias=broute.vias,unrouted=broute.result.unrouted,deferred=report.deferred_nets)))
                (folder/'result.json').write_text(json.dumps(dict(signal_unrouted=n_unrouted,estimated_missing_connections=missing,deferred=report.deferred_nets,elapsed_seconds=time.monotonic()-started,inflation_damping=damping,placement_seed=trial_seed,local_feedback_move=local_move)))
            print('PnR round %d: %d signal nets unresolved, %d deferred electrical nets, %.1fs'%(r+1,n_unrouted,len(report.deferred_nets),time.monotonic()-started),flush=True)
            report.overflow_history.append(float(n_unrouted))
            report.route = None
            if folder and n_unrouted <= 0:
                from pnr.congestion_diagnostics import snapshot, write_snapshot
                write_snapshot(folder, snapshot(placed, detail_rules, label=f"Source P/R cycle {r+1}",
                    cell=detail_congestion(broute,placed,width,height,gcell_mm), pitch=gcell_mm,
                    inflation=requested_inflation,
                    applied_inflation={} if local_move else {k:1+(v-1)*damping for k,v in requested_inflation.items()},
                    metadata=dict(summary='Zero unresolved signal nets; native validation still required',
                                  deferred_nets=report.deferred_nets)))
            if n_unrouted <= 0:
                report.converged = True
                report.best_round = r + 1
                report.termination = "routing_stage_converged"
                report.placement = prep
                best_placed = placed
                report.detail_result=broute
                break
            cell = detail_congestion(broute, placed, width, height, gcell_mm)
            overflow = float(missing)
        else:
            gr = global_route(
                placed,
                width,
                height,
                gcell_mm=gcell_mm,
                layers=layers,
                track_pitch_mm=track_pitch_mm,
                max_passes=route_passes,
            )
            report.overflow_history.append(gr.overflow)
            report.route = gr
            if gr.overflow <= 0.0:
                report.converged = True
                report.best_round = r + 1
                report.termination = "routing_stage_converged"
                report.placement = prep
                best_placed = placed
                break
            cell = gr.cell_overflow
            overflow = gr.overflow

        if folder:
            from pnr.congestion_diagnostics import snapshot, write_snapshot
            applied = {} if local_move else {k:1+(v-1)*damping for k,v in requested_inflation.items()}
            diagnostic = snapshot(placed, detail_rules or {}, label=f"Source P/R cycle {r+1}",
                cell=cell, pitch=gcell_mm, inflation=requested_inflation,
                applied_inflation=applied, metadata=dict(
                    summary=f"missing signal connections {missing if detail_rules is not None else 'n/a'}; damping {damping}",
                    local_move=local_move, deferred_nets=report.deferred_nets,
                    global_spread=spread, placement_attempts=placement_attempt_log,
                    failure_sites=getattr(broute, 'failure_sites', {}) if detail_rules is not None else {},
                    accumulation_before=None if accum is None else accum.tolist()))
            write_snapshot(folder, diagnostic)

        # Accumulate this round's congestion (the persistent history term) and
        # re-derive inflation from the running total, so pressure only grows.
        if accum is None:
            accum = np.zeros_like(cell)
        if mesh_reference_scale is None:mesh_reference_scale=max(1.,float(cell.max()))
        accum = accum + cell
        inflation = derive_inflation(placed, accum, gcell_mm, fixed=fixed)

        # Track the BEST placement seen — the inflation feedback can overshoot and
        # oscillate (round N+1 worse than round N), so we must not return the last
        # round blindly; return the fewest estimated missing connections.
        unfinished = n_unrouted if detail_rules is not None else 0
        if (overflow < best_overflow - 1e-9 or
            abs(overflow-best_overflow)<=1e-9 and unfinished<best_unfinished):
            best_overflow = overflow
            best_unfinished = unfinished
            best_placed = placed
            report.best_round = r + 1
            report.placement = prep
            if detail_rules is not None:report.detail_result=broute
            stale = 0
        else:
            stale += 1
            if stale >= 2 and not local_only and not elastic_mode and not relocate_mode:
                report.termination = "two_rounds_without_improvement"
                break

        if relocate_mode:
            relocation_plateau.observe(overflow)
            if relocation_plateau.reached:
                report.termination = 'relocation_observed_plateau'
                break

    if relocate_mode and report.termination == 'round_limit':
        report.termination = 'relocation_round_budget_exhausted'
    return best_placed, report


def route_and_place(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    *,
    seed: int = 0,
    iters: int = 600,
    orient: bool = True,
    max_rounds: int = 6,
    gcell_mm: float = 2.5,
    track_pitch_mm: float = 0.4,
    route_passes: int = 8,
    detail_rules: Optional[dict] = None,
    detail_pitch_mm: Optional[float] = None,
    detail_iters: int = 10,
    auto_outline: bool = False,
    outline_grow: float = 1.15,
    outline_max_scale: float = 2.0,
    spread: float = 1.0,
) -> Tuple[BoardGraph, FeedbackReport]:
    """Run the place↔route loop to convergence (or the round cap).

    Two feedback signals are supported. The default is the fast **global lookahead**
    (coarse-gcell overflow). When ``detail_rules`` is given, the loop instead uses
    the **DRC-clean detailed router** as ground truth — it re-routes every round and
    the number of *unrouted* signals is the objective the loop drives to zero
    (:func:`detail_congestion` turns each failure into placement inflation). This is
    the honest closure: the detailed router is the thing that must succeed, so it —
    not an optimistic lookahead — steers the placement (design §6; the user's
    directive that a failed route must guide the next placement cycle).

    **Rubber-band outline** (``auto_outline``): the ``board.outline`` in the
    constraints is an approximate target, not a hard requirement — a too-small board
    is simply unroutable. When enabled, if the loop does not fully route at the
    target size, the outline is scaled up by ``outline_grow`` (both dims, aspect
    preserved) and the whole loop retried, up to ``outline_max_scale``. The smallest
    outline that fully routes wins — an automatic minimal-area board. Mutates
    ``constraints.board.width/height`` to the chosen size (so write-back frames to
    it).

    Returns the final placed :class:`BoardGraph` and a :class:`FeedbackReport`.
    Deterministic under a fixed ``seed``.
    """
    base_w, base_h = outline_size(graph, constraints)
    scale = 1.0
    placed: BoardGraph = graph
    report = FeedbackReport(rounds=0)
    while True:
        constraints.board.width = base_w * scale
        constraints.board.height = base_h * scale
        placed, report = _place_route_loop(
            graph,
            constraints,
            seed=seed,
            iters=iters,
            orient=orient,
            max_rounds=max_rounds,
            gcell_mm=gcell_mm,
            track_pitch_mm=track_pitch_mm,
            route_passes=route_passes,
            detail_rules=detail_rules,
            detail_pitch_mm=detail_pitch_mm,
            detail_iters=detail_iters,
            spread=spread,
        )
        report.outline_scale = scale
        if report.converged or not auto_outline or scale >= outline_max_scale - 1e-9:
            break
        scale = min(outline_max_scale, scale * outline_grow)
    return placed, report
