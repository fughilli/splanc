"""Collision-aware joint placement sampling with all K occupants held out.

Probe costs use the substrate after removing pads and net copper associated with
all selected components. Exact native electrical reroutes rank sampled batches.
"""
import itertools,math,random,json,os
import numpy as np
from pnr.graph import BoardGraph
from .geometry import (resolve_fixed_poses,outline_size,keepout_rects,
                       hard_group_limits,courtyard_rect,placement_rects,pin_positions)
from .metrics import hard_violations,hpwl
from .relocate import _fields,_near
from .anneal import choose_cost


def joint_configurations(graph,constraints,options,*,samples=4,temperature=.1,rng=None,max_combinations=4096,rules=None,proxy_budget=12):
    """Evaluate Cartesian combinations jointly; include collision rejections."""
    rng=rng or random.Random(0);refs=sorted(options);count=math.prod(len(options[r]) for r in refs)
    if count<=max_combinations:indices=list(itertools.product(*(range(len(options[r])) for r in refs)))
    else:
        indices=list(dict.fromkeys(tuple(rng.randrange(len(options[r])) for r in refs) for _ in range(max_combinations)))
    # Guarantee isolated moves are present even in a huge Monte Carlo product.
    if count>max_combinations:
        base=tuple(0 for _ in refs)
        singles=[tuple(j if k==i else 0 for k in range(len(refs))) for i,r in enumerate(refs) for j in range(1,len(options[r]))]
        indices=list(dict.fromkeys([base,*singles,*indices]))
    legal=[];rejections=[]
    for choices in indices:
        g=BoardGraph.from_json(graph.to_json());cost=0.;moves=[]
        for ref,index in zip(refs,choices):
            option=options[ref][index];c=g.component(ref);old=c.pos;c.pos=tuple(option['position']);cost+=option['cost']
            if math.dist(old,c.pos)>1e-6:moves.append(dict(ref=ref,original=list(old),position=list(c.pos),distance_mm=math.dist(old,c.pos)))
        if not moves:continue
        bad=hard_violations(g,constraints)
        if any(bad.values()):rejections.append(dict(indices=choices,reason=bad));continue
        # Internal-to-batch nets had no stationary field seeds. Joint HPWL now
        # measures their new endpoints, never their stale original positions.
        cost+=.1*hpwl(g)
        legal.append(dict(indices=choices,cost=cost,moves=moves,graph=g))
    legal_count=len(legal)
    proxy_audit=None
    if rules is not None:
        from .capacity_proxy import rank_candidates
        legal,proxy_audit=rank_candidates(legal,rules,budget=proxy_budget)
    chosen=[];pool=list(legal)
    while pool and len(chosen)<samples:
        # Include one greedy joint configuration, then sample alternatives.
        scale=max(v['cost'] for v in pool)-min(v['cost'] for v in pool) if rules is not None else min(v['cost'] for v in pool)
        idx=choose_cost([v['cost'] for v in pool],0 if not chosen else temperature*max(1.,scale),rng)
        chosen.append(pool.pop(idx))
    audit=dict(combinatorial_space=count,enumerated=len(indices),legal_configurations=legal_count,rejections=rejections,
               proxy=proxy_audit,alternatives=[{k:v for k,v in a.items() if k not in ('graph','proxy')} for a in legal],sampled=[a['indices'] for a in chosen])
    return chosen,audit


