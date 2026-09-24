"""Board-wide translation proposals with a layered route-cost surrogate.

This is candidate ranking, not a clearance/connectivity certificate. The source
loop reroutes a proposal and retains its best completed routing round. No hard
pose, side, orientation, group or keepout is relaxed by this module.
"""
import heapq
import math
import numpy as np
from pnr.graph import BoardGraph
from .geometry import pin_positions, resolve_fixed_poses, outline_size
from .metrics import translation_checker, hard_violations, hpwl


def distance_field(blocked, via_clear, crossing, seeds, pitch, via_cost=3., crossing_cost=100.):
    """3D Dijkstra: 1 cost/mm, 3 mm/via, 100 additional cost/mm copper conflict.

    Foreign tracks may be crossed *only as an expensive rip-up estimate*.
    Static pad/keepout obstacles remain impassable. Through-vias require a clear
    aperture across every copper layer; planes can have antipads but not tracks.
    """
    layers,ny,nx=blocked.shape
    dist=np.full(blocked.shape,np.inf);queue=[]
    for la,j,i in seeds:
        if 0<=la<layers and 0<=j<ny and 0<=i<nx and not blocked[la,j,i]:
            dist[la,j,i]=0.;heapq.heappush(queue,(0.,la,j,i))
    while queue:
        cost,la,j,i=heapq.heappop(queue)
        if cost!=dist[la,j,i]:continue
        for y,x in ((j-1,i),(j+1,i),(j,i-1),(j,i+1)):
            if 0<=y<ny and 0<=x<nx and not blocked[la,y,x]:
                new=cost+pitch*(1+crossing_cost*max(crossing[la,j,i],crossing[la,y,x]))
                if new<dist[la,y,x]:dist[la,y,x]=new;heapq.heappush(queue,(new,la,y,x))
        if via_clear[j,i]:
            for other in range(layers):
                if other==la or blocked[other,j,i]:continue
                new=cost+via_cost
                if new<dist[other,j,i]:dist[other,j,i]=new;heapq.heappush(queue,(new,other,j,i))
    return dist


def _near(grid, blocked, xy, layer, radius=1.5):
    i,j=grid.cell_of(*xy);cells=[]
    steps=math.ceil(radius/grid.pitch)
    for y in range(max(0,j-steps),min(grid.ny,j+steps+1)):
        for x in range(max(0,i-steps),min(grid.nx,i+steps+1)):
            d=math.dist(xy,grid.center_of(x,y))
            if d<=radius and not blocked[layer,y,x]:cells.append((d,layer,y,x))
    return sorted(cells)


