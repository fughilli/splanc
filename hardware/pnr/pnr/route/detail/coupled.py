"""Coupled, single-layer differential routing with checked terminal fanouts.

Route a clearance envelope, offset BOTH traces, then validate their exact
geometry. No independently routed pair legs, silent gap changes or unmatched
vias. Length tuning inserts a bounded 45-degree trombone on the shorter leg;
every candidate is checked against its mate, itself and static obstacles.
"""
import math
from .keyhole import route, elbows, length
from .regional import segment_distance


def offset_path(path, offset):
    if len(path)<2:return []
    dirs=[];normals=[]
    for a,b in zip(path,path[1:]):
        d=math.dist(a,b)
        if d<1e-9:raise ValueError('zero centerline segment')
        u=((b[0]-a[0])/d,(b[1]-a[1])/d);dirs.append(u);normals.append((-u[1],u[0]))
    out=[(path[0][0]+offset*normals[0][0],path[0][1]+offset*normals[0][1])]
    for i,p in enumerate(path[1:-1],1):
        a,b=normals[i-1],normals[i];den=1+a[0]*b[0]+a[1]*b[1]
        if den<.5:raise ValueError('sharp/reversing pair bend')
        out.append((p[0]+offset*(a[0]+b[0])/den,p[1]+offset*(a[1]+b[1])/den))
    out.append((path[-1][0]+offset*normals[-1][0],path[-1][1]+offset*normals[-1][1]))
    # Offsets cannot consume/reverse a short centerline segment at a bend.
    if any((b[0]-a[0])*u[0]+(b[1]-a[1])*u[1]<=1e-8 for a,b,u in zip(out,out[1:],dirs)):
        raise ValueError('pair bend too short')
    return out



def simplify(path):
    out=[]
    for point in path:
        if out and math.dist(point,out[-1])<1e-8:continue
        while len(out)>=2:
            a,b=out[-2:];u=(b[0]-a[0],b[1]-a[1]);v=(point[0]-b[0],point[1]-b[1])
            if abs(u[0]*v[1]-u[1]*v[0])>1e-8 or u[0]*v[0]+u[1]*v[1]<0:break
            out.pop()
        out.append(point)
    return out

def geometry_ok(paths,width,gap,clear):
    for net,path in paths.items():
        if not all(clear(net,a,b,width) for a,b in zip(path,path[1:])):return False
        edges=list(zip(path,path[1:]))
        for i,(a,b) in enumerate(edges):
            for c,d in edges[i+2:]:
                if segment_distance(a,b,c,d)<width+gap-1e-6:return False
    ps=list(paths.values())
    return all(segment_distance(a,b,c,d)>=width+gap-1e-6 for a,b in zip(ps[0],ps[0][1:]) for c,d in zip(ps[1],ps[1][1:]))


def tune(paths, width, gap, skew, clear, offsets=None, max_tuning_length=None):
    """Match full endpoint path lengths, including explicitly supplied lead lengths."""
    offsets=offsets or {};nets=list(paths)
    lengths={n:length(p)+offsets.get(n,0) for n,p in paths.items()}
    short=min(nets,key=lambda n:lengths[n]);long=max(nets,key=lambda n:lengths[n])
    delta=lengths[long]-lengths[short]
    if delta<=skew+1e-7:return paths
    # Two 45-degree ramps, flat middle: excess=2*h*(sqrt(2)-1).
    h=max(0.,delta-skew*.95)/(2*(math.sqrt(2)-1))
    path=paths[short]
    # A compact local trombone must fit the source uncoupled-length allowance.
    # The former plateau grew with the whole host segment, losing coupling over
    # arbitrarily long distances even for a small endpoint skew correction.
    plateau=width+gap
    tuning_length=2*h*math.sqrt(2)+plateau
    if max_tuning_length is not None and tuning_length>max_tuning_length+1e-7:return None
    for i,(a,b) in enumerate(zip(path,path[1:])):
        d=math.dist(a,b)
        if d<2*h+plateau+2*(width+gap):continue
        ux,uy=(b[0]-a[0])/d,(b[1]-a[1])/d
        for side in (-1,1):
            vx,vy=-uy*side,ux*side
            pad=(d-2*h-plateau)/2
            at=lambda x,y:(a[0]+x*ux+y*vx,a[1]+x*uy+y*vy)
            mid=[at(pad,0),at(pad+h,h),at(pad+h+plateau,h),at(pad+2*h+plateau,0)]
            proposed=dict(paths);proposed[short]=path[:i+1]+mid+path[i+1:]
            if geometry_ok(proposed,width,gap,clear):return proposed
    return None


