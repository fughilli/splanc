"""Native pad/copper collision ranking for legal placement proposals.

Ranking only: terminal tethers, connectivity, entries and DRC are still checked
by the enclosing placement/routing transaction. No copper or pose is saved.
"""
import math
from pnr.electrical import net_policy
from pnr.native_electrical import Oracle,uid


def rank_native_copper(board,rules,candidates):
    import pcbnew as k
    oracle=Oracle(board,rules)
    footprints={f.GetReference():f for f in board.GetFootprints()}
    out=[]
    for index,candidate in enumerate(candidates):
        footprint=footprints[candidate['ref']]
        original=footprint.GetPosition()
        own={uid(p) for p in footprint.Pads()}
        blocked=set()
        try:
            footprint.SetPosition(original+k.VECTOR2I(round(candidate['dx']*1e6),round(candidate['dy']*1e6)))
            for pad in footprint.Pads():
                net=pad.GetNetname();gap=net_policy(net,rules)['clearance_mm']+.001
                box=pad.GetBoundingBox()
                for layer in oracle.layers:
                    if not pad.IsOnLayer(layer):continue
                    shape=pad.GetEffectiveShape(layer);indices=set()
                    for x in range(math.floor(box.GetLeft()/1e6)-1,math.floor(box.GetRight()/1e6)+2):
                        for y in range(math.floor(box.GetTop()/1e6)-1,math.floor(box.GetBottom()/1e6)+2):
                            indices.update(oracle.buckets[layer,x,y])
                    for i in indices:
                        obstacle,clearance,other,identity=oracle.obstacles[i]
                        if identity in own or (net and net==other):continue
                        if shape.Collide(obstacle,round(max(gap,clearance)*1e6)):
                            blocked.add((uid(pad),identity))
        finally:
            footprint.SetPosition(original)
        out.append(dict(candidate,native_pad_collisions=len(blocked),native_blockers=sorted({i for _,i in blocked}),proposal_order=index))
    return sorted(out,key=lambda c:(c['native_pad_collisions'],c['proposal_order']))
