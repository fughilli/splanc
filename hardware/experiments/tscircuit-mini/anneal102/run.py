"""Annealed relocation to an observed native-connectivity plateau."""
from pathlib import Path
import json,shutil,time,yaml,random,math,subprocess
from dataclasses import asdict
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.relocate import propose
from pnr.place.anneal import Plateau
from pnr.route.detail.router import route_board
from pnr.route.feedback import detail_congestion
from pnr.congestion_diagnostics import snapshot,write_snapshot
base=Path('output/fresh-pnr-20260919'); root=base/'anneal102'; out=root/'relocation';out.mkdir(parents=True,exist_ok=False)
source=base/'relocate101/relocation/round-02'
g=BoardGraph.from_json((source/'placed.json').read_text());rules=json.loads((source/'rules.json').read_text());routes=json.loads((source/'routes.json').read_text())
raw=yaml.safe_load((base/'relocate101/constraints.yaml').read_text());(root/'constraints.yaml').write_text(yaml.safe_dump(raw));cc=compile_constraints(raw,g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
rng=random.Random(102); schedule=Plateau();tried=set();history=[]; incumbent=200; best=200;best_round=1;start=time.monotonic();termination='round_budget_exhausted'
for cycle in range(1,49):
 if time.monotonic()-start>14400:termination='time_budget_exhausted';break
 p=out/f'round-{cycle:02}';p.mkdir();t=time.monotonic();temp=schedule.temperature;event=None
 if cycle==1:
  for f in source.iterdir():
   if f.is_file():shutil.copy2(f,p/f.name)
  missing=49;opens=200;violations=0;accepted=True
 else:
  candidate=propose(g,cc,rules,routes['tracks'],routes['vias'],tried=tried,temperature=temp,rng=rng,max_parts=6)
  if candidate is None:
   # No proposal is not a routed observation and cannot satisfy plateau.
   p.rmdir();termination='candidate_pool_exhausted';break
  trial,_,event=candidate
  print('proposal',cycle,'temperature',temp,event['moves'],flush=True)
  (p/'placed.json').write_text(trial.to_json());(p/'rules.json').write_text(json.dumps(rules))
  for name in ('source.kicad_pcb','source.kicad_pro'):shutil.copy2(source/name,p/name)
  b=route_board(trial,cc,rules,max_iters=12)
  missing=sum(max(1,b.result.nets[n].remaining_connections) for n in set(b.result.unrouted)-b.deferred_nets)
  trial_routes=dict(tracks=b.tracks,vias=b.vias,unrouted=b.result.unrouted,deferred=sorted(b.deferred_nets))
  (p/'routes.json').write_text(json.dumps(trial_routes));(p/'pressure-events.json').write_text(json.dumps(b.pressure_events))
  write_snapshot(p,snapshot(trial,rules,label=f'Annealed relocation {cycle}',cell=detail_congestion(b,trial,70,55,2.5),metadata=dict(summary=f'missing signals {missing}; temperature {temp:.3f}',event=event)))
  subprocess.run(['python3','hardware/experiments/tscircuit-mini/relocate100/native_diagnostic.py',str(p)],check=True)
  drc=json.loads((p/'diagnostic.drc.json').read_text());opens=len(drc['unconnected_items']);violations=len(drc['violations'])
  probability=1. if opens<=incumbent else (math.exp(-(opens-incumbent)/max(1e-9,50*temp)) if temp else 0.)
  accepted=violations==0 and rng.random()<probability
  if accepted:g,routes,incumbent=trial,trial_routes,opens
  if violations==0 and opens<best:best,best_round=opens,cycle
  schedule.observe(opens if violations==0 else math.inf)
 # Seed best without consuming a scheduled exploration trial.
 if cycle==1:schedule.best=200
 record=dict(cycle=cycle,estimated_missing_connections=missing,native_opens=opens,native_violations=violations,accepted=accepted,best_native_opens=best,best_round=best_round,temperature=temp,plateau=asdict(schedule),local_feedback_move=event,elapsed_seconds=time.monotonic()-t,outline=[70,55],scope='early signal diagnostic; native power/USB completion deferred')
 (p/'result.json').write_text(json.dumps(record,indent=2));history.append(record)
 (root/'progress.json').write_text(json.dumps(history,indent=2));print('completed',cycle,opens,violations,'best',best,'cold_stale',schedule.cold_stale,flush=True)
 if schedule.reached:termination='observed_plateau';break
(root/'termination.json').write_text(json.dumps(dict(reason=termination,plateau_observed=schedule.reached,best_round=best_round,best_native_opens=best,completed_rounds=len(history),seed=102,schedule=asdict(schedule),scope='finite sampled plateau; not proof of global optimum'),indent=2))
print('terminated',termination,flush=True)
