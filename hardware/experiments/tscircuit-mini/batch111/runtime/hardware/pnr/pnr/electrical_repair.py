"""Experimental atomic electrical route with restoration of a displaced signal.

Only signal-class unlocked straight segments wholly within the bounded region
may be removed. Every original pad partition and qualified pad contact must
survive the final native DRC transaction. Power/paired copper is never displaced.
"""
import argparse,json,math,shutil,subprocess,sys
from pathlib import Path
import pcbnew as k
from pnr.electrical import net_policy
from pnr.native_electrical import xy,uid
from pnr.pad_entry import snapshot
from pnr.via_coalesce import partition,preserved,acceptable

def candidates(board,net,bounds,rules):
    if net_policy(net,rules)['mode']!='signal':raise ValueError('Only signal blockers may be displaced')
    x0,y0,x1,y1=bounds
    return [t for t in board.GetTracks() if t.GetNetname()==net and t.GetClass()=='PCB_TRACK' and not t.IsLocked()
        and all(x0<=xy(p)[0]<=x1 and y0<=xy(p)[1]<=y1 for p in (t.GetStart(),t.GetEnd()))]

def restoration_pair(board,net,original):
    groups=partition(board);now={i:j for j,g in enumerate(groups) for i in g};old={i:j for j,g in enumerate(original) for i in g}
    pads=[p for f in board.GetFootprints() for p in f.Pads() if p.GetNetname()==net]
    pairs=[(math.dist(xy(p.GetPosition()),xy(q.GetPosition())),p,q) for i,p in enumerate(pads) for q in pads[i+1:]
        if old.get(uid(p))==old.get(uid(q)) and now.get(uid(p))!=now.get(uid(q))]
    return min(pairs,key=lambda x:x[0])[1:] if pairs else None

def save_board(board,src,dest):
    dest.parent.mkdir(parents=True,exist_ok=True);k.SaveBoard(str(dest),board)
    shutil.copyfile(src.with_suffix('.kicad_pro'),dest.with_suffix('.kicad_pro'))
    table=src.parent/'fp-lib-table'
    if table.exists():(dest.parent/'fp-lib-table').write_text(table.read_text().replace('${KIPRJMOD}',str(src.parent.resolve())))

def invoke(cmd,log):
    with log.open('w') as stream:subprocess.run(cmd,stdout=stream,stderr=stream,check=True)

def drc(path,out,cli):
    from pnr.native_drc import run_drc
    return run_drc(cli,path,out)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('board',type=Path);ap.add_argument('--rules',type=Path,required=True)
    ap.add_argument('--out-dir',type=Path,required=True);ap.add_argument('--blocker-net',required=True)
    ap.add_argument('--net',required=True);ap.add_argument('--source-pad',required=True);ap.add_argument('--target-pad',required=True)
    ap.add_argument('--source-pad-uuid');ap.add_argument('--target-pad-uuid')
    ap.add_argument('--bounds',type=float,nargs=4,required=True);ap.add_argument('--kicad-cli',required=True);ap.add_argument('--regional-adapter',required=True)
    ap.add_argument('--seconds',type=float,default=30);a=ap.parse_args();a.out_dir.mkdir();rules=json.loads(a.rules.read_text())
    b=k.LoadBoard(str(a.board));b.BuildConnectivity();original=partition(b);entries=snapshot(b,rules)
    before=drc(a.board,a.out_dir/'baseline.drc.json',a.kicad_cli)
    removed=candidates(b,a.blocker_net,a.bounds,rules)
    result=dict(accepted=False,removed=[uid(t) for t in removed],blocker=a.blocker_net)
    def finish(status):
        result['status']=status;(a.out_dir/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));return
    if not removed:return finish('no_local_signal_segments')
    for t in removed:b.Remove(t)
    b.BuildConnectivity();input_board=a.out_dir/'input.kicad_pcb';save_board(b,a.board,input_board)
    power=a.out_dir/'power'
    identities=[]
    for end in ('source','target'):
        identity=getattr(a,end+'_pad_uuid')
        if identity:identities+=['--'+end+'-pad-uuid',identity]
    invoke([sys.executable,'-m','pnr.native_electrical',str(input_board),'--rules',str(a.rules),'--out-dir',str(power),'--net',a.net,'--source-pad',a.source_pad,'--target-pad',a.target_pad,'--bounds',*map(str,a.bounds),'--seconds',str(a.seconds),'--kicad-cli',a.kicad_cli]+identities,a.out_dir/'power.log')
    outcome=json.loads((power/'result.json').read_text());result['power_status']=outcome['status']
    if not outcome.get('accepted'):return finish('electrical_route_failed')
    current=power/'candidate.kicad_pcb'
    for step in range(4):
        b=k.LoadBoard(str(current));b.BuildConnectivity();pair=restoration_pair(b,a.blocker_net,original)
        if not pair:break
        p,q=pair;coords=[xy(x.GetPosition()) for x in pair]
        bounds=[min(a.bounds[0],*(x[0]-2 for x in coords)),min(a.bounds[1],*(x[1]-2 for x in coords)),max(a.bounds[2],*(x[0]+2 for x in coords)),max(a.bounds[3],*(x[1]+2 for x in coords))]
        target=a.out_dir/f'signal-{step}'
        invoke([sys.executable,a.regional_adapter,str(current),'--out-dir',str(target),'--net',a.blocker_net,'--source-pad',p.GetParentFootprint().GetReference()+'.'+p.GetNumber(),'--target-pad',q.GetParentFootprint().GetReference()+'.'+q.GetNumber(),'--source-pad-uuid',uid(p),'--target-pad-uuid',uid(q),'--bounds',*map(str,bounds),'--pitch','.05','--layers','--joint','--relocate-vias','--max-seconds',str(a.seconds),'--rules',str(a.rules),'--kicad-cli',a.kicad_cli],a.out_dir/f'signal-{step}.log')
        if not json.loads((target/'result.json').read_text()).get('accepted'):return finish('signal_restore_failed')
        current=target/'candidate.kicad_pcb'
    b=k.LoadBoard(str(current));b.BuildConnectivity()
    current_drc=drc(current,a.out_dir/'precleanup.drc.json',a.kicad_cli)
    old_dangling={i['uuid'] for v in before['violations'] if v['type']=='via_dangling' for i in v['items']}
    stranded={i['uuid'] for v in current_drc['violations'] if v['type']=='via_dangling' for i in v['items']}-old_dangling
    wrappers=[t for t in b.GetTracks() if uid(t) in stranded and t.GetClass()=='PCB_VIA' and t.GetNetname()==a.blocker_net and not t.IsLocked()]
    for t in wrappers:b.Remove(t)
    result['removed_stranded_vias']=[uid(t) for t in wrappers]
    k.ZONE_FILLER(b).Fill(b.Zones());b.BuildConnectivity();out=a.out_dir/'candidate.kicad_pcb';save_board(b,a.board,out)
    after=drc(out,out.with_suffix('.drc.json'),a.kicad_cli);cur=snapshot(b,rules)
    checks=dict(preserved=preserved(original,partition(b)),lost_pad_entries=[i for i,v in entries.items() if v and not cur.get(i,False)],new_bad_entries=[i for i,v in cur.items() if not v and i not in entries])
    result.update(checks=checks,before_opens=len(before['unconnected_items']),after_opens=len(after['unconnected_items']))
    result['accepted']=acceptable(before,after,checks) and not checks['new_bad_entries'] and result['after_opens']<result['before_opens']
    finish('routed' if result['accepted'] else 'native_guard')
if __name__=='__main__':main()
