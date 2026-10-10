"""Full-phase, collision-aware batch Monte Carlo placement search."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import argparse,json,shutil,subprocess,random,math,time,yaml,os,sys
from pnr.live import emit
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.batch_relocate import propose_batches
from pnr.place.anneal import Plateau

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--k',type=int,default=4);ap.add_argument('--n',type=int,default=4);ap.add_argument('--samples',type=int,default=4);ap.add_argument('--workers',type=int,default=2);ap.add_argument('--iterations',type=int,default=48);a=ap.parse_args()
 base=Path('output/fresh-pnr-20260919');root=Path(os.environ['PNR_RUN_ROOT']);out=root/'relocation';out.mkdir(parents=True,exist_ok=True)
 os.environ['PNR_LIVE_DIR']=str((root/'live').resolve())
 os.environ['PNR_PROFILE_DIR']=str((root/'profiles').resolve())
 os.environ['PNR_SEARCH_BACKEND']='rust'
 os.environ['PNR_SINGLE_TRACK_WORKERS']='2'
 os.environ['OMP_NUM_THREADS']='1'
 os.environ['OPENBLAS_NUM_THREADS']='1'
 os.environ['MKL_NUM_THREADS']='1'
 from pnr.runtime_controls import read,write
 control=root/'live/control.json';os.environ['PNR_CONTROL_FILE']=str(control.resolve())
 sys.path.insert(0,str(Path('hardware/tools/pnr_live').resolve()))
 from settings import seed
 seed(control,Path('output/pnr-settings.json'))
 active_revision=None;epoch=read(control).get('restart_epoch',0)
 os.environ['PNR_RUST_SEARCH_LIB']=str((root/'runtime/libpnr_search.dylib').resolve())
 from pnr.route.detail.rust_search import library
 library()
 source=root/'seed';raw=yaml.safe_load((root/'constraints.yaml').read_text())
 g=BoardGraph.from_json((source/'placed.json').read_text());rules=json.loads((source/'rules.json').read_text());routes={};feedback={}
 cc=compile_constraints(raw,g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
 rng=random.Random(116+epoch);schedule=Plateau();history=json.loads((root/'progress.json').read_text()) if (root/'progress.json').exists() else [];reason='iteration_budget_exhausted';best=None;incumbent=None;best_iteration=1;started=time.monotonic()
 if history:
  best=tuple(history[-1]['best_objective']);best_iteration=history[-1]['best_round']
  previous=next(record for record in reversed(history) if record['accepted'])
  incumbent=tuple(previous['objective']);chosen=out/f"round-{previous['cycle']:02d}"/'alternatives'/f"candidate-{previous['selected_alternative']:02d}"
  g=BoardGraph.from_json((chosen/'evaluated-placed.json').read_text());rules=json.loads((chosen/'evaluated-rules.json').read_text());routes=json.loads((chosen/'evaluated-routes.json').read_text());feedback=json.loads((chosen/'feedback.json').read_text())
  schedule=Plateau(best=best)
 (root/'restart-context.json').write_text(json.dumps(dict(epoch=epoch,seed=116+epoch,resume_round=len(history)+1,completed_rounds_retained=len(history)),indent=2))
 if os.environ.get('PNR_RESTART_PREFLIGHT')=='1':return
 seed_board=None
 if history:seed_board=chosen/'electrical/board.kicad_pcb'
 def evaluate(p,graph):
  lane=f"r{iteration:02}e{epoch}/{p.name}"
  emit("candidate_start",candidate=lane,data=dict(phase="placement"))
  env=dict(os.environ,PNR_LIVE_CANDIDATE=lane)
  p.mkdir(parents=True);(p/'placed.json').write_text(graph.to_json());(p/'rules.json').write_text(json.dumps(rules))
  for ext in ('.kicad_pcb','.kicad_pro'):shutil.copy2(seed_board.with_suffix(ext) if seed_board else source/('source'+ext),p/('source'+ext))
  if seed_board and (seed_board.parent/'fp-lib-table').exists():(p/'fp-lib-table').write_text((seed_board.parent/'fp-lib-table').read_text().replace('${KIPRJMOD}',str(seed_board.parent.resolve())))
  with (p/'evaluation.log').open('w') as log:
   subprocess.run(['python3',str(Path(__file__).with_name('runtime.py').resolve()),'-m','pnr.profile','--label','full-iteration','--module','pnr.full_iteration',str(p),'--constraints',str(root/'constraints.yaml'),'--geometric-relax','--annotation-source',str(root/'source-freeze/hardware/splanc_dev/elec/src/splanc_mini.ato'),'--electrical-fab',str(root/'source-freeze/hardware/splanc_dev/mini-routing-electrical-fab.json'),'--plane-fab',str(root/'source-freeze/hardware/splanc_dev/mini-plane-access-fab.json'),*(['--incremental'] if seed_board else [])],stdout=log,stderr=subprocess.STDOUT,check=True,env=env)
  return json.loads((p/'evaluation.json').read_text())
 for iteration in range(len(history)+1,a.iterations+1):
  if shutil.disk_usage(root).free < 15*1024**3:
   reason='disk_space_safety_limit';break
  requested=read(control)
  if requested['revision']!=active_revision:
   if active_revision is not None:schedule=Plateau(best=best if best is not None else math.inf)
   active_revision=requested['revision'];values=requested['values'];a.workers=values['candidate_workers'];a.samples=values['samples'];a.k=values['k'];a.n=values['n']
  os.environ['PNR_CANDIDATE_WORKERS']=str(a.workers)
  emit('controls_applied',candidate=f'r{iteration:02}e{epoch}/search',data=dict(**requested,boundary='placement-round',round=iteration))
  os.environ['PNR_LIVE_ITERATION']=str(iteration);os.environ['PNR_LIVE_CANDIDATE']=f'r{iteration:02}e{epoch}/search'
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
  for p,c in zip(paths,choices):emit('candidate_queued',candidate=f'r{iteration:02}e{epoch}/{p.name}',layout=json.loads(c['graph'].to_json()),data=dict(moves=c['moves'],cost=c['cost'],temperature=temp))
  with ThreadPoolExecutor(max_workers=a.workers) as pool:
   futures=[pool.submit(evaluate,p,c['graph']) for p,c in zip(paths,choices)]
   evaluated=[]
   for p,f in zip(paths,futures):
    try:evaluated.append(f.result())
    except Exception as ex:
     emit('candidate_failed',candidate=f'r{iteration:02}e{epoch}/{p.name}',data=dict(error=str(ex)));evaluated.append(None)
  completed=[(p,c,e) for p,c,e in zip(paths,choices,evaluated) if e is not None]
  if not completed:
   reason='all_candidates_failed';break
  paths,choices,evaluated=map(list,zip(*completed))
  scores=[tuple(e['objective']) for e in evaluated];winner=min(range(len(scores)),key=lambda i:(not evaluated[i].get('guard_valid',True),scores[i]));quality=scores[winner];chosen=paths[winner]
  if iteration==1:
   if not evaluated[winner].get('guard_valid',True):
    reason='baseline_guard_failure';break
   best=incumbent=quality;accepted=True;schedule.best=quality
  else:
   probability=1. if quality<=incumbent else (math.exp(-(quality[-1]-incumbent[-1])/max(1e-9,temp*50)) if temp and quality[:-1]==incumbent[:-1] else 0.)
   accepted=evaluated[winner].get('guard_valid',True) and quality[0]==0 and rng.random()<probability
   if evaluated[winner].get('guard_valid',True) and quality<best:best=quality;best_iteration=iteration
   schedule.observe(quality if evaluated[winner].get('guard_valid',True) else incumbent)
  if accepted:
   seed_board=chosen/'electrical/board.kicad_pcb'
   incumbent=quality;g=BoardGraph.from_json((chosen/'evaluated-placed.json').read_text());rules=json.loads((chosen/'evaluated-rules.json').read_text());routes=json.loads((chosen/'evaluated-routes.json').read_text());feedback=json.loads((chosen/'feedback.json').read_text())
   if routes['unsupported']:raise RuntimeError('unsupported copper for next placement probes')
  # Present the candidate actually scored, retaining all alternatives separately.
  shutil.copytree(chosen/'phases',folder/'phases')
  for name in ('feedback.json','evaluation.json','placed.json'):shutil.copy2(chosen/name,folder/name)
  final=folder/'phases/09-final-audit'
  for name in ('diagnostic.kicad_pcb','diagnostic.kicad_pro','diagnostic.drc.json','fp-lib-table'):
   if (final/name).exists():shutil.copy2(final/name,folder/name)
  record=dict(controls=requested,cycle=iteration,native_opens=quality[-1],native_violations=quality[0],objective=quality,best_native_opens=best[-1],best_objective=best,best_round=best_iteration,accepted=accepted,temperature=temp,plateau=asdict(schedule),all_phases_completed=True,score_scope='post-electrical-final-refill',selected_alternative=int(chosen.name.rsplit('-',1)[1]),alternatives=[dict(path=str(p),objective=e['objective'],qualified=e['qualified'],moves=c['moves']) for p,e,c in zip(paths,evaluated,choices)],local_feedback_move=dict(moves=choices[winner]['moves']))
  (folder/'result.json').write_text(json.dumps(record,indent=2));history.append(record);(root/'progress.json').write_text(json.dumps(history,indent=2));print('completed',iteration,quality,'best',best,flush=True)
  emit('iteration_complete',candidate=f'r{iteration:02}e{epoch}/{chosen.name}',data=record)
  if schedule.reached:reason='observed_plateau';break
  if time.monotonic()-started>172800:reason='time_budget_exhausted';break
 emit('run_complete',data=dict(reason=reason,plateau_observed=schedule.reached,completed_rounds=len(history),best_objective=best))
 (root/'termination.json').write_text(json.dumps(dict(reason=reason,plateau_observed=schedule.reached,completed_rounds=len(history),best_round=best_iteration,best_objective=best,seed=116+epoch,schedule=asdict(schedule),score_scope='post-electrical-final-refill',batch=vars(a)),indent=2))
if __name__=='__main__':main()
