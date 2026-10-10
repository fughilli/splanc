from pathlib import Path
import json,yaml,time,sys,os,subprocess
import numpy as np
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.elastic import deform
from pnr.route.detail.router import route_board
from pnr.route.feedback import detail_congestion
from pnr.congestion_diagnostics import snapshot,write_snapshot
mode=sys.argv[1];root=Path('output/fresh-pnr-20260919/mesh98-comparison');out=root/mode;out.mkdir(parents=True)
g=BoardGraph.from_json(Path('output/fresh-pnr-20260919/mesh97-comparison/corrected-baseline/round-01/placed.json').read_text());rules=json.loads(Path('output/fresh-pnr-20260919/fresh-28-diagnostics/rules.json').read_text());cc=compile_constraints(yaml.safe_load(Path('hardware/splanc_dev/mini-constraints.yaml').read_text()),g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
accum=None;scale=None;best=10**6;history=[];stale=0
for cycle in range(1,4):
 p=out/f'round-{cycle:02d}';p.mkdir();event=None
 if cycle>1:
  pressure={}
  for c in g.components:
   i=min(accum.shape[0]-1,max(0,int(c.pos[0]/2.5)));j=min(accum.shape[1]-1,max(0,int(c.pos[1]/2.5)))
   pressure[c.ref]=float(accum[max(0,i-1):i+2,max(0,j-1):j+2].max())/scale
  proposal=deform(g,cc,rules,pressure,strength=min(8.,1.5**stale))
  if proposal is None:print('no legal proposal',cycle,flush=True);break
  g,_,event=proposal
 (p/'placed.json').write_text(g.to_json());tick=time.monotonic();print(mode,'routing',cycle,'moved',len(event['moves']) if event else 0,flush=True)
 b=route_board(g,cc,rules,max_iters=12);missing=sum(max(1,b.result.nets[n].remaining_connections) for n in set(b.result.unrouted)-b.deferred_nets)
 cell=detail_congestion(b,g,70,55,2.5)
 if scale is None:scale=max(1.,float(cell.max()))
 accum=cell if accum is None else accum+cell
 stale=0 if missing<best else stale+1;best=min(best,missing)
 result=dict(cycle=cycle,estimated_missing_connections=missing,local_feedback_move=event,elapsed_seconds=time.monotonic()-tick)
 (p/'routes.json').write_text(json.dumps(dict(tracks=b.tracks,vias=b.vias,unrouted=b.result.unrouted,deferred=sorted(b.deferred_nets))))
 if getattr(b,'pressure_events',None) is not None:(p/'pressure-events.json').write_text(json.dumps(b.pressure_events,indent=2))
 write_snapshot(p,snapshot(g,rules,label=f'{mode} cycle {cycle}',cell=cell,metadata=dict(summary=f'estimated missing signals {missing}',event=event)))
 # Publish result last: PDF watcher never sees half-written snapshots.
 (p/'result.json').write_text(json.dumps(result,indent=2));history.append(result)
 (out/'progress.json').write_text(json.dumps(dict(history=history,best=best),indent=2));print(mode,cycle,'missing',missing,'best',best,flush=True)
