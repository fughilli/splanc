"""Real native DRC count and conflict isolation on saved KiCad fixtures."""
import json,subprocess,sys,time
from pathlib import Path
from pnr.batch_validate import evaluate
from pnr.native_drc import run_drc
base=Path('output/parallel107/merge-fixture/base.kicad_pcb').resolve();root=Path('output/batch111/native-benchmark');root.mkdir(parents=True,exist_ok=True)
cli='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
baseline=run_drc(cli,base,root/'baseline.drc.json');assert len(baseline['unconnected_items'])==2
reports=[]
def exercise(name,proposals,batch):
 folder=root/name;folder.mkdir(exist_ok=True);counter=0;current_report=baseline;start=time.perf_counter()
 def validate(current,items):
  nonlocal counter,current_report
  counter+=1;trial=folder/f'validation-{counter}';trial.mkdir(exist_ok=True);merged=current
  for i,(j,p) in enumerate(items):
   out=trial/f'merge-{i}.kicad_pcb'
   subprocess.run([sys.executable,'-m','pnr.merge_additive',str(base),str(base.parent/(j+'.kicad_pcb')),str(merged),str(out)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);merged=out
  report=run_drc(cli,merged,trial/'drc.json')
  if report['violations'] or len(report['unconnected_items'])>=len(current_report['unconnected_items']):return None
  current_report=report;return merged
 if batch:
  current,accepted,retry,metrics=evaluate(proposals,base,lambda j,b:dict(proposal_ready=True,accepted=False),validate,2)
 else:
  current=base;accepted=[];retry=[]
  for j in proposals:
   updated=validate(current,[(j,{})])
   if updated:current=updated;accepted.append(j)
   else:retry.append(j)
 result=dict(case=name,drc_invocations=counter,wall_seconds=time.perf_counter()-start,opens=len(current_report['unconnected_items']),violations=len(current_report['violations']),accepted=accepted,retry=retry,board=str(current));reports.append(result);return result
serial=exercise('serial',['a','b'],False);batched=exercise('batch',['a','b'],True);conflict=exercise('conflict',['a','conflict'],True)
assert serial['drc_invocations']==2 and batched['drc_invocations']==1
assert serial['opens']==batched['opens']==0 and batched['violations']==0
assert conflict['accepted']==['a'] and conflict['retry']==['conflict'] and conflict['violations']==0 and conflict['opens']==1
(root/'result.json').write_text(json.dumps(reports,indent=2));print('PASS native batched validation',json.dumps(reports))
