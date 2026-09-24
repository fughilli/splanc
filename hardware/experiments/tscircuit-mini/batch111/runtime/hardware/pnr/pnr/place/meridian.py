"""Experimental half-plane expansion driven directly by positive feedback cells.

Every active cell inserts 2*step mm at each of its two meridians. In the old
frame each side moves outward by step; rebasing the lower-left outline corner
adds a common translation. Footprints remain rigid. Fixed/locked centres are
intentionally moved: callers must opt into mechanically unconstrained studies.
"""
import bisect
import copy
import math
from pnr.graph import BoardGraph


def expand(graph, rules, feedback, *, pitch=2.5, step=.025):
    if not math.isfinite(step) or step<=0 or not math.isfinite(pitch) or pitch<=0:
        raise ValueError('pitch and step must be finite and positive')
    if graph.outline is None:raise ValueError('outline required')
    w,h=graph.outline.width,graph.outline.height
    active=[]
    for i,column in enumerate(feedback):
        for j,value in enumerate(column):
            if not math.isfinite(float(value)) or value<0:raise ValueError('invalid feedback')
            if value>0:
                x0,y0=i*pitch,j*pitch
                if x0>=w or y0>=h:raise ValueError('active feedback outside board')
                active.append(((x0+min(w,x0+pitch))/2,(y0+min(h,y0+pitch))/2))
    xs=sorted(x for x,y in active);ys=sorted(y for x,y in active);n=len(active)
    def axis(x,cuts):
        # sign(0)=0: an item exactly on a meridian stays put in the old frame.
        return x+step*(bisect.bisect_left(cuts,x)+bisect.bisect_right(cuts,x))
    def point(p):return (axis(p[0],xs),axis(p[1],ys))
    out=BoardGraph.from_json(graph.to_json());new_rules=copy.deepcopy(rules);moves={}
    for c in out.components:
        before=c.pos;c.pos=point(before)
        moves[c.ref]=dict(before=list(before),after=list(c.pos),
                         signed_displacement=[c.pos[k]-before[k]-n*step for k in (0,1)])
    out.outline.width=w+2*n*step;out.outline.height=h+2*n*step
    out.outline.polygon=[point(p) for p in out.outline.polygon]
    for hole in new_rules.get('mounting_holes',[]):hole['at']=list(point(hole['at']))
    # Anchored keepout shapes remain rigid and follow their parent footprint.
    # Old native pair witnesses cannot be carried across a placement change.
    new_rules.pop('routed_pair_references',None)
    event=dict(model='positive-cell-meridian-expansion-v1',active_cells=n,
               meridians=[list(p) for p in active],step_mm=step,pitch_mm=pitch,
               old_outline=[w,h],new_outline=[out.outline.width,out.outline.height],
               origin_translation=[n*step,n*step],moves=moves,
               mechanical_constraints_waived=True,
               feedback_weighting='binary positive cells; no magnitude weighting')
    return out,new_rules,event
