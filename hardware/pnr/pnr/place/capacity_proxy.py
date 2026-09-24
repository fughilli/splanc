"""Placement-only routability screen; never an electrical acceptance gate.

Raster pads/keepouts, estimate per-layer cut capacity, then negotiate shared
multi-terminal demand. Units: planar resources mm of channel width; through-via
resources mm^2 of free column area. No KiCad, native DRC or detailed routing.
"""
import heapq
import math
import time
from collections import defaultdict
import numpy as np
from pnr.electrical import net_policy
from .geometry import pin_positions, pad_rects, courtyard_rect


class CapacityGraph:
    def __init__(self, graph, rules, pitch=2., raster=.25):
        if rules.get('layers',4) not in (2,4):raise ValueError('Proxy currently supports 2 or 4 copper layers')
        if graph.outline.polygon and any(x not in (0,graph.outline.width) or y not in (0,graph.outline.height) for x,y in graph.outline.polygon):raise ValueError('Proxy requires rectangular outline')
        self.pitch=pitch; self.layers=['F.Cu','B.Cu'] if rules.get('layers',4)==2 else ['F.Cu','In1.Cu','In2.Cu','B.Cu']
        self.nx=math.ceil(graph.outline.width/pitch);self.ny=math.ceil(graph.outline.height/pitch)
        sub=max(2,math.ceil(pitch/raster));self.sub=sub;step=pitch/sub
        nx,ny=self.nx*sub,self.ny*sub
        xs=(np.arange(nx)+.5)*step;ys=(np.arange(ny)+.5)*step
        free=np.ones((len(self.layers),ny,nx),dtype=bool)
        owners=np.zeros_like(free,dtype=np.int32)
        self.net_ids={n:i+1 for i,n in enumerate(sorted({p.net for c in graph.components for p in c.pads if p.net}))}
        margin=rules.get('fab',{}).get('edge_clearance_mm',.2)
        free[:,:, (xs<margin)|(xs>graph.outline.width-margin)]=False
        free[:,(ys<margin)|(ys>graph.outline.height-margin),:]=False
        def box(layers,x0,y0,x1,y1,owner=-1):
            ix=np.flatnonzero((xs>=x0)&(xs<=x1));iy=np.flatnonzero((ys>=y0)&(ys<=y1))
            if len(ix) and len(iy):
                for la in layers:
                    free[la,iy[0]:iy[-1]+1,ix[0]:ix[-1]+1]=False
                    view=owners[la,iy[0]:iy[-1]+1,ix[0]:ix[-1]+1]
                    view[:]=np.where((view==0)|(view==owner),owner,-1)
        clearance=rules.get('fab',{}).get('clearance_mm',.15)
        for c in graph.components:
            for p,(_,_,rect) in zip(c.pads,pad_rects(c)):
                layers=range(len(self.layers)) if p.through_hole else [0 if c.side=='top' else len(self.layers)-1]
                box(layers,rect.left-clearance/2,rect.bottom-clearance/2,rect.right+clearance/2,rect.top+clearance/2,self.net_ids.get(p.net,-1))
        for v in rules.get('copper_keepouts',[]):
            c=graph.component(v['ref']);x0,y0,x1,y1=v['rect_mm'];a=math.radians(c.rot)
            pts=[(c.pos[0]+x*math.cos(a)-y*math.sin(a),c.pos[1]+x*math.sin(a)+y*math.cos(a)) for x,y in [(x0,y0),(x0,y1),(x1,y0),(x1,y1)]]
            box(range(len(self.layers)),min(x for x,y in pts),min(y for x,y in pts),max(x for x,y in pts),max(y for x,y in pts))
        for h in rules.get('mounting_holes',[]):
            # Different upstream schemas are recorded as a limitation if absent.
            xy=h.get('at',h.get('pos'))
            if xy:
                radius=h.get('clearance_diameter_mm',h.get('diameter_mm',h.get('drill_mm',3)))/2+clearance
                box(range(len(self.layers)),xy[0]-radius,xy[1]-radius,xy[0]+radius,xy[1]+radius)
        # Physical reservations from source-owned current-sized arrays.
        from pnr.plane_intent import array_geometry
        for intent in rules.get('plane_access_intents',[]):
            if intent['kind']!='power_array':continue
            c=graph.component(intent['ref'])
            pads=[((r.cx,r.cy),(r.w,r.h)) for p,(_,_,r) in zip(c.pads,pad_rects(c)) if p.name in intent['pads']]
            a=array_geometry(pads,c.pos,intent,rules['plane_access_fab'])
            owner=self.net_ids.get(intent['net'],-1)
            for (x,y),diameter,drill in a['vias']:
                r=diameter/2+clearance/2;box(range(len(self.layers)),x-r,y-r,x+r,y+r,owner)
            la=0 if c.side=='top' else len(self.layers)-1
            for start,end,width in a['tracks']:
                for t in np.linspace(0,1,max(2,math.ceil(math.dist(start,end)/step))):
                    x=start[0]+t*(end[0]-start[0]);y=start[1]+t*(end[1]-start[1]);r=(width+clearance)/2
                    box([la],x-r,y-r,x+r,y+r,owner)
        owners[~free & (owners==0)]=-1
        self.owners=owners;self.step=step
        fractions=free.reshape(len(self.layers),self.ny,sub,self.nx,sub).mean(axis=(2,4))
        # Dilate actual pad/keepout raster by via radius before counting columns.
        via_ok=free.all(axis=0);radius=math.ceil((rules.get('fab',{}).get('via_diameter_mm',.6)/2+clearance/2)/step)
        padded=np.pad(via_ok,radius,constant_values=False);safe=np.ones_like(via_ok)
        for dy in range(-radius,radius+1):
            for dx in range(-radius,radius+1):
                if dx*dx+dy*dy<=radius*radius:safe &= padded[radius+dy:radius+dy+ny,radius+dx:radius+dx+nx]
        via_area=safe.reshape(self.ny,sub,self.nx,sub).mean(axis=(1,3))*pitch*pitch
        self.adj=[[] for _ in range(len(self.layers)*self.nx*self.ny)];self.cap=[];self.kind=[];self.location=[]
        def resource(cap,kind,location):
            i=len(self.cap);self.cap.append(float(cap));self.kind.append(kind);self.location.append(location);return i
        def connect(a,b,r,la):self.adj[a].append((b,r,la));self.adj[b].append((a,r,la))
        for la in range(len(self.layers)):
            for y in range(self.ny):
                for x in range(self.nx):
                    a=self.node(la,x,y)
                    for dx,dy in [(1,0),(0,1)]:
                        xx,yy=x+dx,y+dy
                        if xx>=self.nx or yy>=self.ny:continue
                        if dx:
                            face=free[la,y*sub:(y+1)*sub,(x+1)*sub-1:(x+1)*sub+1].all(axis=1).sum()*step
                        else:face=free[la,(y+1)*sub-1:(y+1)*sub+1,x*sub:(x+1)*sub].all(axis=0).sum()*step
                        cap=min(face,pitch*math.sqrt(min(fractions[la,y,x],fractions[la,yy,xx])))
                        r=resource(cap,'channel',[la,x,y]);connect(a,self.node(la,xx,yy),r,la)
        for y in range(self.ny):
            for x in range(self.nx):
                r=resource(via_area[y,x],'via',[-1,x,y])
                for la in range(len(self.layers)):
                    for lb in range(la+1,len(self.layers)):connect(self.node(la,x,y),self.node(lb,x,y),r,-1)
        self.plated_resources=defaultdict(set)
        columns={}
        for c in graph.components:
            for p,(_,xy) in zip(c.pads,pin_positions(c)):
                if p.through_hole and p.net:
                    columns.setdefault((int(xy[0]/pitch),int(xy[1]/pitch)),set()).add(p.net)
        for r,(la,x,y) in enumerate(self.location):
            if la==-1:
                for net in columns.get((x,y),[]):self.plated_resources[net].add(r)
        self.cap=np.array(self.cap);self.plane_layers={self.layers.index(c['plane_layer']):c['nets'] for c in rules.get('net_classes',[]) if c.get('plane_layer') in self.layers}

    def node(self,la,x,y):return (la*self.ny+y)*self.nx+x
    def terminal(self,side,xy):return self.node(0 if side=='top' else len(self.layers)-1,min(self.nx-1,max(0,int(xy[0]/self.pitch))),min(self.ny-1,max(0,int(xy[1]/self.pitch))))
    def layer(self,node):return node//(self.nx*self.ny)
    def attach(self,side,xy,net):
        """Short same-layer portal ray, allowing own pad but no foreign obstacles.

        Prevent a large terminal land from making its whole coarse cell falsely
        unreachable. Ray is a screen, not a qualified pad-entry witness.
        """
        la=0 if side=='top' else len(self.layers)-1;cx=int(xy[0]/self.pitch);cy=int(xy[1]/self.pitch);options=[]
        owner=self.net_ids.get(net,-2)
        for y in range(max(0,cy-1),min(self.ny,cy+2)):
            for x in range(max(0,cx-1),min(self.nx,cx+2)):
                node=self.node(la,x,y)
                if not any(self.cap[r]>0 for _,r,l in self.adj[node]):continue
                target=((x+.5)*self.pitch,(y+.5)*self.pitch);length=math.dist(xy,target)
                samples=max(2,math.ceil(length/(self.step/2)))
                points=np.linspace(xy,target,samples)
                ii=np.floor(points[:,0]/self.step).astype(int);jj=np.floor(points[:,1]/self.step).astype(int)
                if ii.min()<0 or jj.min()<0 or ii.max()>=self.owners.shape[2] or jj.max()>=self.owners.shape[1]:continue
                hits=self.owners[la,jj,ii]
                if np.all((hits==0)|(hits==owner)):options.append((length,node))
        return min(options)[1] if options else self.terminal(side,xy)



