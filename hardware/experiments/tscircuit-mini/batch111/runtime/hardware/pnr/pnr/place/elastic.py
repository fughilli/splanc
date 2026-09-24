"""Experimental collective placement through a bilinear elastic displacement mesh.

The mesh is a proposal generator. Full physical legalization and routing decide
acceptance; fixed/locked parts, pad geometry, orientations and board size survive.
Pressure is in stable caller-defined units, never normalized to the current peak.
"""
import math
import numpy as np
import torch
from pnr.graph import BoardGraph
from .channels import ChannelModel
from .geometry import (courtyard_rect, occupied_sides, outline_size,
                       resolve_fixed_poses, keepout_rects, hard_group_limits)
from .metrics import hard_violations, hpwl
from .legalize import legalize, LegalizationError
from .placer import PlacementReport


def mesh_weights(points, width, height, pitch):
    nx=max(2,math.ceil(width/pitch)+1);ny=max(2,math.ceil(height/pitch)+1)
    weights=np.zeros((len(points),nx*ny))
    for row,(x,y) in enumerate(points):
        u=np.clip(x/width*(nx-1),0,nx-1);v=np.clip(y/height*(ny-1),0,ny-1)
        i=min(nx-2,int(u));j=min(ny-2,int(v));a=u-i;b=v-j
        for di,dj,w in [(0,0,(1-a)*(1-b)),(1,0,a*(1-b)),(0,1,(1-a)*b),(1,1,a*b)]:
            weights[row,(i+di)*ny+j+dj]=w
    return weights,nx,ny


def project_collectively(graph, constraints, fixed, sweeps=160):
    """Repair simultaneous mesh poses locally without repacking the whole board."""
    candidate=BoardGraph.from_json(graph.to_json());parts=candidate.components
    width,height=outline_size(candidate,constraints)
    limits=hard_group_limits(constraints,fixed);keepouts=keepout_rects(candidate,constraints,fixed)
    movable={c.ref for c in parts if c.ref not in fixed}
    sides={c.ref:set(occupied_sides(c)) for c in parts}
    eps=1e-5
    for iteration in range(sweeps):
        for c in parts:
            if c.ref not in movable:continue
            r=courtyard_rect(c);x,y=c.pos
            x=min(width-r.w/2,max(r.w/2,x));y=min(height-r.h/2,max(r.h/2,y))
            for ax,ay,radius in limits.get(c.ref,()):
                distance=math.hypot(x-ax,y-ay)
                if distance>radius:x,y=ax+(x-ax)*(radius-eps)/distance,ay+(y-ay)*(radius-eps)/distance
            c.pos=(x,y)
            for k in keepouts:
                r=courtyard_rect(c)
                if not r.overlaps(k):continue
                options=[(abs(k.left-r.right),0,k.left-r.right-eps),(abs(k.right-r.left),0,k.right-r.left+eps),
                         (abs(k.bottom-r.top),1,k.bottom-r.top-eps),(abs(k.top-r.bottom),1,k.top-r.bottom+eps)]
                _,axis,shift=min(options);point=list(c.pos);point[axis]+=shift;c.pos=tuple(point)
        for i,a in enumerate(parts):
            for b in parts[i+1:]:
                if not sides[a.ref]&sides[b.ref]:continue
                ra,rb=courtyard_rect(a),courtyard_rect(b)
                if not ra.overlaps(rb):continue
                ma,mb=a.ref in movable,b.ref in movable
                if not (ma or mb):continue
                dx=(ra.w+rb.w)/2-abs(ra.cx-rb.cx);dy=(ra.h+rb.h)/2-abs(ra.cy-rb.cy)
                axis=0 if dx<dy else 1;amount=(dx if axis==0 else dy)+eps
                sign=1 if b.pos[axis]>=a.pos[axis] else -1
                for c,m,direction in [(a,ma,-sign),(b,mb,sign)]:
                    if m:
                        point=list(c.pos);point[axis]+=direction*amount/(int(ma)+int(mb));c.pos=tuple(point)
        if not any(hard_violations(candidate,constraints).values()):return candidate
    raise LegalizationError('collective projection did not reach physical legality')

