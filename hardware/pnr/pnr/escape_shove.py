"""Bounded local blocker rerouting with reserved signal escapes; no part moves.

Fixture arguments select pads, never alter net-specific rules. Existing vias,
external track endpoints, widths, and all prior pad connections are anchors.
"""
import argparse,json,math,itertools
from pathlib import Path
from collections import Counter
from pnr.geometric_tree import tree,point,elbows
from pnr.profile import span

def main():
 import pcbnew as k
 from pnr.native_electrical import Oracle,xy,uid,add_track,vec
 from pnr.via_coalesce import partition,preserved,touch
 from pnr.pad_entry import snapshot
 from pnr.electrical import net_policy
 ap=argparse.ArgumentParser();ap.add_argument('board');ap.add_argument('--rules',required=True);ap.add_argument('--pads',nargs='+',required=True);ap.add_argument('--out',required=True);ap.add_argument('--commit-escape',action='store_true');a=ap.parse_args();rules=json.load(open(a.rules));b=k.LoadBoard(a.board);b.BuildConnectivity();allpads=[p for f in b.GetFootprints() for p in f.Pads()];lookup={p.GetParentFootprint().GetReference()+'.'+p.GetNumber():p for p in allpads};targets=[lookup[p] for p in a.pads];layer=k.F_Cu;policies=[net_policy(p.GetNetname(),rules) for p in targets]
 if any(p['mode']!='signal' for p in policies):raise ValueError('Only ordinary signal escape reservations currently supported')
 before=partition(b);entries=snapshot(b,rules);center=tuple(sum(xy(p.GetPosition())[i] for p in targets)/len(targets) for i in (0,1));tracks=list(b.GetTracks());base=Oracle(b,rules);blockers=Counter();sites=[];diameter=rules['fab']['via_diameter_mm'];drill=rules['fab']['via_drill_mm']
 for pad,policy in zip(targets,policies):
  net=pad.GetNetname();start=xy(pad.GetPosition());width=policy['outer_width_mm'];options=[]
  for radius in (.8,1.2,1.6):
   for direction in range(8):
    angle=direction*math.pi/4;end=point((start[0]+radius*math.cos(angle),start[1]+radius*math.sin(angle)))
    if not base.via(net,end,diameter,drill):continue
    for path in elbows(start,end):
     hits_before=dict(base.hits);valid=all(base.clear(net,layer,x,y,width) for x,y in zip(path,path[1:]));hits=Counter(base.hits)-Counter(hits_before)
     blockers.update(hits);options.append(dict(net=net,path=path,end=end,width=width,blocked=not valid))
  sites.append(options)
 eligible={uid(t):t for t in tracks if t.GetClass()=='PCB_TRACK' and not t.IsLocked() and t.GetLayer()==layer}
 candidates=[]
 for identity,count in blockers.most_common():
  if identity not in eligible:continue
  hit=eligible[identity];net=hit.GetNetname()
  if net in {p.GetNetname() for p in targets}:continue
  group=[t for t in eligible.values() if t.GetNetname()==net and max(math.dist(xy(t.GetStart()),center),math.dist(xy(t.GetEnd()),center))<3.5]
  if not group or len({t.GetWidth() for t in group})!=1:continue
  if any(pair['p']==net or pair['n']==net for pair in rules.get('diff_pairs',[])):continue
  if any(c['net']==net for c in candidates):continue
  candidates.append(dict(net=net,items=group))
 diagnostics=dict(targets=a.pads,options=[len(x) for x in sites],blocker_nets=[c['net'] for c in candidates],trials=[]);solved=None
 for candidate in candidates:
  removed=candidate['items'];net=candidate['net'];width=removed[0].GetWidth()/1e6;old=[(xy(t.GetStart()),xy(t.GetEnd())) for t in removed];ends=Counter(point(p) for edge in old for p in edge);anchors=[p for p,n in ends.items() if n==1]
  for p in allpads+[t for t in tracks if t.GetClass()=='PCB_VIA']:
   if p.GetNetname()==net and p.IsOnLayer(layer) and any(touch(t,p,layer) for t in removed):anchors.append(xy(p.GetPosition()))
  for options in itertools.islice(itertools.product(*sites),120):
   oracle=Oracle(b,rules,ignored=[uid(t) for t in removed]);valid=True
   for option in options:
    if not oracle.via(option['net'],option['end'],diameter,drill) or not all(oracle.clear(option['net'],layer,x,y,option['width']) for x,y in zip(option['path'],option['path'][1:])):valid=False;break
    oracle.reserve_via(option['net'],option['end'],diameter,drill)
    for x,y in zip(option['path'],option['path'][1:]):oracle.reserve_track(option['net'],layer,x,y,option['width'])
   if not valid:continue
   seeds=list(old)
   for radius in (1.2,2.,2.8):
    corners=[(center[0]+sx*radius,center[1]+sy*radius) for sx,sy in [(-1,-1),(1,-1),(1,1),(-1,1)]]
    seeds.extend(zip(corners,corners[1:]+corners[:1]))
    for anchor in anchors:
     for corner in corners:
      for path in elbows(anchor,corner):seeds.extend(zip(path,path[1:]))
   with span('reserved_escape_blocker_tree'):new=tree(anchors,seeds,lambda x,y:oracle.clear(net,layer,x,y,width),max_nodes=300)
   diagnostics['trials'].append(dict(blocker=net,reserved=[o['end'] for o in options],routed=new is not None))
   if new is not None:solved=(candidate,new,options);break
  if solved:break
 if solved:
  candidate,new,options=solved;removed=candidate['items'];width=removed[0].GetWidth()/1e6
  for t in removed:b.Remove(t);t.thisown=False
  for x,y in new:
   t=add_track(b,candidate['net'],layer,x,y,width);t.thisown=False
  diagnostics['reservations']=options
  if a.commit_escape:
   for option in options:
    for x,y in zip(option['path'],option['path'][1:]):
     t=add_track(b,option['net'],layer,x,y,option['width']);t.thisown=False
    v=k.PCB_VIA(b);v.SetPosition(vec(option['end']));v.SetFrontWidth(round(diameter*1e6));v.SetDrill(round(drill*1e6));v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNetCode(b.FindNet(option['net']).GetNetCode());b.Add(v);v.thisown=False
  b.BuildConnectivity();after=snapshot(b,rules);diagnostics.update(preserved=preserved(before,partition(b)),lost_entries=[key for key,value in entries.items() if value and not after.get(key)],blocker=candidate['net'])
  if diagnostics['preserved'] and not diagnostics['lost_entries']:k.SaveBoard(a.out,b);diagnostics['status']='proposal_requires_native_refill_drc'
 else:diagnostics['status']='no_bounded_shove'
 Path(a.out+'.json').write_text(json.dumps(diagnostics,indent=2));print(json.dumps(diagnostics))
if __name__=='__main__':main()
