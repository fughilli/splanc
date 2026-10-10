"""Bounded power detour + layered signal-blocker restoration transaction."""
from pathlib import Path
import json,subprocess,sys,time,shutil,math

class DetourBudget:
 def __init__(self,max_trials=4,max_probes=64):
  self.max_trials=max_trials;self.max_probes=max_probes;self.probes=set();self.trials=0
 @property
 def available(self):return self.trials<self.max_trials and len(self.probes)<self.max_probes
 def reserve(self,board_hash,pad,net):
  key=(board_hash,pad,net)
  if not self.available or key in self.probes:return False
  self.probes.add(key);return True
 def record(self,result):
  if result.get('detour',{}).get('guards_pass'):self.trials+=1
 def summary(self):return dict(probes=len(self.probes),guarded_trials=self.trials,max_trials=self.max_trials,max_probes=self.max_probes)

def repair_bounds(target,chosen,margin=3):
 pts=[target['source_xy'],target['target_xy']]
 box=[min(p[0] for p in pts)-margin,min(p[1] for p in pts)-margin,max(p[0] for p in pts)+margin,max(p[1] for p in pts)+margin]
 extra=chosen.get('restoration_bounds')
 if extra:box=[min(box[0],extra[0]),min(box[1],extra[1]),max(box[2],extra[2]),max(box[3],extra[3])]
 # Anchor the search lattice to absolute board coordinates. Tiny changes in
 # restoration extents must not shift every escape sample. Never shrink bounds.
 return [math.floor(box[0]*20)/20,math.floor(box[1]*20)/20,math.ceil(box[2]*20)/20,math.ceil(box[3]*20)/20]

def run(board,rules,target,out,*,native_python,cli,adapter,focus=None,seconds=40,sources=()):
 out=Path(out);out.mkdir(exist_ok=False);board=Path(board);started=time.monotonic();result=dict(accepted=False,target=target,source=str(board))
 def invoke(cmd,label):
  with (out/(label+'.log')).open('w') as f:subprocess.run(list(map(str,cmd)),stdout=f,stderr=subprocess.STDOUT,check=True)
 def finish(status):
  result.update(status=status,elapsed_seconds=time.monotonic()-started);(out/'result.json').write_text(json.dumps(result,indent=2));return result
 if target.get('mode','signal')!='signal':return finish('protected_target')
 focus=focus or target['source']
 try:invoke([native_python,'-m','pnr.power_detour',board,'--rules',rules,'--focus',focus,'--out-dir',out/'detour','--kicad-cli',cli],'detour')
 except subprocess.CalledProcessError as e:result['returncode']=e.returncode;return finish('detour_worker_error')
 report=out/'detour/result.json'
 if not report.exists():return finish('no_improving_detour')
 detour=json.loads(report.read_text());result['detour']=detour
 if not detour.get('guards_pass'):return finish('detour_native_guard')
 chosen=detour['chosen'];box=repair_bounds(target,chosen)
 if max(box[2]-box[0],box[3]-box[1])>35:return finish('restoration_region_too_large')
 nets=[target['net']]+chosen.get('reopen',[])
 cmd=[native_python,adapter,out/'detour/candidate.kicad_pcb','--out-dir',out/'signal','--source-pad',target['source'],'--target-pad',target['target'],'--bounds',*box,'--pitch','.05','--layers','--joint','--relocate-vias','--max-expansions','150000','--max-orders','32','--max-seconds',seconds,'--rules',rules,'--kicad-cli',cli]
 for net in nets:cmd+=['--net',net]
 for end in ('source','target'):
  if target.get(end+'_uuid'):cmd+=['--'+end+'-pad-uuid',target[end+'_uuid']]
 for source in sources:cmd+=['--annotation-source',source]
 result['signal_command']=list(map(str,cmd))
 try:invoke(cmd,'signal')
 except subprocess.CalledProcessError as e:result['returncode']=e.returncode;return finish('signal_worker_error')
 signal=json.loads((out/'signal/result.json').read_text());signal_dir=out/'signal'
 result['attempts']=[dict(folder=str(signal_dir),status=signal.get('status'))]
 if not signal.get('accepted') and time.monotonic()-started<seconds-10:
  planner=[native_python,'-m','pnr.regional_blockers',out/'detour/candidate.kicad_pcb','--rules',rules,'--report',signal_dir/'result.json','--out',out/'blocker-plans.json','--bounds',*box]
  for net in nets:planner+=['--net',net]
  for source in sources:planner+=['--annotation-source',source]
  try:
   invoke(planner,'blockers');plans=json.loads((out/'blocker-plans.json').read_text())['plans']
  except subprocess.CalledProcessError as e:
   result['returncode']=e.returncode;return finish('blocker_worker_error')
  for number,plan in enumerate(plans):
   remaining=seconds-(time.monotonic()-started)
   if remaining<10:break
   signal_dir=out/('signal-blocker-%02d'%number);retry=cmd[:]
   retry[retry.index('--out-dir')+1]=signal_dir
   i=retry.index('--bounds');retry[i+1:i+5]=plan['bounds']
   retry[retry.index('--max-expansions')+1]='600000'
   retry[retry.index('--max-seconds')+1]=min(90,remaining)
   retry+=['--net',plan['net']]
   result['attempts'].append(dict(folder=str(signal_dir),plan=plan,command=list(map(str,retry))))
   try:invoke(retry,'signal-blocker-%02d'%number)
   except subprocess.CalledProcessError as e:
    result['attempts'][-1].update(status='worker_error',returncode=e.returncode);continue
   signal=json.loads((signal_dir/'result.json').read_text());result['attempts'][-1]['status']=signal.get('status')
   if signal.get('accepted'):break
 result['signal']=signal
 if not signal.get('accepted') or signal.get('after_opens',float('inf'))>=detour['before_opens']:return finish('signal_not_closed')
 for ext in ('.kicad_pcb','.kicad_pro','.drc.json'):shutil.copy2(signal_dir/('candidate'+ext),out/('candidate'+ext))
 if (signal_dir/'fp-lib-table').exists():shutil.copy2(signal_dir/'fp-lib-table',out/'fp-lib-table')
 result.update(accepted=True,before_opens=detour['before_opens'],after_opens=signal['after_opens'])
 return finish('routed_with_power_detour')

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('board',type=Path);p.add_argument('--rules',type=Path,required=True);p.add_argument('--target-json',type=Path,required=True);p.add_argument('--out-dir',type=Path,required=True);p.add_argument('--adapter',required=True);p.add_argument('--kicad-cli',required=True);p.add_argument('--focus');p.add_argument('--seconds',type=float,default=40);p.add_argument('--annotation-source',type=Path,action='append',default=[]);a=p.parse_args();d=run(a.board,a.rules,json.loads(a.target_json.read_text()),a.out_dir,native_python=sys.executable,cli=a.kicad_cli,adapter=a.adapter,focus=a.focus,seconds=a.seconds,sources=a.annotation_source);print(json.dumps({k:d.get(k) for k in ['accepted','status','before_opens','after_opens','elapsed_seconds']}))
if __name__=='__main__':main()
