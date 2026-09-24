"""Local copper invalidation for a candidate cloned from an accepted board."""
import argparse,json,shutil,hashlib
from pathlib import Path

def apply(board,graph,rules):
 import pcbnew as k
 from pnr.ingest import build_graph
 from pnr.plane_access import uid
 from pnr.via_coalesce import touch,copper_layers
 from pnr.electrical import net_policy
 from pnr.merge_additive import signature
 old=build_graph(board);previous={c.ref:c for c in old.components};desired={c.ref:c for c in graph.components}
 if abs(old.outline.width-graph.outline.width)>.001 or abs(old.outline.height-graph.outline.height)>.001:raise ValueError('Incremental placement requires unchanged outline')
 fps={f.GetReference():f for f in board.GetFootprints()};layers=copper_layers(board)
 moved=[ref for ref,c in desired.items() if ref in previous and (sum((a-b)**2 for a,b in zip(c.pos,previous[ref].pos))>1e-10 or c.rot!=previous[ref].rot or c.side!=previous[ref].side)]
 protected={i['ref'] for i in rules.get('plane_access_intents',[]) if i['kind']=='power_array'}|{i['ref'] for i in rules.get('copper_keepouts',[])}
 if protected&set(moved):raise ValueError('Cannot independently move source-owned array/keepout')
 for ref in moved:
  if desired[ref].locked or previous[ref].locked:raise ValueError('Locked placement '+ref)
 pads=[p for f in board.GetFootprints() for p in f.Pads()];moving=[p for ref in moved for p in fps[ref].Pads()];stationary=[p for p in pads if p not in moving]
 tracks=list(board.GetTracks());before={uid(t):signature(t) for t in tracks};removed={};keep=[]
 def touches(a,b):
  return a.GetBoundingBox().Intersects(b.GetBoundingBox()) and any(touch(a,b,la) for la in layers)
 # Peel the moved-pad leaf back to its first shared copper junction or fixed pad.
 # A through-via with multiple surviving layer branches is a junction too.
 seeds=[t for t in tracks if any(t.GetNetCode()==p.GetNetCode() and touches(t,p) for p in moving)]
 affected={t.GetNetCode() for t in seeds};adj={uid(t):[] for t in tracks if t.GetNetCode() in affected}
 relevant=[t for t in tracks if uid(t) in adj]
 anchors={uid(t):sum(p.GetNetCode()==t.GetNetCode() and touches(t,p) for p in stationary) for t in relevant}
 for i,t in enumerate(relevant):
  for z in relevant[i+1:]:
   if t.GetNetCode()==z.GetNetCode() and touches(t,z):adj[uid(t)].append(z);adj[uid(z)].append(t)
 queue=list(seeds)
 while queue:
  t=queue.pop();u=uid(t)
  if u in removed or t.IsLocked():continue
  neighbors=[z for z in adj[u] if uid(z) not in removed]
  if len(neighbors)+anchors[u]>1:continue
  removed[u]='moved_pad_branch';queue.extend(neighbors)
 # Translate in the existing native frame; no writeback, layer reset or outline rewrite.
 for ref in moved:
  f=fps[ref];c=desired[ref];o=previous[ref]
  if c.side!=o.side: f.Flip(f.GetPosition(),False)
  f.SetPosition(f.GetPosition()+k.VECTOR2I(round((c.pos[0]-o.pos[0])*1e6),round((o.pos[1]-c.pos[1])*1e6)))
  f.SetOrientationDegrees(float(c.rot))
 # Pads and holes own clearance, not the footprint's whole body/courtyard.
 for t in tracks:
  if uid(t) in removed:continue
  for p in moving:
   gap=round((max(net_policy(t.GetNetname(),rules)['clearance_mm'],net_policy(p.GetNetname(),rules)['clearance_mm'])+.001)*1e6)
   collision=any(t.IsOnLayer(la) and p.IsOnLayer(la) and t.GetNetCode()!=p.GetNetCode() and t.GetEffectiveShape(la).Collide(p.GetEffectiveShape(la),gap) for la in layers)
   if p.GetDrillSize().x:
    collision=collision or any(t.IsOnLayer(la) and t.GetEffectiveShape(la).Collide(p.GetEffectiveHoleShape(),gap) for la in layers)
   if collision:
    if t.IsLocked():raise ValueError('Destination conflicts with locked copper')
    removed[uid(t)]='destination_clearance';break
 touched_nets={t.GetNetname() for t in tracks if uid(t) in removed}|{p.GetNetname() for p in moving}
 invalid_pairs=[p for p in rules.get('diff_pairs',[]) if touched_nets&{p['p'],p['n']}]
 paired={n for p in invalid_pairs for n in (p['p'],p['n'])}
 for t in tracks:
  if t.GetNetname() in paired:
   if t.IsLocked():raise ValueError('Affected pair contains locked copper')
   removed[uid(t)]='coupled_pair'
 # Source-owned current arrays must survive local invalidation intact.
 for intent in rules.get('plane_access_intents',[]):
  if intent['kind']!='power_array' or intent['ref'] not in fps:continue
  f=fps[intent['ref']];radius=round((intent.get('max_array_span_mm',3)+1)*1e6)
  for t in tracks:
   if uid(t) in removed and t.GetClass()=='PCB_VIA' and t.GetNetname()==intent['net'] and any((t.GetPosition()-p.GetPosition()).EuclideanNorm()<=radius for p in f.Pads() if p.GetNumber() in intent['pads']):raise ValueError('Move conflicts with source-sized via array')
 for t in tracks:
  if uid(t) in removed:board.Remove(t);keep.append(t)
 board.BuildConnectivity();k.ZONE_FILLER(board).Fill(board.Zones());board.BuildConnectivity()
 after={uid(t):signature(t) for t in board.GetTracks()}
 assert all(after.get(u)==s for u,s in before.items() if u not in removed),'Unaffected copper changed'
 rules['routed_pair_references']=[r for r in rules.get('routed_pair_references',[]) if r['pair'] not in {p['name'] for p in invalid_pairs}]
 return dict(moved=moved,before_tracks=len(before),retained_tracks=len(after),removed=removed,invalidated_pairs=[p['name'] for p in invalid_pairs])

def main():
 import pcbnew as k
 from pnr.graph import BoardGraph
 p=argparse.ArgumentParser();p.add_argument('board',type=Path);p.add_argument('graph',type=Path);p.add_argument('--rules',required=True,type=Path);p.add_argument('--out',required=True,type=Path);p.add_argument('--report',required=True,type=Path);a=p.parse_args()
 b=k.LoadBoard(str(a.board));rules=json.loads(a.rules.read_text());report=apply(b,BoardGraph.from_json(a.graph.read_text()),rules)
 a.out.parent.mkdir(parents=True,exist_ok=True);k.SaveBoard(str(a.out),b);shutil.copy2(a.board.with_suffix('.kicad_pro'),a.out.with_suffix('.kicad_pro'))
 if (a.board.parent/'fp-lib-table').exists():(a.out.parent/'fp-lib-table').write_text((a.board.parent/'fp-lib-table').read_text().replace('${KIPRJMOD}',str(a.board.parent.resolve())))
 a.rules.write_text(json.dumps(rules,indent=2));report['source_sha256']=hashlib.sha256(a.board.read_bytes()).hexdigest();a.report.write_text(json.dumps(report,indent=2))
if __name__=='__main__':main()
