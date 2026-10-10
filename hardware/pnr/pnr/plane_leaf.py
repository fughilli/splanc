"""Isolated prototype: shorten single-pad, single-via ordinary plane returns.

Protected source arrays/returns, shared islands, plated pads, locked copper and
barrels with any other layer track port are excluded. Current geometry cannot
be narrowed. Native connectivity, entries, filled reference and DRC gate output.
"""
import argparse,json,math,shutil,time,sys
from pathlib import Path

def eligible(board,pad,rules,protected_pads=()):
 import pcbnew as k
 from pnr.plane_access import surface_group
 from pnr.native_electrical import uid
 from pnr.electrical import net_policy
 if uid(pad) in protected_pads or pad.IsLocked() or pad.GetAttribute()!=k.PAD_ATTRIB_SMD:return None
 policy=net_policy(pad.GetNetname(),rules)
 if policy['mode']!='plane':return None
 layer=k.F_Cu if pad.IsOnLayer(k.F_Cu) else k.B_Cu
 group=surface_group(board,[pad],layer);pads=[t for t in group if t.GetClass()=='PAD'];vias=[t for t in group if t.GetClass()=='PCB_VIA'];tracks=[t for t in group if t.GetClass()=='PCB_TRACK']
 if len(vias)!=1 or not tracks or len(group)!=len(pads)+len(vias)+len(tracks):return None
 shared=len(pads)>1
 if shared:
  # Walk only a simple centre-anchored leaf to the first existing barrel.
  # Keep the other pad branches and their barrel in place.
  point=lambda p:(p.x,p.y)
  start=point(pad.GetPosition());end=point(vias[0].GetPosition());node=start;chain=[];seen=set()
  while node!=end:
   options=[t for t in tracks if uid(t) not in seen and node in (point(t.GetStart()),point(t.GetEnd()))]
   if len(options)!=1:return None
   t=options[0];chain.append(t);seen.add(uid(t));node=point(t.GetEnd()) if node==point(t.GetStart()) else point(t.GetStart())
   if any(uid(other)!=uid(pad) and t.GetEffectiveShape(layer).Collide(other.GetEffectiveShape(layer),0) for other in pads):return None
   if len(chain)>32:return None
  tracks=chain
 via=vias[0]
 if any(t.IsLocked() for t in group) or via.GetViaType()!=k.VIATYPE_THROUGH:return None
 # No current pooling or widening/narrowing assumptions at branch junctions.
 if len({t.GetWidth() for t in tracks})!=1:return None
 for t in board.GetTracks():
  if t.GetClass()=='PCB_TRACK' and t.GetLayer()!=layer and t.GetNetCode()==via.GetNetCode() and t.GetEffectiveShape(t.GetLayer()).Collide(via.GetEffectiveShape(t.GetLayer()),0):return None
 return dict(pad=pad,via=via,tracks=tracks,layer=layer,width=tracks[0].GetWidth()/1e6,old_length=sum(t.GetLength()/1e6 for t in tracks),shared=shared)

def plan(board,leaf,rules):
 from pnr.native_electrical import Oracle,uid,xy
 from pnr.route.detail.keyhole import elbows,legal,length
 p,v=leaf['pad'],leaf['via'];start=xy(p.GetPosition());net=p.GetNetname();layer=leaf['layer'];width=leaf['width'];diameter=v.GetWidth(layer)/1e6;drill=v.GetDrill()/1e6
 oracle=Oracle(board,rules,ignored=[uid(t) for t in leaf['tracks']]+([] if leaf['shared'] else [uid(v)]),deadline=time.monotonic()+20)
 choices=[]
 for radius in (.5,.6,.75,1.,1.25,1.5,2.):
  for dx,dy in [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)]:
   q=(round(start[0]+radius*dx,6),round(start[1]+radius*dy,6))
   if math.dist(start,q)>=leaf['old_length']-1e-6:continue
   if not oracle.via(net,q,diameter,drill):continue
   for path in elbows(start,q):
    if legal(path,lambda a,z:oracle.clear(net,layer,a,z,width)):
     choices.append(dict(path=path,length=length(path),via=q));break
 if not choices:return None
 return min(choices,key=lambda c:(c['length'],len(c['path']),c['via']))

