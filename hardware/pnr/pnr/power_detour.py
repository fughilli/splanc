"""Isolated same-width same-layer power-segment detour candidate generator.

No via/pad movement, no width reduction, no pair/plane changes. Endpoint/branch
preservation and all native guards required before testing signal closure.
"""
import json,math,time
from pathlib import Path

def shifted_path(a,b,focus,offset):
 dx,dy=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dy)
 if length<2*offset+.2:return None
 u=(dx/length,dy/length);n=(-u[1],u[0]);mid=((a[0]+b[0])/2,(a[1]+b[1])/2)
 if (mid[0]-focus[0])*n[0]+(mid[1]-focus[1])*n[1]<0:n=(-n[0],-n[1])
 return [a,(a[0]+offset*(n[0]+u[0]),a[1]+offset*(n[1]+u[1])),(b[0]+offset*(n[0]-u[0]),b[1]+offset*(n[1]-u[1])),b]

def distance_to_segment(p,a,b):
 d=(b[0]-a[0],b[1]-a[1]);ll=d[0]**2+d[1]**2
 if ll<1e-12:return math.dist(p,a),0
 t=max(0,min(1,((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/ll));q=(a[0]+t*d[0],a[1]+t*d[1]);return math.dist(p,q),t

def port_count(oracle,pad,rules):
 from pnr.native_electrical import xy
 from pnr.electrical import net_policy
 from pnr.route.detail.keyhole import elbows
 net=pad.GetNetname();p=xy(pad.GetPosition());width=net_policy(net,rules)['outer_width_mm'];la=pad.GetLayer();count=0;ports=[]
 for radius in (.5,.7,.9,1.1,1.4,1.8):
  for i in range(16):
   theta=i*math.pi/8;q=(round(p[0]+radius*math.cos(theta),6),round(p[1]+radius*math.sin(theta),6))
   if not any(all(oracle.clear(net,la,a,b,width) for a,b in zip(path,path[1:])) for path in elbows(p,q)):continue
   if oracle.via(net,q,.6,.3):count+=1;ports.append(q)
 return count,ports

def propose(board,pad,rules):
 from pnr.native_electrical import Oracle,uid,xy
 from pnr.electrical import net_policy
 start=xy(pad.GetPosition());oracle=Oracle(board,rules,deadline=time.monotonic()+90);initial,initial_ports=port_count(oracle,pad,rules);plans=[];considered=[];objects={uid(t):t for t in board.GetTracks()}
 for track in board.GetTracks():
  if track.GetClass()!='PCB_TRACK' or track.IsLocked() or track.GetLayer()!=pad.GetLayer() or track.GetNetCode()==pad.GetNetCode():continue
  if net_policy(track.GetNetname(),rules)['mode']!='power' or track.GetWidth()<400000:continue
  a,b=xy(track.GetStart()),xy(track.GetEnd());distance,fraction=distance_to_segment(start,a,b);width=track.GetWidth()/1e6
  if distance>width/2+1.5 or not .05<fraction<.95:continue
  for offset in (.25,.5,.75,1.,1.25):
   path=shifted_path(a,b,start,offset)
   if not path:continue
   o=Oracle(board,rules,ignored=[uid(track)],deadline=time.monotonic()+30)
   legal=all(o.clear(track.GetNetname(),track.GetLayer(),x,y,width) for x,y in zip(path,path[1:]));row=dict(track=uid(track),net=track.GetNetname(),width_mm=width,offset=offset,legal=legal,path=path)
   if legal:
    for x,y in zip(path,path[1:]):o.reserve_track(track.GetNetname(),track.GetLayer(),x,y,width)
    count,ports=port_count(o,pad,rules);row.update(ports=count,via_ports=ports)
    if count>initial:row.update(reopen=[],restoration_bounds=None);plans.append(row)
    else:
     # Physical access spans all crossed layers. Only non-protected ordinary
     # signal copper may be provisionally removed; actual router must restore it.
     hits={i:n for i,n in o.via_hits.items() if i in objects and not objects[i].IsLocked() and net_policy(objects[i].GetNetname(),rules)['mode']=='signal' and objects[i].GetNetname()!=pad.GetNetname()}
     nets={objects[i].GetNetname() for i in hits};scores={n:sum(v for i,v in hits.items() if objects[i].GetNetname()==n) for n in nets};reopen=sorted(nets,key=lambda n:(-scores[n],n))[:2]
     if reopen:
      removable=[t for t in objects.values() if t.GetNetname() in reopen and not t.IsLocked() and t.GetClass() in ('PCB_TRACK','PCB_VIA') and all(math.dist(start,xy(v))<=12 for v in (t.GetStart(),t.GetEnd()))]
      ignore=[uid(t) for t in removable];soft=Oracle(board,rules,ignored=[uid(track)]+ignore,deadline=time.monotonic()+30)
      for x,y in zip(path,path[1:]):soft.reserve_track(track.GetNetname(),track.GetLayer(),x,y,width)
      relaxed,ports=port_count(soft,pad,rules)
      points=[xy(v) for t in removable for v in (t.GetStart(),t.GetEnd())];box=[min(q[0] for q in points)-1,min(q[1] for q in points)-1,max(q[0] for q in points)+1,max(q[1] for q in points)+1] if points else None
      row.update(reopen=reopen,restoration_bounds=box,relaxed_ports=relaxed,relaxed_via_ports=ports,blocker_ids=sorted(hits))
      if relaxed>initial:plans.append(row)
   considered.append(row)
 return dict(baseline_ports=initial,baseline_via_ports=initial_ports,considered=considered,plans=sorted(plans,key=lambda x:(-x.get('relaxed_ports',x['ports']),len(x.get('reopen',[])),x['offset'])))

def execute(a,board,rules):
 import pcbnew as k
 from pnr.native_electrical import uid,vec,reference_failures
 from pnr.pad_entry import snapshot
 from pnr.via_coalesce import partition,preserved,acceptable
 from pnr.native_drc import run_drc
 ref,num=a.focus.rsplit('.',1);pad=next(p for f in board.GetFootprints() if f.GetReference()==ref for p in f.Pads() if p.GetNumber()==num);board.BuildConnectivity();result=propose(board,pad,rules);(a.out_dir/'proposals.json').write_text(json.dumps(result,indent=2))
 if a.probe_offset is not None:
  result['plans']=[x for x in result['considered'] if x['legal'] and abs(x['offset']-a.probe_offset)<1e-6]
 if not result['plans']:print(json.dumps(dict(status='no_improving_detour',baseline_ports=result['baseline_ports'],trials=len(result['considered']))));return
 if a.plan_only:print(json.dumps(dict(status='planned',plans=len(result['plans']))));return
 chosen=result['plans'][a.plan_index];track=next(t for t in board.GetTracks() if uid(t)==chosen['track']);original=partition(board);entries=snapshot(board,rules);before=run_drc(a.kicad_cli,a.board,a.out_dir/'baseline.drc.json');board.Remove(track)
 for p,q in zip(chosen['path'],chosen['path'][1:]):
  t=k.PCB_TRACK(board);t.SetNetCode(track.GetNetCode());t.SetLayer(track.GetLayer());t.SetWidth(track.GetWidth());t.SetStart(vec(p));t.SetEnd(vec(q));board.Add(t);t.thisown=False
 k.ZONE_FILLER(board).Fill(board.Zones());board.BuildConnectivity();dest=a.out_dir/'candidate.kicad_pcb';k.SaveBoard(str(dest),board)
 import shutil
 shutil.copy2(a.board.with_suffix('.kicad_pro'),dest.with_suffix('.kicad_pro'));table=a.board.parent/'fp-lib-table'
 if table.exists():(dest.parent/'fp-lib-table').write_text(table.read_text().replace('${KIPRJMOD}',str(table.parent.resolve())))
 after=run_drc(a.kicad_cli,dest,dest.with_suffix('.drc.json'));after_entries=snapshot(board,rules);checks=dict(preserved=preserved(original,partition(board)),lost_pad_entries=[i for i,v in entries.items() if v and not after_entries.get(i)],new_bad_entries=[i for i,v in after_entries.items() if not v and i not in entries],reference_failures=reference_failures(board,rules));guards=acceptable(before,after,checks) and not checks['new_bad_entries'] and not checks['reference_failures'] and len(after['unconnected_items'])<=len(before['unconnected_items'])
 result.update(accepted=False,guards_pass=bool(guards),status='needs_complete_signal_closure' if guards else 'native_guard_rejected',chosen=chosen,checks=checks,before_opens=len(before['unconnected_items']),after_opens=len(after['unconnected_items']));(a.out_dir/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:result[k] for k in ['guards_pass','status','before_opens','after_opens']}))

def main():
 import argparse,pcbnew as k
 p=argparse.ArgumentParser();p.add_argument('board',type=Path);p.add_argument('--rules',type=Path,required=True);p.add_argument('--focus',required=True);p.add_argument('--out-dir',type=Path,required=True);p.add_argument('--plan-only',action='store_true');p.add_argument('--probe-offset',type=float);p.add_argument('--plan-index',type=int,default=0);p.add_argument('--kicad-cli',default='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli');a=p.parse_args();a.out_dir.mkdir(exist_ok=False);board=k.LoadBoard(str(a.board));execute(a,board,json.loads(a.rules.read_text()))
if __name__=='__main__':main()
