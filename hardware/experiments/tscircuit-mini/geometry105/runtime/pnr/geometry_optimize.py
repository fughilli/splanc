"""Transactional geometry cleanup phase; native refill/DRC gates each tree."""
import argparse,json,os,sys,subprocess,shutil
from pathlib import Path
from pnr.native_drc import run_drc
from pnr.live import emit
from pnr.profile import span

def main():
 ap=argparse.ArgumentParser();ap.add_argument('board',type=Path);ap.add_argument('--rules',required=True,type=Path);ap.add_argument('--out-dir',required=True,type=Path);ap.add_argument('--limit',type=int,default=8);ap.add_argument('--cli',default='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli');a=ap.parse_args();a.out_dir.mkdir(parents=True,exist_ok=False);env=dict(os.environ,PYTHONPATH=str(Path(__file__).resolve().parent.parent));current=a.board.resolve();events=[]
 def run(module,args,log):
  with log.open('w') as out:subprocess.run([sys.executable,'-m','pnr.profile','--label',module,'--module',module,*map(str,args)],env=env,stdout=out,stderr=subprocess.STDOUT,check=True)
 with span('native_drc_initial'):before=run_drc(a.cli,current,a.out_dir/'initial.drc.json')
 run('pnr.geometric_native',[current,'--rules',a.rules,'--out',a.out_dir/'inventory.json','--inventory'],a.out_dir/'inventory.log');jobs=json.loads((a.out_dir/'inventory.json').read_text())[:a.limit]
 for i,job in enumerate(jobs):
  folder=a.out_dir/f'trial-{i:03}';folder.mkdir();trial=folder/'candidate.kicad_pcb';emit('phase_start',board=current,data=dict(phase='geometry-tree',**job))
  run('pnr.geometric_native',[current,'--rules',a.rules,'--net',job['net'],'--layer',job['layer'],'--out',trial],folder/'search.log');result=json.loads(Path(str(trial)+'.json').read_text());accepted=False
  if trial.exists():
   shutil.copy2(current.with_suffix('.kicad_pro'),trial.with_suffix('.kicad_pro'))
   table=current.parent/'fp-lib-table'
   if table.exists():shutil.copy2(table,folder/'fp-lib-table')
   run('pnr.planes',[trial,'--rules',a.rules,'--refill-only'],folder/'fill.log')
   with span('native_drc_candidate'):after=run_drc(a.cli,trial,folder/'drc.json')
   accepted=not after['violations'] and len(after['unconnected_items'])<=len(before['unconnected_items'])
   if accepted:current=trial;before=after
  events.append(dict(job=job,result=result,accepted=accepted));emit('geometry_result',board=current,data=dict(phase='geometry-tree',accepted=accepted,**job))
  (a.out_dir/'progress.json').write_text(json.dumps(events,indent=2))
 final=a.out_dir/'best.kicad_pcb';shutil.copy2(current,final);shutil.copy2(current.with_suffix('.kicad_pro'),final.with_suffix('.kicad_pro'))
 if (current.parent/'fp-lib-table').exists():shutil.copy2(current.parent/'fp-lib-table',a.out_dir/'fp-lib-table')
 report=dict(board=str(final),accepted=sum(e['accepted'] for e in events),opens=len(before['unconnected_items']),violations=len(before['violations']),events=events);(a.out_dir/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='events'}))
if __name__=='__main__':main()