def deform(graph,constraints,rules,pressure,*,strength=1.,mesh_pitch=6.,max_move=3.,iters=220,diagnostics=None,refresh_channels=True):
    """Return a legal coordinated candidate and proposal report, or None.

    All components are optimized together, then legalized together. No routed
    copper is moved: caller must regenerate routing from this placement.
    """
    g=BoardGraph.from_json(graph.to_json());parts=g.components
    width,height=outline_size(g,constraints);fixed=resolve_fixed_poses(g,constraints)
    fixed.update({c.ref:tuple(c.pos) for c in parts if c.locked})
    indices={c.ref:i for i,c in enumerate(parts)};original=np.array([c.pos for c in parts],dtype=float)
    dtype=torch.float64;xy=torch.tensor(original,dtype=dtype)
    weights,nx,ny=mesh_weights(original,width,height,mesh_pitch)
    for c in parts:
        if c.ref in fixed:weights[indices[c.ref]]=0
    W=torch.tensor(weights,dtype=dtype);nodes=torch.nn.Parameter(torch.zeros((nx,ny,2),dtype=dtype))
    def channel_tensors(current_delta):
        for c,p in zip(parts,original+current_delta):c.pos=tuple(map(float,p))
        rows=[]
        for ch in ChannelModel(g,rules).report(g)['channels']:
            i,j=[indices[r] for r in ch['refs']]
            direction={'east':(1,0),'west':(-1,0),'north':(0,1),'south':(0,-1)}[ch['direction']]
            base=ch['gap_mm']-float(np.dot(current_delta[j]-current_delta[i],direction))
            rows.append((i,j,direction,base,ch['required_mm'],1+max(pressure.get(parts[i].ref,0),pressure.get(parts[j].ref,0))))
        if not rows:return None
        return (torch.tensor([r[0] for r in rows]),torch.tensor([r[1] for r in rows]),
                torch.tensor([r[2] for r in rows],dtype=dtype),torch.tensor([r[3] for r in rows],dtype=dtype),
                torch.tensor([r[4] for r in rows],dtype=dtype),torch.tensor([min(8,r[5]) for r in rows],dtype=dtype))
    tensors=channel_tensors(np.zeros_like(original));refreshes=[]
    if tensors is None:return None
    rects=[courtyard_rect(c) for c in parts];half=torch.tensor([[r.w/2,r.h/2] for r in rects],dtype=dtype)
    same=torch.tensor([[i<j and bool(set(occupied_sides(a))&set(occupied_sides(b))) for j,b in enumerate(parts)] for i,a in enumerate(parts)])
    keepouts=keepout_rects(g,constraints,fixed);limits=hard_group_limits(constraints,fixed)
    legalizer_failures=[];candidates=[]
    diagnostics={} if diagnostics is None else diagnostics
    diagnostics["attempts"]=legalizer_failures
    optimizer=torch.optim.Adam([nodes],lr=.035)
    for step in range(iters):
        optimizer.zero_grad();field=max_move*torch.tanh(nodes);delta=W@field.reshape(-1,2);pos=xy+delta
        if refresh_channels and step%20==0:
            tensors=channel_tensors(delta.detach().numpy())
            refreshes.append(dict(step=step,channels=0 if tensors is None else len(tensors[0])))
        if tensors is None:channel=pos.sum()*0
        else:
            ia,ib,directions,gaps,need,priorities=tensors
            separation=gaps+((delta[ib]-delta[ia])*directions).sum(1)
            channel=(priorities*torch.relu(need-separation)**2).sum()
        penetration=half[:,None,:]+half[None,:,:]-torch.abs(pos[:,None,:]-pos[None,:,:])
        overlap=torch.relu(penetration.min(2).values)[same].square().sum()
        bounds=torch.relu(half-pos).square().sum()+torch.relu(pos+half-torch.tensor([width,height],dtype=dtype)).square().sum()
        keep=pos.sum()*0
        for r in keepouts:
            pen=half+torch.tensor([r.w/2,r.h/2],dtype=dtype)-torch.abs(pos-torch.tensor([r.cx,r.cy],dtype=dtype))
            keep=keep+torch.relu(pen.min(1).values).square().sum()
        group=pos.sum()*0
        for ref,circles in limits.items():
            if ref not in indices:continue
            for x,y,radius in circles:group=group+torch.relu(torch.linalg.vector_norm(pos[indices[ref]]-torch.tensor([x,y],dtype=dtype))-radius).square()
        smooth=(field[1:]-field[:-1]).square().sum()+(field[:,1:]-field[:,:-1]).square().sum()
        loss=strength*channel+1000*(overlap+bounds+keep+group)+.08*smooth+.03*delta.square().sum()
        loss.backward();optimizer.step()
        if (step+1)%55 and step!=iters-1:continue
        proposed=xy+(W@(max_move*torch.tanh(nodes)).reshape(-1,2))
        for c,p in zip(parts,proposed.detach().numpy()):c.pos=tuple(map(float,p))
        try:
            candidate=project_collectively(g,constraints,fixed)
        except LegalizationError as error:
            legalizer_failures.append(dict(step=step+1,error=str(error)));continue
        bad=hard_violations(candidate,constraints)
        if any(bad.values()):
            legalizer_failures.append(dict(step=step+1,hard_violations=bad));continue
        # Legalizer may search outside the displacement trust region; reject that.
        distances=[math.dist(c.pos,original[indices[c.ref]]) for c in candidate.components]
        if max(distances,default=0)>max_move*1.6:
            legalizer_failures.append(dict(step=step+1,excess_displacement=max(distances)));continue
        score=ChannelModel(candidate,rules).report(candidate)['shortage_score']
        moved={c.ref:dict(before=original[indices[c.ref]].tolist(),after=list(c.pos)) for c in candidate.components if math.dist(c.pos,original[indices[c.ref]])>.01}
        candidates.append((score,candidate,dict(step=step+1,moves=moved,max_displacement_mm=max(distances),mesh_nodes=(max_move*torch.tanh(nodes)).detach().tolist())))
    if not candidates:return None
    score,candidate,event=min(candidates,key=lambda a:a[0]);bad=hard_violations(candidate,constraints)
    event.update(channel_refreshes=refreshes,model='bilinear-elastic-v2' if refresh_channels else 'bilinear-elastic-v1',mesh_shape=[nx,ny],strength=strength,
                 channel_before=ChannelModel(graph,rules).report(graph)['shortage_score'],channel_after=score,
                 legalizer_failures=legalizer_failures,fixed_refs=sorted(fixed),legal=True)
    return candidate,PlacementReport(width,height,hpwl(graph),hpwl(candidate),**bad),event
