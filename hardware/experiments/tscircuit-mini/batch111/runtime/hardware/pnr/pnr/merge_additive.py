"""Apply additive track/via delta; caller MUST refill and run native gates."""
import argparse,json,shutil
from pathlib import Path

def signature(t):
    if t.GetClass()=='PCB_VIA':
        return (t.GetClass(),t.GetNetname(),t.GetPosition().x,t.GetPosition().y,t.TopLayer(),t.BottomLayer(),t.GetDrillValue(),int(t.GetViaType()),tuple((la,t.GetWidth(la)) for la in t.GetBoard().GetEnabledLayers().CuStack()))
    if t.GetClass()!='PCB_TRACK':raise ValueError('unsupported copper')
    return (t.GetClass(),t.GetNetname(),t.GetLayer(),t.GetWidth(),t.GetStart().x,t.GetStart().y,t.GetEnd().x,t.GetEnd().y)

def additions(base,proposal,current):
    for identity,shape in base.items():
        if proposal.get(identity)!=shape:raise ValueError('proposal changed existing copper')
        if current.get(identity)!=shape:raise ValueError('base copper stale')
    for identity in proposal.keys() & current.keys():
        if proposal[identity]!=current[identity]:raise ValueError('UUID collision')
    return sorted(proposal.keys()-current.keys())

def main():
    import pcbnew
    ap=argparse.ArgumentParser();ap.add_argument('base',type=Path);ap.add_argument('proposal',type=Path);ap.add_argument('current',type=Path);ap.add_argument('out',type=Path);a=ap.parse_args()
    boards=[pcbnew.LoadBoard(str(p)) for p in (a.base,a.proposal,a.current)]
    maps=[{t.m_Uuid.AsString():t for t in b.GetTracks()} for b in boards]
    poses=lambda b:sorted((f.m_Uuid.AsString(),f.GetPosition().x,f.GetPosition().y,f.GetOrientationDegrees(),f.GetLayer()) for f in b.GetFootprints())
    if poses(boards[0])!=poses(boards[1]) or poses(boards[0])!=poses(boards[2]):raise ValueError('placement changed')
    delta=additions(*[{k:signature(v) for k,v in m.items()} for m in maps]);current=boards[2]
    for identity in delta:
        source=maps[1][identity];net=current.FindNet(source.GetNetname())
        if net is None:raise ValueError('unknown net')
        if source.GetClass()=='PCB_VIA':
            t=pcbnew.PCB_VIA(current);t.SetPosition(source.GetPosition());t.SetViaType(source.GetViaType());t.SetLayerPair(source.TopLayer(),source.BottomLayer());t.SetDrill(source.GetDrillValue())
            for la in current.GetEnabledLayers().CuStack():t.SetWidth(la,source.GetWidth(la))
        else:
            t=pcbnew.PCB_TRACK(current);t.SetStart(source.GetStart());t.SetEnd(source.GetEnd());t.SetLayer(source.GetLayer());t.SetWidth(source.GetWidth())
        t.SetNetCode(net.GetNetCode())
        if signature(t)!=signature(source):raise ValueError('geometry changed in native copy')
        current.Add(t);t.thisown=False
    a.out.parent.mkdir(parents=True,exist_ok=True);pcbnew.SaveBoard(str(a.out),current)
    shutil.copy2(a.current.with_suffix('.kicad_pro'),a.out.with_suffix('.kicad_pro'))
    table=a.current.parent/'fp-lib-table'
    if table.exists():(a.out.parent/'fp-lib-table').write_text(table.read_text().replace('${KIPRJMOD}',str(a.current.parent.resolve())))
    print(json.dumps(dict(added=len(delta),requires_native_validation=True)))
if __name__=='__main__':main()
