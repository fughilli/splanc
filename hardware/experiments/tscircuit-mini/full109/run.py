"""Full-phase, collision-aware batch Monte Carlo placement search."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import argparse,json,shutil,subprocess,random,math,time,yaml,os
from pnr.live import emit
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.batch_relocate import propose_batches
from pnr.place.anneal import Plateau

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--k',type=int,default=4);ap.add_argument('--n',type=int,default=4);ap.add_argument('--samples',type=int,default=4);ap.add_argument('--workers',type=int,default=2);ap.add_argument('--iterations',type=int,default=48);a=ap.parse_args()
 base=Path('output/fresh-pnr-20260919');root=base/'full109';out=root/'relocation';out.mkdir(parents=True,exist_ok=False)
 os.environ['PNR_LIVE_DIR']=str((root/'live').resolve())
 os.environ['PNR_PROFILE_DIR']=str((root/'profiles').resolve())
 os.environ['PNR_SEARCH_BACKEND']='rust'
 os.environ['PNR_SINGLE_TRACK_WORKERS']='2'
 os.environ['OMP_NUM_THREADS']='1'
 os.environ['OPENBLAS_NUM_THREADS']='1'
 os.environ['MKL_NUM_THREADS']='1'
 from pnr.runtime_controls import read,write
 control=root/'live/control.json';os.environ['PNR_CONTROL_FILE']=str(control.resolve())
 if not control.exists():write(control,dict(route_workers=2,candidate_workers=a.workers,samples=a.samples,k=a.k,n=a.n))
 active_revision=None
 os.environ['PNR_RUST_SEARCH_LIB']=str((root/'runtime/libpnr_search.dylib').resolve())
 from pnr.route.detail.rust_search import library
 library()
 source=base/'relocate101/relocation/round-02';raw=yaml.safe_load((base/'relocate101/constraints.yaml').read_text());(root/'constraints.yaml').write_text(yaml.safe_dump(raw))
 g=BoardGraph.from_json((source/'placed.json').read_text());rules=json.loads((source/'rules.json').read_text());routes={};feedback={}
 cc=compile_constraints(raw,g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
 rng=random.Random(104);schedule=Plateau();history=[];reason='iteration_budget_exhausted';best=None;incumbent=None;best_iteration=1;started=time.monotonic()
 def evaluate(p,graph):
  lane=f"r{iteration:02}/{p.name}"
  emit("candidate_start",candidate=lane,data=dict(phase="placement"))
  env=dict(os.environ,PNR_LIVE_CANDIDATE=lane)
  p.mkdir(parents=True);(p/'placed.json').write_text(graph.to_json());(p/'rules.json').write_text(json.dumps(rules))
  for name in ('source.kicad_pcb','source.kicad_pro'):shutil.copy2(source/name,p/name)
  with (p/'evaluation.log').open('w') as log:
   subprocess.run(['python3','/private/tmp/pnr-runtime.py','-m','pnr.profile','--label','full-iteration','--module','pnr.full_iteration',str(p),'--constraints',str(root/'constraints.yaml'),'--geometric-relax'],stdout=log,stderr=subprocess.STDOUT,check=True,env=env)
  return json.loads((p/'evaluation.json').read_text())
 for iteration in range(1,a.iterations+1):
  requested=read(control)
  if requested['revision']!=active_revision:
   if active_revision is not None:schedule=Plateau(best=best if best is not None else math.inf)
   active_revision=requested['revision'];values=requested['values'];a.workers=values['candidate_workers'];a.samples=values['samples'];a.k=values['k'];a.n=values['n']
  os.environ['PNR_CANDIDATE_WORKERS']=str(a.workers)
  emit('controls_applied',candidate=f'r{iteration:02}/search',data=dict(**requested,boundary='placement-round',round=iteration))
  os.environ['PNR_LIVE_ITERATION']=str(iteration);os.environ['PNR_LIVE_CANDIDATE']=f'r{iteration:02}/search'
  folder=out/f'round-{iteration:02}';folder.mkdir();temp=schedule.temperature
  if iteration==1:choices=[dict(graph=g,moves=[],cost=0)];audit=dict(held_out=[],alternatives=[],probes=[])
  else:
   attempts=[]
   for attempt in range(8):
    choices,audit=propose_batches(g,cc,rules,routes['tracks'],routes['vias'],k=a.k,n=a.n,samples=a.samples,pressure=feedback['component_scores'],rng=rng,temperature=temp)
    attempts.append(audit)
    if choices:break
   (folder/'batch-attempts.json').write_text(json.dumps(attempts,indent=2))
   if not choices:
    reason='joint_candidate_pool_exhausted';emit('search_exhausted',data=dict(attempts=len(attempts)));break
  (folder/'placement-decision.json').write_text(json.dumps(audit,indent=2));print('iteration',iteration,'joint candidates',len(choices),'held out',audit['held_out'],flush=True)
  paths=[folder/'alternatives'/f'candidate-{j:02}' for j in range(len(choices))]
  for p,c in zip(paths,choices):emit('candidate_queued',candidate=f'r{iteration:02}/{p.name}',layout=json.loads(c['graph'].to_json()),data=dict(moves=c['moves'],cost=c['cost'],temperature=temp))
  with ThreadPoolExecutor(max_workers=a.workers) as pool:
   futures=[pool.submit(evaluate,p,c['graph']) for p,c in zip(paths,choices)]
   evaluated=[]
   for p,f in zip(paths,futures):
    try:evaluated.append(f.result())
    except Exception as ex:
     emit('candidate_failed',candidate=f'r{iteration:02}/{p.name}',data=dict(error=str(ex)));raise
  scores=[tuple(e['objective']) for e in evaluated];winner=min(range(len(scores)),key=lambda i:scores[i]);quality=scores[winner];chosen=paths[winner]
  if iteration==1:best=incumbent=quality;accepted=True;schedule.best=quality
  else:
   probability=1. if quality<=incumbent else (math.exp(-(quality[-1]-incumbent[-1])/max(1e-9,temp*50)) if temp and quality[:-1]==incumbent[:-1] else 0.)
   accepted=quality[0]==0 and rng.random()<probability
   if quality<best:best=quality;best_iteration=iteration
   schedule.observe(quality)
  if accepted:
   incumbent=quality;g=BoardGraph.from_json((chosen/'evaluated-placed.json').read_text());rules=json.loads((chosen/'evaluated-rules.json').read_text());routes=json.loads((chosen/'evaluated-routes.json').read_text());feedback=json.loads((chosen/'feedback.json').read_text())
   if routes['unsupported']:raise RuntimeError('unsupported copper for next placement probes')
  # Present the candidate actually scored, retaining all alternatives separately.
  shutil.copytree(chosen/'phases',folder/'phases')
  for name in ('feedback.json','evaluation.json','placed.json'):shutil.copy2(chosen/name,folder/name)
  final=folder/'phases/09-final-audit'
  for name in ('diagnostic.kicad_pcb','diagnostic.kicad_pro','diagnostic.drc.json','fp-lib-table'):
   if (final/name).exists():shutil.copy2(final/name,folder/name)
  record=dict(controls=requested,cycle=iteration,native_opens=quality[-1],native_violations=quality[0],objective=quality,best_native_opens=best[-1],best_objective=best,best_round=best_iteration,accepted=accepted,temperature=temp,plateau=asdict(schedule),all_phases_completed=True,score_scope='post-electrical-final-refill',selected_alternative=winner,alternatives=[dict(path=str(p),objective=e['objective'],qualified=e['qualified'],moves=c['moves']) for p,e,c in zip(paths,evaluated,choices)],local_feedback_move=dict(moves=choices[winner]['moves']))
  (folder/'result.json').write_text(json.dumps(record,indent=2));history.append(record);(root/'progress.json').write_text(json.dumps(history,indent=2));print('completed',iteration,quality,'best',best,flush=True)
  emit('iteration_complete',candidate=f'r{iteration:02}/{chosen.name}',data=record)
  if schedule.reached:reason='observed_plateau';break
  if time.monotonic()-started>172800:reason='time_budget_exhausted';break
 emit('run_complete',data=dict(reason=reason,plateau_observed=schedule.reached,completed_rounds=len(history),best_objective=best))
 (root/'termination.json').write_text(json.dumps(dict(reason=reason,plateau_observed=schedule.reached,completed_rounds=len(history),best_round=best_iteration,best_objective=best,seed=104,schedule=asdict(schedule),score_scope='post-electrical-final-refill',batch=vars(a)),indent=2))
if __name__=='__main__':main()
