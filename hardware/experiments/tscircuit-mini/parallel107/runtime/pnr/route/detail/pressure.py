"""Localized feedback from disconnected route terminals and obstructed corridors.

This probes low-cost planar corridors through the *final* route occupancy. It is
not a proof of a cut or native impossibility. Unlike a net bounding box, only the
observed obstructed cells (or disconnected endpoints) receive pressure.
"""
import heapq
import math
from .grid import Cell


def disconnected_pairs(access, routed):
    parent={}
    def find(a):
        parent.setdefault(a,a)
        while parent[a]!=a:
            parent[a]=parent[parent[a]];a=parent[a]
        return a
    def join(a,b):parent[find(a)]=find(b)
    for layer,a,b in routed.segments:
        join(Cell(layer,*a),Cell(layer,*b))
    for c in access:find(c)
    for i,j in routed.vias:
        cells=[c for c in list(parent) if c.i==i and c.j==j]
        for c in cells[1:]:join(cells[0],c)
    groups={}
    for c in access:groups.setdefault(find(c),[]).append(c)
    groups=list(groups.values());pairs=[]
    # A minimum spanning forest of missing terminal groups avoids charging every
    # possible pair of pads on a large net.
    while len(groups)>1:
        _,i,j,a,b=min(((abs(a.i-b.i)+abs(a.j-b.j)+2*(a.layer!=b.layer),i,j,a,b)
                     for i in range(len(groups)) for j in range(i+1,len(groups))
                     for a in groups[i] for b in groups[j]),key=lambda item:item[0])
        pairs.append((a,b));groups[i]+=groups.pop(j)
    return pairs


def corridor(grid,start,end,net,occupied,budget=6000):
    """Probe one endpoint layer with explicit penalties for crossed obstacles."""
    layer=start.layer;source=(start.i,start.j);target=(end.i,end.j)
    margin=max(2,math.ceil(3/grid.pitch));x0=max(0,min(source[0],target[0])-margin);x1=min(grid.nx-1,max(source[0],target[0])+margin)
    y0=max(0,min(source[1],target[1])-margin);y1=min(grid.ny-1,max(source[1],target[1])+margin)
    def blocked(p):
        c=Cell(layer,*p)
        return not grid.passable(layer,*p,net) or bool(occupied.get(c,set())-{net})
    def heuristic(p):return abs(p[0]-target[0])+abs(p[1]-target[1])
    heap=[(heuristic(source),0,source)];cost={source:0};previous={};expanded=0
    while heap and expanded<budget:
        _,g,p=heapq.heappop(heap)
        if g!=cost[p]:continue
        expanded+=1
        if p==target:
            path=[p]
            while p in previous:p=previous[p];path.append(p)
            return [q for q in path if blocked(q)],False
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
            q=(p[0]+dx,p[1]+dy)
            if not (x0<=q[0]<=x1 and y0<=q[1]<=y1):continue
            value=g+1+20*blocked(q)
            if value<cost.get(q,float('inf')):
                cost[q]=value;previous[q]=p;heapq.heappush(heap,(value+heuristic(q),value,q))
    return [],True


def localized_pressure(grid,net_access,result,deferred=()):
    occupied={}
    for name,rn in result.nets.items():
        for c in rn.cells:occupied.setdefault(c,set()).add(name)
    events=[]
    for net in sorted(set(result.unrouted)-set(deferred)):
        rn=result.nets[net]
        for a,b in disconnected_pairs(net_access.get(net,[]),rn):
            choices=[corridor(grid,a,b,net,occupied),corridor(grid,b,a,net,occupied)]
            finished=[x for x in choices if not x[1]]
            blockers=min(finished,key=lambda x:len(x[0]))[0] if finished else []
            # No inferred block when a planar corridor is open or the probe is
            # inconclusive: just charge the disconnected access terminals.
            points=[grid.center_of(*p) for p in blockers] or [grid.center_of(a.i,a.j),grid.center_of(b.i,b.j)]
            width=getattr(grid,'net_widths',{}).get(net,grid.track_width)
            weight=(width+grid.clearance)/(grid.track_width+grid.clearance)
            events.append(dict(net=net,kind='obstructed_corridor' if blockers else 'disconnected_terminals',
                               points=points,weight=weight/len(points),budget_exhausted=not bool(finished),
                               endpoints=[grid.center_of(a.i,a.j),grid.center_of(b.i,b.j)]))
    return events