def commodities(graph,rules,mesh):
    terminals=defaultdict(set);pins={}
    for c in graph.components:
        for p,(_,xy) in zip(c.pads,pin_positions(c)):
            node=mesh.terminal(c.side,xy);pins[c.ref+'.'+p.name]=(node,xy,c.side)
            if p.net:terminals[p.net].add(mesh.attach(c.side,xy,p.net))
    out=[];paired=set()
    for pair in rules.get('diff_pairs',[]):
        chain=pair.get('terminal_chain',[])
        if not chain:continue
        nodes=[]
        for t in chain:
            if t['p'] not in pins or t['n'] not in pins:raise ValueError('Pair terminal missing')
            p,n=pins[t['p']],pins[t['n']]
            nodes.append(mesh.terminal(p[2],((p[1][0]+n[1][0])/2,(p[1][1]+n[1][1])/2)))
        width=2*pair['width_mm']+pair['gap_mm']+rules.get('fab',{}).get('clearance_mm',.15)
        out.append(dict(name=pair['name'],nodes=nodes,widths=[width]*len(mesh.layers),via_count=2,plane=None,mode='pair'))
        paired.update([pair['p'],pair['n']])
    for net,nodes in sorted(terminals.items()):
        if net in paired:continue
        p=net_policy(net,rules)
        if p.get('plane') and p['plane'] not in mesh.layers:raise ValueError('Declared plane absent from layer model')
        if len(nodes)<2 and not p.get('plane'):continue
        widths=[p['outer_width_mm']+p['clearance_mm'] if i in (0,len(mesh.layers)-1) else p['inner_width_mm']+p['clearance_mm'] for i in range(len(mesh.layers))]
        out.append(dict(name=net,nodes=sorted(nodes),widths=widths,via_count=p.get('via_array',{}).get('count',1),plane=mesh.layers.index(p['plane']) if p.get('plane') in mesh.layers else None,mode=p['mode']))
    return sorted(out,key=lambda c:(-max(c['widths']),c['name']))