def execute(a,rules,b):
 import pcbnew as k
 from pnr.native_electrical import uid,vec,reference_failures
 from pnr.pad_entry import snapshot
 from pnr.via_coalesce import partition,preserved,acceptable,protected
 from pnr.native_drc import run_drc
 from pnr.live import emit
 b.BuildConnectivity();_,intents=protected(b,rules,a.annotation_source);protect={(i['ref'],str(n)) for i in intents for n in i['pads']};pads=[p for f in b.GetFootprints() for p in f.Pads()];protected_ids={uid(p) for p in pads if (p.GetParentFootprint().GetReference(),p.GetNumber()) in protect};before_part=partition(b);before_entry=snapshot(b,rules);cli='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli';before=run_drc(cli,a.board,a.out_dir/'baseline.drc.json');result=dict(accepted=False,focus=a.focus,proposals=[]);leaves=[]
 for p in pads:
  if p.GetParentFootprint().GetReference()!=a.focus:continue
  leaf=eligible(b,p,rules,protected_ids)
  if leaf:
   proposal=plan(b,leaf,rules)
   result['proposals'].append(dict(pad=p.GetNumber(),net=p.GetNetname(),old_length=leaf['old_length'],plan=proposal))
   if proposal:leaves.append((leaf,proposal))
 if not leaves:result['status']='no_shorter_isolated_leaf'
 else:
  # One transactional leaf per invocation; rerun inventory after acceptance.
  leaf,proposal=min(leaves,key=lambda x:x[1]['length']-x[0]['old_length']);via=leaf['via'];oldvia=(via.GetPosition().x/1e6,via.GetPosition().y/1e6)
  for t in leaf['tracks']:b.Remove(t)
  if leaf['shared']:
   new=k.PCB_VIA(b);new.SetNetCode(via.GetNetCode());new.SetWidth(via.GetWidth(leaf['layer']));new.SetDrill(via.GetDrill());new.SetViaType(k.VIATYPE_THROUGH);new.SetLayerPair(k.F_Cu,k.B_Cu);new.SetPosition(vec(proposal['via']));b.Add(new);new.thisown=False;via=new
  else:via.SetPosition(vec(proposal['via']))
  for p,q in zip(proposal['path'],proposal['path'][1:]):
   if math.dist(p,q)<1e-7:continue
   t=k.PCB_TRACK(b);t.SetLayer(leaf['layer']);t.SetNetCode(leaf['pad'].GetNetCode());t.SetWidth(round(leaf['width']*1e6));t.SetStart(vec(p));t.SetEnd(vec(q));b.Add(t);t.thisown=False
  k.ZONE_FILLER(b).Fill(b.Zones());b.BuildConnectivity();out=a.out_dir/'candidate.kicad_pcb';k.SaveBoard(str(out),b);shutil.copy2(a.board.with_suffix('.kicad_pro'),out.with_suffix('.kicad_pro'))
  if (a.board.parent/'fp-lib-table').exists():(out.parent/'fp-lib-table').write_text((a.board.parent/'fp-lib-table').read_text().replace('${KIPRJMOD}',str(a.board.parent.resolve())))
  after=run_drc(cli,out,a.out_dir/'candidate.drc.json');entry=snapshot(b,rules);checks=dict(preserved=preserved(before_part,partition(b)),lost_pad_entries=[u for u,good in before_entry.items() if good and not entry.get(u)],new_bad_entries=[u for u,good in entry.items() if not good and u not in before_entry],reference_failures=reference_failures(b,rules))
  result.update(status='native_guard',before_opens=len(before['unconnected_items']),after_opens=len(after['unconnected_items']),before_violations=len(before['violations']),after_violations=len(after['violations']),checks=checks,old_length=leaf['old_length'],new_length=proposal['length'],old_via=oldvia,new_via=proposal['via'],removed_tracks=[uid(t) for t in leaf['tracks']],via_uuid=uid(via),width_mm=leaf['width'],added_vias=int(leaf['shared']))
  result['guards_pass']=bool(acceptable(before,after,checks) and not checks['new_bad_entries'] and not checks['reference_failures'] and result['after_opens']<=result['before_opens'] and result['new_length']<result['old_length'])
  result['accepted']=result['guards_pass'] and not leaf['shared']
  result['status']='needs_signal_closure_before_acceptance' if leaf['shared'] else result['status']
  emit('phase_complete',board=out,data=dict(name='ordinary plane leaf relocation',native_opens=result['after_opens'],accepted=result['accepted'],review='pending',result=result))
 (a.out_dir/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
def main():
 import pcbnew as k
 # Keep the owning board in this caller until execute releases every borrowed
 # pad/track/connectivity wrapper. KiCad 10 SWIG locals may otherwise outlive it.
 ap=argparse.ArgumentParser();ap.add_argument('board',type=Path);ap.add_argument('--rules',type=Path,required=True);ap.add_argument('--annotation-source',type=Path,action='append',default=[]);ap.add_argument('--focus',required=True);ap.add_argument('--out-dir',type=Path,required=True);a=ap.parse_args();a.out_dir.mkdir(exist_ok=False);rules=json.loads(a.rules.read_text());board=k.LoadBoard(str(a.board))
 execute(a,rules,board)

if __name__=='__main__':main()
