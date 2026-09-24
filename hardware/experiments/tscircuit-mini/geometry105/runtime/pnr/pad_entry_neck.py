"""Complete a grazing power-pad branch using its explicit short-neck contract."""
import math

def repair_neck(board,pad,layer,touching,width,rules):
    import pcbnew as k
    from pnr.electrical import terminal_policy,neck_budget
    from pnr.native_electrical import Oracle,vec,xy
    from pnr.pad_entry import witness,neck_witness,closest
    if not rules.get('electrical_fab') or pad.GetShape()==k.PAD_SHAPE_CUSTOM:return None
    policy=terminal_policy(pad.GetParentFootprint().GetReference(),[pad.GetNumber()],pad.GetNetname(),rules)
    if not policy:return None
    oracle=Oracle(board,rules);center=xy(pad.GetPosition());net=pad.GetNetname()
    full=[t for t in touching if t.GetWidth()/1e6+1e-6>=width]
    minimum=max(min(xy(pad.GetSize())),rules.get('fab',{}).get('track_width_mm',.2))
    widths=sorted({minimum}|{i*.05 for i in range(math.ceil(minimum/.05),math.ceil(width/.05))})
    for distance in (.25,.35,.5):
        for narrow in widths:
            if narrow>=width:continue
            budget=neck_budget(policy,narrow,distance,rules['electrical_fab'])
            if not budget:continue
            for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                end=(center[0]+distance*dx,center[1]+distance*dy)
                if not oracle.clear(net,layer,center,end,narrow):continue
                for old in full:
                    q=closest(end,xy(old.GetStart()),xy(old.GetEnd()))
                    if math.dist(end,q)>1 or not oracle.clear(net,layer,end,q,width):continue
                    neck=k.PCB_TRACK(board);neck.SetLayer(layer);neck.SetNetCode(pad.GetNetCode());neck.SetStart(vec(center));neck.SetEnd(vec(end));neck.SetWidth(round(narrow*1e6))
                    feed=k.PCB_TRACK(board);feed.SetLayer(layer);feed.SetNetCode(pad.GetNetCode());feed.SetStart(vec(end));feed.SetEnd(vec(q));feed.SetWidth(round(width*1e6))
                    tracks=list(board.GetTracks())+[feed]
                    if not witness(pad,neck,narrow) or not neck_witness(pad,neck,width,tracks,rules):continue
                    additions=[neck]+([feed] if math.dist(end,q)>1e-6 else [])
                    for track in additions:board.Add(track);track.thisown=False
                    return dict(budget=budget,center=center,neck_end=end,full_feed_end=q,full_feed_width_mm=width)
    return None