def score(graph,rules,*,pitch=2.,passes=3,raster=.25):
    """Return decomposed score + heatmap. Lower is better; no DRC inference."""
    started=time.perf_counter();mesh=CapacityGraph(graph,rules,pitch,raster);nets=commodities(graph,rules,mesh)
    usage=np.zeros(len(mesh.cap));history=np.zeros(len(mesh.cap));saved={};rounds=[];best=None
    via_pitch=rules.get('fab',{}).get('via_diameter_mm',.6)+rules.get('fab',{}).get('clearance_mm',.15)
    for iteration in range(passes):
        missing=0;length=0.;vias=0;net_failures={}
        for net in nets:
            for r,d in saved.get(net['name'],{}).items():usage[r]-=d
            owned={};tree={net['nodes'][0]};failed=0
            def demand(r,la):return (0. if r in mesh.plated_resources[net['name']] else net['via_count']*via_pitch**2) if la==-1 else net['widths'][la]
            for start in (net['nodes'] if net['plane'] is not None else net['nodes'][1:]):
                if net['plane'] is None and start in tree:continue
                distances={start:0.};prev={};queue=[(0.,start)];end=None
                while queue:
                    cost,node=heapq.heappop(queue)
                    if cost!=distances[node]:continue
                    if (net['plane'] is not None and mesh.layer(node)==net['plane']) or (net['plane'] is None and node in tree):end=node;break
                    for other,r,la in mesh.adj[node]:
                        if la in mesh.plane_layers and net['name'] not in mesh.plane_layers[la]:continue
                        cap=max(mesh.cap[r],via_pitch**2) if r in mesh.plated_resources[net['name']] else mesh.cap[r]
                        if cap<=1e-9:continue
                        d=demand(r,la);extra=0 if r in owned else d
                        ratio=(usage[r]+extra)/cap
                        base=3. if la==-1 else pitch
                        step=base*(1+history[r]+8*max(0,ratio-1)**2+.15*ratio**2)
                        if r in owned:step=.01*base
                        new=cost+step
                        if new<distances.get(other,math.inf):distances[other]=new;prev[other]=(node,r,la);heapq.heappush(queue,(new,other))
                if end is None:
                    failed+=1;tree.add(start);continue
                node=end;tree.add(node)
                while node!=start:
                    parent,r,la=prev[node]
                    if r not in owned:
                        d=demand(r,la);owned[r]=d;usage[r]+=d
                    tree.add(parent);node=parent
            saved[net['name']]=owned;missing+=failed
            if failed:net_failures[net['name']]=failed
            length+=sum(pitch for r in owned if mesh.kind[r]=='channel');vias+=sum(net['via_count'] for r in owned if mesh.kind[r]=='via' and r not in mesh.plated_resources[net['name']])
        overflow=np.maximum(0,usage-mesh.cap);ratios=usage/np.maximum(mesh.cap,1e-9)
        # Dimensionless overflow and near-saturation expose competition before
        # hard capacity is exceeded; length only breaks otherwise close scores.
        overflow_units=float(np.sum(overflow/np.maximum(mesh.cap,.1)))
        saturation=float(np.sum(np.maximum(0,ratios-.7)**2))
        value=missing*10000+overflow_units*100+saturation*10+length*.01+vias*.03
        result=dict(score=value,unreachable_branches=missing,overflow_units=overflow_units,saturation=saturation,wire_mm=length,via_demand=vias,net_failures=net_failures,pass_index=iteration)
        rounds.append(result)
        if best is None or value<best['score']:
            heat=np.zeros((len(mesh.layers),mesh.ny,mesh.nx))
            for r,(la,x,y) in enumerate(mesh.location):
                if la>=0:heat[la,y,x]=max(heat[la,y,x],ratios[r])
            best=dict(result,heatmap=heat.tolist())
        history+=np.maximum(0,ratios-1)
    return dict(best,rounds=rounds,seconds=time.perf_counter()-started,layers=mesh.layers,pitch_mm=pitch,net_count=len(nets),model='capacity-proxy-v1',scope='placement-only all-net coarse negotiated demand',limitations=['Coarse cut capacity does not prove continuous detailed escapes.','Plane access assumes declared plane continuity; reference/skew and pad-entry qualification require native routing.','Existing routed tracks are not counted: all net demand is reconstructed to avoid double counting.','Whole-net power widths are conservative; terminal-specific necks are not modeled; source power arrays are reserved.','Same-cell terminals collapse; short portal rays do not certify local pad entry.'])