def _fields(graph,comp,rules,tracks,vias,pitch):
    from pnr.route.detail.grid import RouteGrid
    from pnr.route.detail.router import _fab,_signal_layers,_mark_plane_regions,_mark_copper_keepouts,_mark_source_arrays,_net_widths,_plane_nets
    # Remove only this component's pads from the static substrate. Keep its body
    # and parent-relative rule areas in graph for conservative keepout handling.
    static=BoardGraph.from_json(graph.to_json());static.component(comp.ref).pads=[]
    fab=_fab(rules);layers=_signal_layers(rules);names={p.net for p in comp.pads if p.net}-_plane_nets(rules)
    widths=_net_widths(rules,fab['track_width_mm']);fields={}
    for net in sorted(names):
        g=RouteGrid.from_graph(static,graph.outline.width,graph.outline.height,pitch=pitch,layers=layers,clearance=fab['clearance_mm'],track_width=widths.get(net,fab['track_width_mm']),via_radius=fab['via_diameter_mm']/2)
        _mark_plane_regions(g,static,rules,2.)
        _mark_copper_keepouts(g,graph,rules)
        # Source arrays on the moving footprint need candidate-specific rebuild;
        # those footprints are excluded by the proposal generator.
        _mark_source_arrays(g,static,rules)
        blocked=g.blocked.copy();via_clear=~np.any(g.via_blocked,axis=0)
        for (la,i,j),owner in g.pad_net.items():
            if owner!=net:blocked[la,j,i]=True
        for (la,i,j),owner in g.via_halo.items():
            if owner!=net:via_clear[j,i]=False
        copper=np.zeros_like(blocked,dtype=float)
        def segment(a,b,radius,visit):
            dx,dy=b[0]-a[0],b[1]-a[1];ll=dx*dx+dy*dy
            ix,jy=g.cell_of(min(a[0],b[0])-radius,min(a[1],b[1])-radius)
            ex,ey=g.cell_of(max(a[0],b[0])+radius,max(a[1],b[1])+radius)
            for y in range(max(0,jy),min(g.ny,ey+1)):
                for x in range(max(0,ix),min(g.nx,ex+1)):
                    px,py=g.center_of(x,y);t=max(0,min(1,((px-a[0])*dx+(py-a[1])*dy)/(ll or 1)))
                    if math.hypot(px-a[0]-t*dx,py-a[1]-t*dy)<=radius:visit(y,x)
        # Conservative raster half-cell diagonal avoids missing a crossing
        # simply because two centre-lines happen between coarse grid nodes.
        guard=pitch/math.sqrt(2)
        for owner,layer,a,b,width in tracks:
            if owner==net or layer not in layers:continue
            la=layers.index(layer)
            segment(a,b,width/2+g.clearance+g.track_width/2+guard,lambda y,x: copper.__setitem__((la,y,x),1.))
            segment(a,b,width/2+g.clearance+g.via_radius+guard,lambda y,x: via_clear.__setitem__((y,x),False))
        for owner,x,y in vias:
            if owner==net:continue
            segment((x,y),(x,y),g.via_radius+g.clearance+g.track_width/2+guard,lambda j,i: copper.__setitem__((slice(None),j,i),1.))
            segment((x,y),(x,y),2*g.via_radius+g.clearance+guard,lambda j,i:via_clear.__setitem__((j,i),False))
        seeds=[]
        for other in static.components:
            for pad,(_,xy) in zip(other.pads,pin_positions(other)):
                if pad.net!=net:continue
                side=0 if other.side=='top' else len(layers)-1
                for la in (range(len(layers)) if pad.through_hole else [side]):
                    near=_near(g,blocked,xy,la)
                    if near:seeds.append(near[0][1:])
        if seeds:fields[net]=(g,blocked,distance_field(blocked,via_clear,copper,seeds,pitch))
    return fields