def trim_path(path, start=0., end=0.):
    """Trim only along the existing centerline; never cut an obstacle corner."""
    def trim(points, distance):
        points = list(points)
        while len(points) >= 2 and distance > 1e-9:
            a, b = points[:2]
            span = math.dist(a, b)
            if distance >= span - 1e-9:
                points.pop(0); distance -= span
            else:
                f = distance/span
                points[0] = (a[0]+f*(b[0]-a[0]), a[1]+f*(b[1]-a[1]))
                break
        return points
    if start < 0 or end < 0 or start+end >= length(path)-1e-8:
        return []
    return list(reversed(trim(list(reversed(trim(path,start))),end)))


def route_directional(a,z,ds,de,bounds,clear,pitch,max_uncoupled,max_expansions):
    """Route from exact straight leads before joining the discrete maze."""
    from .keyhole import Repair
    run=max_uncoupled+2*pitch
    ap=tuple(a[i]+ds[i]*run for i in (0,1))
    zp=tuple(z[i]-de[i]*run for i in (0,1))
    if clear(a,z):return Repair([a,z],'routed',0)
    if not clear(a,ap) or not clear(zp,z):return Repair([],'directional_lead_blocked',0)
    result=route([ap],[zp],bounds,clear,pitch=pitch,max_expansions=max_expansions)
    if result.status=='routed':result.path=simplify([a]+result.path+[z])
    return result


