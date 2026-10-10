from pathlib import Path
import json,yaml,time,sys,os,hashlib
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.elastic import deform
from pnr.route.detail.router import route_board
from pnr.route.feedback import detail_congestion,local_feedback_placement
from pnr.congestion_diagnostics import snapshot,write_snapshot
r=Path('output/fresh-pnr-20260919/fresh-28-diagnostics');g=BoardGraph.from_json((r/'round-01/placed.json').read_text());rules=json.loads((r/'rules.json').read_text());cc=compile_constraints(yaml.safe_load(Path('hardware/splanc_dev/mini-constraints.yaml').read_text()),g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
mode=sys.argv[1];out=Path('output/fresh-pnr-20260919/mesh97-comparison')/mode;out.mkdir(parents=True,exist_ok=True)
import numpy as np
accum=None;scale=None;best=10**6;history=[];stale=0;tried=set();start=time.monotonic()
for cycle in range(1,5):
 p=out/f'round-{cycle:02d}';p.mkdir();event=None
 if cycle>1:
  pressure={}
  for c in g.components:
   i=min(accum.shape[0]-1,max(0,int(c.pos[0]/2.5)));j=min(accum.shape[1]-1,max(0,int(c.pos[1]/2.5)))
   pressure[c.ref]=float(accum[max(0,i-1):i+2,max(0,j-1):j+2].max())/scale
  if mode=='elastic':proposal=deform(g,cc,rules,pressure,strength=min(8.,1.5**stale))
  else:proposal=local_feedback_placement(g,cc,rules,{k:1+v*.6 for k,v in pressure.items()},tried)
  if proposal is None:print('no legal proposal',cycle,flush=True);break
  g,_,event=proposal
 (p/'placed.json').write_text(g.to_json());tick=time.monotonic();print(mode,'routing cycle',cycle,'moved',len(event.get('moves',{})) if event else 0,flush=True)
 b=route_board(g,cc,rules,max_iters=12);missing=sum(max(1,b.result.nets[n].remaining_connections) for n in set(b.result.unrouted)-b.deferred_nets)
 cell=detail_congestion(b,g,70,55,2.5)
 if scale is None:scale=max(1.,float(cell.max()))
 accum=cell if accum is None else accum+cell
 stale=0 if missing<best else stale+1;best=min(best,missing)
 result=dict(cycle=cycle,estimated_missing_connections=missing,signal_unrouted=len(set(b.result.unrouted)-b.deferred_nets),deferred=sorted(b.deferred_nets),elapsed_seconds=time.monotonic()-tick,local_feedback_move=event,inflation_damping=0,placement_seed=None)
 (p/'result.json').write_text(json.dumps(result,indent=2));(p/'routes.json').write_text(json.dumps(dict(tracks=b.tracks,vias=b.vias,unrouted=b.result.unrouted,deferred=sorted(b.deferred_nets))))
 write_snapshot(p,snapshot(g,rules,label=f'{mode} cycle {cycle}',cell=cell,metadata=dict(summary=f'estimated missing signals {missing}',event=event)))
 history.append(dict(cycle=cycle,missing=missing,seconds=time.monotonic()-tick,move=event));(out/'progress.json').write_text(json.dumps(dict(history=history,best=best,elapsed_seconds=time.monotonic()-start),indent=2));print(mode,cycle,'missing',missing,'best',best,flush=True)
