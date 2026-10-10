"""Four-cycle mechanically unconstrained positive-cell expansion experiment."""
from pathlib import Path
import json,time,shutil
import numpy as np
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.meridian import expand
from pnr.route.detail.router import route_board
from pnr.route.feedback import detail_congestion
from pnr.congestion_diagnostics import snapshot,write_snapshot
base=Path('output/fresh-pnr-20260919');root=base/'meridian99';out=root/'expansion';out.mkdir(parents=True)
source=base/'fresh-29-diagnostics';initial=source/'round-01'
g=BoardGraph.from_json((initial/'placed.json').read_text());rules=json.loads((source/'rules.json').read_text());rules.pop('routed_pair_references',None)
cell=np.array(json.loads((initial/'congestion.json').read_text())['feedback_cell']);history=[]
for cycle in range(1,5):
 p=out/f'round-{cycle:02d}';p.mkdir();event=None;t=time.monotonic()
 if cycle>1:g,rules,event=expand(g,rules,cell,step=.025)
 (p/'placed.json').write_text(g.to_json());(p/'rules.json').write_text(json.dumps(rules,indent=2));shutil.copyfile(source/'source.kicad_pcb',p/'source.kicad_pcb');shutil.copyfile(source/'source.kicad_pro',p/'source.kicad_pro')
 print('routing',cycle,'outline',g.outline.width,g.outline.height,flush=True)
 if cycle==1:
  r=json.loads((initial/'result.json').read_text());missing=r['estimated_missing_connections'];shutil.copyfile(initial/'routes.json',p/'routes.json');shutil.copyfile(initial/'pressure-events.json',p/'pressure-events.json')
 else:
  cc=compile_constraints({'board':{'outline':{'w':g.outline.width,'h':g.outline.height}}},g.refs)
  b=route_board(g,cc,rules,max_iters=12);missing=sum(max(1,b.result.nets[n].remaining_connections) for n in set(b.result.unrouted)-b.deferred_nets);cell=detail_congestion(b,g,g.outline.width,g.outline.height,2.5)
  (p/'routes.json').write_text(json.dumps(dict(tracks=b.tracks,vias=b.vias,unrouted=b.result.unrouted,deferred=sorted(b.deferred_nets))))
  (p/'pressure-events.json').write_text(json.dumps(b.pressure_events,indent=2))
 result=dict(cycle=cycle,estimated_missing_connections=missing,local_feedback_move=event,elapsed_seconds=time.monotonic()-t,outline=[g.outline.width,g.outline.height],area_ratio=g.outline.width*g.outline.height/(70*55),positive_cells=int(np.count_nonzero(cell>0)),mechanical_constraints_waived=True)
 write_snapshot(p,snapshot(g,rules,label=f'Meridian expansion cycle {cycle}',cell=cell,metadata=dict(summary=f'missing signals {missing}; outline {g.outline.width:.2f} x {g.outline.height:.2f} mm',event=event)))
 (p/'result.json').write_text(json.dumps(result,indent=2));history.append(result);(root/'progress.json').write_text(json.dumps(history,indent=2));print('completed',cycle,'missing',missing,'positive cells',result['positive_cells'],flush=True)