def solve_pair(p,n,terminals,bounds,clear,envelope_clear,width,gap,skew,*,pitch=.2,max_expansions=20000,max_uncoupled=2.0,offsets=None,max_attempts=32,signs=(-1,1),accept_paths=None,max_tuning_length=None):
    """Terminals map net -> (exact source, exact target); same-layer geometry.

    envelope_clear checks a center trace of width 2*width+gap against every
    foreign obstacle. Terminal fanout is bounded and exact, not a snap shortcut.
    The adapter must native-check pad connectivity, layer/reference continuity
    and any retained external branches before acceptance.
    """
    if min(width,gap,skew,pitch,max_uncoupled)<=0:raise ValueError('positive pair rules required')
    start=tuple((terminals[p][0][i]+terminals[n][0][i])/2 for i in (0,1))
    end=tuple((terminals[p][1][i]+terminals[n][1][i])/2 for i in (0,1))
    # Escape endpoints may not admit the wide envelope. Try cardinal leadouts,
    # but validate each individual pad-to-lane lead below, with bounded length.
    options=lambda q:[q]+[(q[0]+dx*d,q[1]+dy*d) for d in (.25,.5,.75,1.,1.25,1.5) if d<=max_uncoupled for dx,dy in ((1,0),(0,1),(-1,0),(0,-1))]
    attempts=0
    fanout_debug=[]
    failures={}
    def failed(reason):failures[reason]=failures.get(reason,0)+1
    candidates = [(start,end,None,None,None)]
    for sign in signs:
        headings=[]
        for index in (0,1):
            pp,nn=terminals[p][index],terminals[n][index]
            d=math.dist(pp,nn)
            if d < 1e-8:
                break
            headings.append((sign*(pp[1]-nn[1])/d,sign*(nn[0]-pp[0])/d))
        if len(headings)!=2:
            continue
        ds,de=headings
        for head,tail in sorted(((x,y) for x in (.25,.5,.75,1.,1.25,1.5,1.75) for y in (.25,.5,.75,1.,1.25,1.5,1.75)),key=lambda xy:sum(xy)):
            a=tuple(start[i]+ds[i]*head for i in (0,1))
            z=tuple(end[i]-de[i]*tail for i in (0,1))
            candidates.append((a,z,sign,ds,de))
    # Interleave both polarities at each lead length; a bounded search must
    # not spend all attempts on the first lane orientation.
    candidates=candidates[:1]+sorted(candidates[1:],key=lambda v:(round(math.dist(start,v[0])+math.dist(end,v[1]),8),math.dist(v[0],v[1])))
    candidates += [(a,z,None,None,None) for a,z in sorted(
        ((a,z) for a in options(start) for z in options(end)),
        key=lambda az:math.dist(start,az[0])+math.dist(end,az[1]))]
    for a,z,forced_sign,ds,de in candidates:
        if not envelope_clear(a,a,2*width+gap) or not envelope_clear(z,z,2*width+gap):continue
        if forced_sign is not None:
            viable=True
            for index,point,heading in ((0,a,ds),(1,z,de)):
                fanouts={}
                for net,side in ((p,1),(n,-1)):
                    portal=(point[0]-heading[1]*forced_sign*side*(width+gap)/2,
                            point[1]+heading[0]*forced_sign*side*(width+gap)/2)
                    fanouts[net]=[path for path in elbows(terminals[net][index],portal)
                                  if length(path)<=max_uncoupled and
                                  all(clear(net,x,y,width) for x,y in zip(path,path[1:]))]
                if not any(geometry_ok({p:pp,n:nn},width,gap,clear)
                           for pp in fanouts[p] for nn in fanouts[n]):
                    viable=False;break
            if not viable:
                failed('portal_fanout');continue
        def center_clear(x,y):
            if forced_sign is not None and math.dist(x,y)>1e-9:
                def aligned(vector,heading):
                    return (vector[0]*heading[0]+vector[1]*heading[1]>0 and
                            abs(vector[0]*heading[1]-vector[1]*heading[0])<1e-7)
                for point,heading,entering in ((a,ds,False),(z,de,True)):
                    # Keep a straight approach longer than the lane offset;
                    # endpoint-only heading checks admit microscopic U-turns.
                    if segment_distance(x,y,point,point) < max_uncoupled:
                        outward=tuple(-v if entering else v for v in heading)
                        for q in (x,y):
                            v=(q[0]-point[0],q[1]-point[1])
                            if (abs(v[0]*outward[1]-v[1]*outward[0])>1e-7 or
                                v[0]*outward[0]+v[1]*outward[1]<-1e-7):
                                return False
                    if math.dist(x,point)<1e-8:
                        vector=(x[0]-y[0],x[1]-y[1]) if entering else (y[0]-x[0],y[1]-x[1])
                        if not aligned(vector,heading):return False
                    if math.dist(y,point)<1e-8:
                        vector=(y[0]-x[0],y[1]-x[1]) if entering else (x[0]-y[0],x[1]-y[1])
                        if not aligned(vector,heading):return False
            return envelope_clear(x,y,2*width+gap)
        if forced_sign is not None:
            routed=route_directional(a,z,ds,de,bounds,center_clear,pitch,max_uncoupled,max_expansions)
        else:
            routed=route([a],[z],bounds,center_clear,pitch=pitch,max_expansions=max_expansions)
        attempts+=1
        if routed.status!='routed':
            failed('centerline_'+routed.status)
            if attempts>=max_attempts:break
            # Explicit straight approach candidates can still be viable.
        trial_paths = []
        if forced_sign is not None:
            for head in (1.,2.,3.):
                for tail in (1.,2.,3.):
                    ap=tuple(a[i]+ds[i]*head for i in (0,1))
                    zp=tuple(z[i]-de[i]*tail for i in (0,1))
                    for middle in elbows(ap,zp):
                        path=simplify([a]+middle+[z])
                        if all(bounds[0]<=q[0]<=bounds[2] and bounds[1]<=q[1]<=bounds[3] for q in path) and all(center_clear(x,y) for x,y in zip(path,path[1:])):
                            trial_paths.append(path)
        if routed.status == 'routed': trial_paths.append(routed.path)
        for raw_path in trial_paths:
            # Grid lead-in corners can create tiny hooks when offset. Move the
            # coupled portion's ends along its existing envelope and re-check the
            # exact pad fanouts, retaining the source-defined uncoupled length cap.
            trims = sorted(((a,z) for a in (0.,.25,.5,.75) for z in (0.,.25,.5,.75)),
                           key=lambda az:sum(az))
            for head_trim, tail_trim in trims:
                centerline = trim_path(raw_path, head_trim, tail_trim)
                if len(centerline) < 2:
                    continue
                for sign in ((forced_sign,) if forced_sign is not None else signs):
                    try: lanes={p:offset_path(centerline,sign*(width+gap)/2),n:offset_path(centerline,-sign*(width+gap)/2)}
                    except ValueError as exc:
                        if forced_sign is not None and head_trim==tail_trim==0 and len(fanout_debug)<8:
                            fanout_debug.append(dict(sign=sign,a=a,z=z,centerline=centerline,error=str(exc)))
                        failed("offset_bend");continue
                    fanouts={}
                    for net in (p,n):
                        path=lanes[net];s,t=terminals[net]
                        heads=[x for x in elbows(s,path[0]) if length(x)<=max_uncoupled and all(clear(net,a,b,width) for a,b in zip(x,x[1:]))]
                        tails=[x for x in elbows(path[-1],t) if length(x)<=max_uncoupled and all(clear(net,a,b,width) for a,b in zip(x,x[1:]))]
                        if forced_sign is not None and head_trim==tail_trim==0 and len(fanout_debug)<8:
                            fanout_debug.append(dict(net=net,sign=sign,a=a,z=z,centerline=centerline,heads=len(heads),tails=len(tails),lane=path))
                        fanouts[net]=[simplify(h[:-1]+path+tail[1:]) for h in heads for tail in tails]
                    if not fanouts[p] or not fanouts[n]:failed("terminal_fanout")
                    for pp in fanouts[p]:
                        for nn in fanouts[n]:
                            paths={p:pp,n:nn}
                            if not geometry_ok(paths,width,gap,clear):
                                failed("pair_geometry");continue
                            tuned=tune(paths,width,gap,skew,clear,offsets,max_tuning_length=max_uncoupled if max_tuning_length is None else max_tuning_length)
                            if tuned and accept_paths is not None and not accept_paths(tuned):
                                failed('path_validation');continue
                            if tuned:return dict(status='routed',paths=tuned,lengths={net:length(path)+(offsets or {}).get(net,0) for net,path in tuned.items()},centerline=centerline,attempts=attempts)
        if attempts>=max_attempts:break
    return dict(status='no_coupled_channel',paths={},attempts=attempts,failures=failures,fanout_debug=fanout_debug)


