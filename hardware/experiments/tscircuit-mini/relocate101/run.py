"""Constrained, fixed-outline relocation experiment. Pogo XY alone is released."""
from pathlib import Path
import json,shutil,time,yaml
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.relocate import propose
from pnr.route.detail.router import route_board
from pnr.route.feedback import detail_congestion
from pnr.congestion_diagnostics import snapshot,write_snapshot
base=Path('output/fresh-pnr-20260919');source=base/'fresh-29-diagnostics';root=base/'relocate101';out=root/'relocation';out.mkdir(parents=True,exist_ok=False)
g=BoardGraph.from_json((source/'round-01/placed.json').read_text());rules=json.loads((source/'rules.json').read_text());rules.pop('routed_pair_references',None)
attributes=json.loads((base/'relocate100/native-smd-attributes.json').read_text())
for c in g.components:c.smd_body=attributes[c.ref]
raw=yaml.safe_load(Path('hardware/splanc_dev/mini-constraints.yaml').read_text());released=raw['fixed'].pop('@board.eol');(root/'constraints.yaml').write_text(yaml.safe_dump(raw,sort_keys=False));(root/'constraint-change.json').write_text(json.dumps(dict(selector='@board.eol',previous= released,release='XY only; translation-only candidates preserve pad geometry, bottom side and rotation; all other constraints unchanged'),indent=2))
cc=compile_constraints(raw,g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
routes=json.loads((source/'round-01/routes.json').read_text());tried=set();history=[]
for cycle in range(1,3):
 p=out/f'round-{cycle:02d}';p.mkdir();event=None;t=time.monotonic()
 if cycle>1:
  # First challenge specifically isolates the user-identified pogo placement;
  # following cycle opens candidate selection to all eligible components.
  result=propose(g,cc,rules,routes['tracks'],routes['vias'],tried=tried,refs=[c.ref for c in g.components if c.address=='board.eol'],max_parts=1,shortlist=10000)
  if result is None:print('no improving proposal',cycle,flush=True);p.rmdir();break
  g,_,event=result;print('proposal',cycle,json.dumps(event['moves']),event['cost_before'],event['cost_after'],flush=True)
 (p/'placed.json').write_text(g.to_json());(p/'rules.json').write_text(json.dumps(rules,indent=2))
 for name in ('source.kicad_pcb','source.kicad_pro'):shutil.copyfile(source/name,p/name)
 if cycle==1:
  original=source/'round-01';missing=json.loads((original/'result.json').read_text())['estimated_missing_connections'];shutil.copyfile(original/'congestion.json',p/'congestion.json');shutil.copyfile(original/'congestion.svg',p/'congestion.svg');shutil.copyfile(original/'pressure-events.json',p/'pressure-events.json')
 else:
  print('routing',cycle,flush=True);b=route_board(g,cc,rules,max_iters=12)
  missing=sum(max(1,b.result.nets[n].remaining_connections) for n in set(b.result.unrouted)-b.deferred_nets)
  routes=dict(tracks=b.tracks,vias=b.vias,unrouted=b.result.unrouted,deferred=sorted(b.deferred_nets))
  (p/'pressure-events.json').write_text(json.dumps(b.pressure_events,indent=2));cell=detail_congestion(b,g,70,55,2.5)
  write_snapshot(p,snapshot(g,rules,label=f'Relocation cycle {cycle}',cell=cell,metadata=dict(summary=f'missing signals {missing}; fixed outline; pogo XY released',event=event)))
 (p/'routes.json').write_text(json.dumps(routes));result=dict(cycle=cycle,estimated_missing_connections=missing,local_feedback_move=event,elapsed_seconds=time.monotonic()-t,outline=[70,55],scope='early signal diagnostic; deferred electrical nets require full native stages')
 (p/'result.json').write_text(json.dumps(result,indent=2));history.append(result);(root/'progress.json').write_text(json.dumps(history,indent=2));print('completed',cycle,missing,flush=True)