def propose_batches(graph,constraints,rules,tracks,vias=(),*,k=4,n=4,samples=4,pressure=None,refs=None,rng=None,temperature=.1,pitch=.8,candidate_pitch=2.):
    rng=rng or random.Random(0);pressure=pressure or {};fixed=resolve_fixed_poses(graph,constraints)
    unsupported={v['ref'] for v in rules.get('plane_access_intents',[]) if v['kind']=='power_array'}|{v['ref'] for v in rules.get('copper_keepouts',[])}
    eligible=[c.ref for c in graph.components if c.ref not in fixed and not c.locked and c.ref not in unsupported and (refs is None or c.ref in refs)]
    # Weighted sampling without replacement chooses a batch, not independent
    # single-component route trials. All members vacate their sites together.
    selected=[]
    while eligible and len(selected)<k:
        ref=rng.choices(eligible,weights=[1+pressure.get(r,0) for r in eligible],k=1)[0];eligible.remove(ref);selected.append(ref)
    if not selected:return [],dict(reason='no_eligible_components')
    held=set(selected);affected={p.net for c in graph.components if c.ref in held for p in c.pads if p.net}
    substrate=BoardGraph.from_json(graph.to_json())
    for c in substrate.components:
        if c.ref in held:c.pads=[]
    clean_tracks=[t for t in tracks if t[0] not in affected];clean_vias=[v for v in vias if v[0] not in affected]
    stationary=[(c.ref,placement_rects(c)) for c in graph.components if c.ref not in held]
    width,height=outline_size(graph,constraints);keepouts=keepout_rects(graph,constraints,fixed);limits=hard_group_limits(constraints,fixed)
    from pnr.live import emit
    emit('batch_holdout',layout=json.loads(graph.to_json()),data=dict(held_out=selected,removed_nets=sorted(affected)))
    options={};probes=[]
    for ref in selected:
        comp=graph.component(ref);fields=_fields(substrate,comp,rules,clean_tracks,clean_vias,pitch);old=comp.pos;ranked=[]
        def legal(pos):
            c=BoardGraph.from_json(graph.to_json()).component(ref);c.pos=pos;rect=courtyard_rect(c)
            return (rect.inside(width,height) and not any(rect.overlaps(v) for v in keepouts)
                    and not any(math.dist(pos,(x,y))>radius+1e-9 for x,y,radius in limits.get(ref,()))
                    and not any(side==other_side and area.overlaps(other) for _,regions in stationary for other_side,other in regions for side,area in placement_rects(c)))
        for pos in dict.fromkeys([old,*[(float(x),float(y)) for x in np.arange(candidate_pitch/2,width,candidate_pitch) for y in np.arange(candidate_pitch/2,height,candidate_pitch)]]):
            if not legal(pos):continue
            score=0.;unreachable=0
            for pad,(_,xy) in zip(comp.pads,pin_positions(comp)):
                if pad.net not in fields:continue
                grid,blocked,dist=fields[pad.net];pt=(xy[0]+pos[0]-old[0],xy[1]+pos[1]-old[1]);side=0 if comp.side=='top' else len(grid.layers)-1
                cost=min([dist[la,j,i]+d for d,la,j,i in _near(grid,blocked,pt,side)],default=math.inf)
                if not math.isfinite(cost):cost=10000.;unreachable+=1
                score+=cost
            ranked.append(dict(position=list(pos),cost=float(score),unreachable=unreachable))
        ranked.sort(key=lambda v:v['cost']);original=next(v for v in ranked if tuple(v['position'])==old)
        if os.environ.get('PNR_CAPACITY_PROXY')=='1':
            from .capacity_proxy import diverse_options
            options[ref]=diverse_options(ranked,original,n,width,height,graph,ref)
        else:options[ref]=[original]+[v for v in ranked if v is not original][:max(0,n-1)]
        probes.append(dict(ref=ref,original=list(old),candidates=ranked,shortlist=options[ref]))
        emit('placement_costs',data=probes[-1])
    choices,audit=joint_configurations(graph,constraints,options,samples=samples,temperature=temperature,rng=rng,rules=rules if os.environ.get('PNR_CAPACITY_PROXY')=='1' else None,proxy_budget=int(os.environ.get('PNR_PROXY_BUDGET','12')))
    audit.update(model='joint-held-out-relocation-v1',held_out=selected,k=len(selected),n=n,removed_nets=sorted(affected),removed_tracks=len(tracks)-len(clean_tracks),removed_vias=len(vias)-len(clean_vias),probes=probes,temperature=temperature)
    emit('batch_alternatives',data=audit)
    return choices,audit
