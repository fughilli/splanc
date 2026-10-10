"""Identify displaceable copper at constrained terminal exits."""
import math

def suggest(board,rules,target,excluded=(),limit=2):
    import pcbnew as k
    from pnr.native_electrical import Oracle,xy,uid
    from pnr.electrical import net_policy
    from pnr.pad_identity import resolve_pad
    if net_policy(target['net'],rules)['mode']!='signal':
        return dict(reopen=[],endpoints=[],scores={},reason='protected_target')
    oracle=Oracle(board,rules);items={uid(t):t for t in oracle.items};scores={};endpoints=[]
    for end in ('source','target'):
        pad=resolve_pad(board,target[end],target.get(end+'_uuid'))
        point=xy(pad.GetPosition());oracle.hits.clear();clear_count=0
        surface=k.B_Cu if pad.IsOnLayer(k.B_Cu) and not pad.IsOnLayer(k.F_Cu) else k.F_Cu
        for radius in (.5,1.,1.5):
            for angle in range(0,360,15):
                q=(point[0]+radius*math.cos(math.radians(angle)),point[1]+radius*math.sin(math.radians(angle)))
                clear_count+=bool(oracle.clear(pad.GetNetname(),surface,point,q,.2))
        hits={}
        for identity,count in oracle.hits.items():
            item=items.get(identity)
            if item is None or item.GetClass() not in ('PCB_TRACK','PCB_VIA') or item.IsLocked():continue
            net=item.GetNetname()
            if net==target['net'] or net in excluded or net_policy(net,rules)['mode']!='signal':continue
            hits[net]=hits.get(net,0)+count
        for net,count in hits.items():scores[net]=scores.get(net,0)+count/(1+clear_count)
        endpoints.append(dict(pad=target[end],clear_rays=clear_count,signal_hits=hits))
    return dict(reopen=sorted(scores,key=lambda n:(-scores[n],n))[:limit],endpoints=endpoints,scores=scores)