def cheap_score(graph,rules,pitch=4.):
    """Linear-time RUDY-style width demand + local terminal crowding screen.

    Bounding boxes distribute each net's estimated wire area. Per-surface
    terminal demand exposes pin-dense regions even before global paths exist.
    This stage selects a diverse pool; it never rejects a legal placement.
    """
    nx=math.ceil(graph.outline.width/pitch);ny=math.ceil(graph.outline.height/pitch)
    density=np.zeros((ny,nx));escape=np.zeros((2,ny,nx));nets=defaultdict(list);wire=0.
    for c in graph.components:
        for p,(_,xy) in zip(c.pads,pin_positions(c)):
            if not p.net:continue
            nets[p.net].append(xy);policy=net_policy(p.net,rules)
            x=min(nx-1,max(0,int(xy[0]/pitch)));y=min(ny-1,max(0,int(xy[1]/pitch)))
            escape[0 if c.side=='top' else 1,y,x]+=policy['outer_width_mm']+policy['clearance_mm']
    for net,pts in nets.items():
        if len(pts)<2:continue
        policy=net_policy(net,rules)
        if policy.get('plane'):continue
        x0=min(x for x,y in pts);x1=max(x for x,y in pts);y0=min(y for x,y in pts);y1=max(y for x,y in pts)
        length=x1-x0+y1-y0;wire+=length
        a=max(0,min(nx-1,int(x0/pitch)));b=max(0,min(nx-1,int(x1/pitch)))
        c=max(0,min(ny-1,int(y0/pitch)));d=max(0,min(ny-1,int(y1/pitch)))
        density[c:d+1,a:b+1]+=length*(policy['outer_width_mm']+policy['clearance_mm'])/((b-a+1)*(d-c+1)*pitch*pitch)
    return float(np.sum(density**2)+np.sum((escape/(4*pitch))**2)+wire*.001)


