"""Native guarded whole-net single-layer tree proposals for ordinary signals."""
import json,math,argparse
from pathlib import Path
from pnr.geometric_tree import tree,length
from pnr.profile import span

def propose(board,rules,net,layer):
 import pcbnew as k
 from pnr.native_electrical import Oracle,uid,xy
 from pnr.via_coalesce import protected,touch
 excluded,_=protected(board,rules,['hardware/splanc_dev/elec/src/splanc_mini.ato'])
 from pnr.electrical import net_policy
 if net in excluded or net_policy(net,rules)['mode']!='signal':return dict(skipped='source current/width/plane/pair/array protection')
 tracks=[t for t in board.GetTracks() if t.GetNetname()==net and t.IsOnLayer(layer) and t.GetClass()!='PCB_VIA']
 if not tracks or any(t.IsLocked() or t.GetClass()!='PCB_TRACK' for t in tracks):return dict(skipped='locked/unsupported copper')
 widths={t.GetWidth() for t in tracks}
 if len(widths)!=1:return dict(skipped='mixed width tree needs current-aware edge sizing')
 width=next(iter(widths))/1e6;old=[(xy(t.GetStart()),xy(t.GetEnd())) for t in tracks]
 pads=[p for f in board.GetFootprints() for p in f.Pads()];vias=[t for t in board.GetTracks() if t.GetClass()=='PCB_VIA'];anchors=[]
 for p in pads+vias:
  if p.GetNetname()==net and p.IsOnLayer(layer) and any(touch(t,p,layer) for t in tracks):anchors.append(xy(p.GetPosition()))
 if len(set(anchors))<2:return dict(skipped='insufficient anchored terminals')
 with span('native_obstacle_index'):oracle=Oracle(board,rules,ignored=[uid(t) for t in tracks])
 with span('visibility_tree_search'):new=tree(anchors,old,lambda a,b:oracle.clear(net,layer,a,b,width))
 if new is None:return dict(skipped='no anchored replacement tree',anchors=anchors,segments=len(old),obstacle_hits=dict(oracle.hits))
 if length(new)>=length(old)-.02:return dict(skipped='no geometric improvement',before_mm=length(old),after_mm=length(new))
 return dict(net=net,layer=layer,width_mm=width,remove=[uid(t) for t in tracks],edges=new,before_mm=length(old),after_mm=length(new),anchors=anchors)

def main():
 import pcbnew as k
 from pnr.native_electrical import uid,add_track
 from pnr.via_coalesce import partition,preserved
 from pnr.pad_entry import snapshot
 ap=argparse.ArgumentParser();ap.add_argument('board');ap.add_argument('--rules',required=True);ap.add_argument('--net');ap.add_argument('--layer',default='B.Cu');ap.add_argument('--out',required=True);ap.add_argument('--inventory',action='store_true');a=ap.parse_args();rules=json.load(open(a.rules));b=k.LoadBoard(a.board);b.BuildConnectivity();
 if a.inventory:
  from pnr.via_coalesce import protected
  from collections import Counter
  excluded,_=protected(b,rules,['hardware/splanc_dev/elec/src/splanc_mini.ato']);counts=Counter((t.GetNetname(),t.GetLayerName()) for t in b.GetTracks() if t.GetClass()=='PCB_TRACK' and not t.IsLocked() and t.GetNetname() not in excluded)
  Path(a.out).write_text(json.dumps([dict(net=n,layer=la,segments=c) for (n,la),c in counts.most_common() if c>2]));return
 if not a.net:raise ValueError('--net required outside inventory mode')
 before=partition(b);entries=snapshot(b,rules)
 result=propose(b,rules,a.net,b.GetLayerID(a.layer))
 if 'edges' in result:
  removed=[t for t in b.GetTracks() if uid(t) in result['remove']]
  for t in removed:b.Remove(t);t.thisown=False
  for x,y in result['edges']:
   t=add_track(b,a.net,result['layer'],x,y,result['width_mm']);t.thisown=False
  b.BuildConnectivity();after=snapshot(b,rules);result['connectivity_preserved']=preserved(before,partition(b));result['lost_pad_entries']=[key for key,v in entries.items() if v and not after.get(key,False)]
  if not result['connectivity_preserved'] or result['lost_pad_entries']:result['rejected']='connectivity/pad-entry guard'
  else:k.SaveBoard(a.out,b)
 Path(a.out+'.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
if __name__=='__main__':main()
