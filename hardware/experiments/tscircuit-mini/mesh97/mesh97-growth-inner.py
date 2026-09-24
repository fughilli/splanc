from pathlib import Path
import json,yaml,time,numpy as np
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.growth import propose_growth
from pnr.place.geometry import resolve_fixed_poses
from pnr.place.elastic import deform,project_collectively
from pnr.route.detail.router import route_board
from pnr.route.feedback import detail_congestion
from pnr.congestion_diagnostics import snapshot,write_snapshot
base=Path('output/fresh-pnr-20260919/mesh97-comparison');source=base/'elastic';history=json.loads((source/'progress.json').read_text())['history'][:3]
size,reason=propose_growth([x['missing'] for x in history],(70,55),(70,55),enabled=True)
if size is None:print(reason);raise SystemExit(0)
g=BoardGraph.from_json((source/'round-03/placed.json').read_text());original=BoardGraph.from_json(g.to_json())
g.outline.width,g.outline.height=size;g.outline.polygon=[(x*size[0]/70,y*size[1]/55) for x,y in g.outline.polygon]
raw=yaml.safe_load(Path('hardware/splanc_dev/mini-constraints.yaml').read_text());raw['board']['outline']={'w':size[0],'h':size[1]}
cc=compile_constraints(raw,g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads});fixed=resolve_fixed_poses(g,cc);fixed.update({c.ref:c.pos for c in g.components if c.locked})
for c in g.components:
 if c.ref not in fixed:c.pos=(c.pos[0]*size[0]/70,c.pos[1]*size[1]/55)
try:g=project_collectively(g,cc,fixed)
except Exception as error:
 print('affine seed rejected; preserving original centers before mesh:',str(error),flush=True)
 for c in g.components:c.pos=original.component(c.ref).pos
 g=project_collectively(g,cc,fixed)
rules=json.loads(Path('output/fresh-pnr-20260919/fresh-28-diagnostics/rules.json').read_text())
proposal=deform(g,cc,rules,{c.ref:2 for c in g.components},strength=2)
if proposal:g,_,event=proposal
else:event={}
event['moves']={c.ref:dict(before=list(original.component(c.ref).pos),after=list(c.pos)) for c in g.components if np.linalg.norm(np.array(c.pos)-original.component(c.ref).pos)>.01};event.update(outline_before=[70,55],outline_after=list(size),growth_reason=reason,mechanical_diagnostic_only=True)
p=base/'elastic-growth/round-04';p.mkdir(parents=True);(p/'placed.json').write_text(g.to_json());(p/'constraints.json').write_text(json.dumps(raw,indent=2));print('growth routing',size,len(event['moves']),flush=True)
t=time.monotonic();b=route_board(g,cc,rules,max_iters=12);missing=sum(max(1,b.result.nets[n].remaining_connections) for n in set(b.result.unrouted)-b.deferred_nets)
(p/'result.json').write_text(json.dumps(dict(estimated_missing_connections=missing,local_feedback_move=event,elapsed_seconds=time.monotonic()-t),indent=2));(p/'routes.json').write_text(json.dumps(dict(tracks=b.tracks,vias=b.vias,unrouted=b.result.unrouted,deferred=sorted(b.deferred_nets))))
write_snapshot(p,snapshot(g,rules,label='Mechanical diagnostic: 5% larger outline',cell=detail_congestion(b,g,*size,2.5),metadata=dict(summary=f'estimated missing signals {missing}',event=event)))
print('growth result',missing,flush=True)