def path_metrics(tracks, vias, source, target, *, layer_heights=None):
    """Connected endpoint length, not total copper on a branched net.

    Input tracks are (layer,a,b) centerlines. Split intersections, vias and exact
    terminals; include vertical travel only between used via layers. Reject
    alternative-path cycles because their timing is ambiguous. Dangling branches
    are reported separately instead of being included in the matched path.
    """
    import heapq
    from collections import defaultdict
    from pnr.track_graph import intersection,on_segment
    nm=lambda p:tuple(round(x*1e6) for x in p)
    segments=[(la,nm(a),nm(b)) for la,a,b in tracks]
    points=defaultdict(set)
    for la,a,b in segments:points[la].update((a,b))
    for i,(la,a,b) in enumerate(segments):
        for lb,c,d in segments[i+1:]:
            if la==lb:
                q=intersection(a,b,c,d)
                if q is not None:points[la].add(q)
    for p,layers in vias:
        for la in layers:points[la].add(nm(p))
    for p,la in (source,target):points[la].add(nm(p))
    graph=defaultdict(dict)
    def add(a,b,d):
        if a!=b:graph[a][b]=min(graph[a].get(b,math.inf),d);graph[b][a]=graph[a][b]
    for la,a,b in segments:
        nodes=sorted((p for p in points[la] if on_segment(p,a,b)),key=lambda p:math.dist(p,a))
        for x,y in zip(nodes,nodes[1:]):add((la,*x),(la,*y),math.dist(x,y)/1e6)
    for p,layers in vias:
        if layer_heights is None:return dict(connected=False,reason='missing_layer_heights')
        ordered=sorted(layers,key=lambda la:layer_heights[la])
        for a,b in zip(ordered,ordered[1:]):add((a,*nm(p)),(b,*nm(p)),abs(layer_heights[a]-layer_heights[b]))
    start=(source[1],*nm(source[0]));end=(target[1],*nm(target[0]))
    heap=[(0,start)];best={start:0};parent={}
    while heap:
        d,a=heapq.heappop(heap)
        if d!=best[a]:continue
        for b,w in graph[a].items():
            if d+w<best.get(b,math.inf):best[b]=d+w;parent[b]=a;heapq.heappush(heap,(d+w,b))
    if end not in best:return dict(connected=False,reason='disconnected_endpoints')
    reached=set(best);edges=sum(len(graph[a]) for a in reached)//2
    if edges>=len(reached):return dict(connected=True,valid=False,reason='ambiguous_cycle')
    path=[end]
    while path[-1]!=start:path.append(parent[path[-1]])
    return dict(connected=True,valid=True,length_mm=best[end],path=list(reversed(path)),branch_vertices=len(reached-set(path)))