def propose(graph,constraints,rules,tracks,vias=(),*,pressure=None,tried=None,refs=None,pitch=.8,candidate_pitch=2.,shortlist=32,max_parts=6,temperature=0.,rng=None):
    """Search the full legal board for translations, preserving physical rules.

    Shortlist by endpoint Manhattan distance plus spatially distributed samples;
    heavy scoring uses per-net layered distance fields from stationary terminals.
    Declines unsupported nonrectangular outlines and moving source-array/keepout
    owners until their candidate-dependent obstacles can be rebuilt correctly.
    """
    from .placer import PlacementReport
    from .anneal import choose_cost
    import random
    sample_parts = rng is not None
    rng = rng or random.Random(0)
    g=BoardGraph.from_json(graph.to_json());pressure=pressure or {};tried=tried if tried is not None else set()
    width,height=outline_size(g,constraints)
    if g.outline.polygon and any(x not in (0,width) or y not in (0,height) for x,y in g.outline.polygon):
        raise ValueError('relocation currently requires a rectangular outline')
    fixed=resolve_fixed_poses(g,constraints)
    unsupported={v['ref'] for v in rules.get('plane_access_intents',[]) if v['kind']=='power_array'}|{v['ref'] for v in rules.get('copper_keepouts',[])}
    legal=translation_checker(g,constraints)
    terminals={}
    for c in g.components:
        for p,(_,xy) in zip(c.pads,pin_positions(c)):terminals.setdefault(p.net,[]).append((c.ref,xy))
    eligible=[c for c in g.components if c.ref not in fixed and not c.locked and c.ref not in unsupported and (refs is None or c.ref in refs)]
    eligible.sort(key=lambda c:(-(1+pressure.get(c.ref,0))*len({p.net for p in c.pads if p.net}),c.ref))
    # Warm exploration considers different components, not only the same high-pin
    # components every cycle. Explicit refs still constrain the eligible pool.
    if sample_parts:
        rng.shuffle(eligible)
    choices=[];audit=[]
    for comp in eligible[:max_parts]:
        original=comp.pos
        def light(pos):
            dx,dy=pos[0]-original[0],pos[1]-original[1];cost=0
            for pad,(_,xy) in zip(comp.pads,pin_positions(comp)):
                peers=[q for ref,q in terminals.get(pad.net,[]) if ref!=comp.ref]
                if peers:cost+=min(abs(xy[0]+dx-q[0])+abs(xy[1]+dy-q[1]) for q in peers)
            return cost
        # Compute light cost with component at original pose.
        points=[]
        for x in np.arange(candidate_pitch/2,width,candidate_pitch):
            for y in np.arange(candidate_pitch/2,height,candidate_pitch):
                comp.pos=(float(x),float(y));ok=legal(comp);comp.pos=original
                if ok:points.append((light((x,y)),(float(x),float(y))))
        points.sort();selected=[p for _,p in points[:shortlist]]
        # Do not let a short-airwire basin hide empty distant regions.
        bins={}
        for cost,p in points:bins.setdefault((int(p[0]/(width/6)),int(p[1]/(height/6))),p)
        selected=list(dict.fromkeys([original,*selected,*bins.values()]))
        if len(selected)<2:continue
        fields=_fields(g,comp,rules,tracks,vias,pitch)
        def heavy(pos):
            score=0.;missing=0
            for pad,(_,xy) in zip(comp.pads,pin_positions(comp)):
                if pad.net not in fields:continue
                grid,blocked,dist=fields[pad.net];pt=(xy[0]+pos[0]-original[0],xy[1]+pos[1]-original[1]);side=0 if comp.side=='top' else len(grid.layers)-1
                values=[dist[la,j,i]+d for d,la,j,i in _near(grid,blocked,pt,side)]
                best=min(values,default=np.inf)
                if not math.isfinite(best):missing+=1;best=10000.
                score+=best
            return score+.1*light(pos),missing
        baseline,_=heavy(original);ranked=[]
        for pos in selected:
            identity=(comp.ref,*pos)
            if pos==original or identity in tried:continue
            cost,missing=heavy(pos);ranked.append(dict(position=list(pos),cost=cost,unreachable=missing))
            if cost<baseline-1e-6 or temperature>0:choices.append((baseline-cost,comp.ref,pos,baseline,cost,identity))
        audit.append(dict(ref=comp.ref,baseline_cost=baseline,legal_candidates=len(points),heavy_candidates=len(selected),best_candidates=sorted(ranked,key=lambda d:d['cost'])[:8]))
    if not choices:return None
    # Compare relative improvements across components with different pin counts.
    # Zero temperature retains the original deterministic greedy behavior.
    chosen = (choose_cost([(v[4]-v[3])/max(1.,v[3]) for v in choices],temperature,rng)
              if temperature>0 else max(range(len(choices)),key=lambda i:(choices[i][0],choices[i][1],choices[i][2])))
    gain,ref,pos,before,after,identity=choices[chosen];tried.add(identity)
    comp=g.component(ref);old=comp.pos;comp.pos=pos
    bad=hard_violations(g,constraints)
    if any(bad.values()):raise AssertionError(bad)
    report=PlacementReport(width,height,hpwl(graph),hpwl(g),**bad)
    return g,report,dict(model='global-layered-relocation-v2',temperature=temperature,sampled_candidates=len(choices),moves=[dict(ref=ref,original=list(old),position=list(pos),distance_mm=math.dist(old,pos))],cost_before=before,cost_after=after,via_cost_mm=3.,crossing_cost_per_mm=100.,grid_pitch_mm=pitch,candidates=audit,fixed_refs=sorted(fixed),unsupported_refs=sorted(unsupported),routing_validation='pending')