def rank_candidates(candidates,rules,*,budget=12,pitch=2.,passes=3):
    """Screen complete legal configurations, including geographically diverse ones.

    Input entries have graph/moves/cost; caller owns hard-constraint validation.
    First half of proxy budget takes cheap scores; remainder maximizes distance
    in moved-component pose space. This happens BEFORE costly proxy ranking.
    """
    started=time.perf_counter()
    if not candidates:return [],dict(evaluated=0)
    if budget<1:raise ValueError('proxy budget must be positive')
    scored=[(cheap_score(c['graph'],rules),i) for i,c in enumerate(candidates)]
    scored.sort();selected=[]
    # Prefer representative legal sites underneath sufficiently large opposite
    # SMD bodies, as physical opportunities distinct from shortest-wire basins.
    refs=sorted({m['ref'] for c in candidates for m in c.get('moves',[])})
    for ref in refs:
        graph=candidates[0]['graph'];comp=graph.component(ref)
        for body in graph.components:
            if body.ref==ref or body.side==comp.side or not body.smd_body:continue
            b=courtyard_rect(body)
            rect=courtyard_rect(comp)
            if b.w<rect.w or b.h<rect.h:continue
            options=[]
            for i,c in enumerate(candidates):
                rect=courtyard_rect(c['graph'].component(ref))
                if rect.left>=b.left and rect.right<=b.right and rect.bottom>=b.bottom and rect.top<=b.top:
                    options.append((math.dist((rect.cx,rect.cy),(b.cx,b.cy)),i))
            if options and len(selected)<max(1,budget//3):
                i=min(options)[1]
                if i not in selected:selected.append(i)
    for _,i in scored:
        if len(selected)>=max(1,budget//2):break
        if i not in selected:selected.append(i)
    refs=sorted({m['ref'] for c in candidates for m in c.get('moves',[])})
    def distance(i,j):return sum(math.dist(candidates[i]['graph'].component(r).pos,candidates[j]['graph'].component(r).pos)**2 for r in refs)
    while len(selected)<min(budget,len(candidates)):
        remaining=[i for _,i in scored if i not in selected]
        selected.append(max(remaining,key=lambda i:(min(distance(i,j) for j in selected),-i)))
    screen_seconds=time.perf_counter()-started
    result=[];details=[]
    for i in selected:
        c=dict(candidates[i]);proxy=score(c['graph'],rules,pitch=pitch,passes=passes)
        c['legacy_cost']=c['cost'];c['cost']=proxy['score'];c['proxy']=proxy;result.append(c)
        details.append(dict(candidate_index=i,moves=c.get('moves',[]),cheap_score=next(s for s,j in scored if j==i),**{k:v for k,v in proxy.items() if k not in ('heatmap','rounds')}))
    result.sort(key=lambda c:c['cost'])
    return result,dict(model='hierarchical-capacity-v1',available=len(candidates),evaluated=len(result),budget=budget,screen_seconds=screen_seconds,total_seconds=time.perf_counter()-started,candidates=details)


def diverse_options(ranked,original,n,width,height,graph=None,ref=None):
    """Preserve baseline and geographic basins BEFORE joint Monte Carlo sampling."""
    if n<1:raise ValueError('n must be positive')
    selected=[original];remaining=[c for c in ranked if c is not original]
    if n>1 and remaining:selected.append(remaining.pop(0))
    if graph is not None and n>2:
        comp=graph.component(ref);rect=courtyard_rect(comp);w,h=rect.w,rect.h
        for body in graph.components:
            if not body.smd_body or body.side==comp.side:continue
            b=courtyard_rect(body)
            fits=[v for v in remaining if b.left+w/2<=v['position'][0]<=b.right-w/2 and b.bottom+h/2<=v['position'][1]<=b.top-h/2]
            if fits and len(selected)<n:
                chosen=min(fits,key=lambda v:math.dist(v['position'],body.pos));selected.append(chosen);remaining.remove(chosen)
    while remaining and len(selected)<n:
        chosen=max(remaining,key=lambda c:(min(((c['position'][0]-q['position'][0])/width)**2+((c['position'][1]-q['position'][1])/height)**2 for q in selected),-c['cost']))
        selected.append(chosen);remaining.remove(chosen)
    return selected
