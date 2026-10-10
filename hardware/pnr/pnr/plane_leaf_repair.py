"""Bounded composite return-leaf relocation plus signal closure.

A provisional extra ordinary return via is only accepted if the complete
transaction closes a native connection, preserves the original pad partition,
qualified entries/reference and has no additional native violations.
"""
from pathlib import Path
import json,subprocess,sys,time,shutil

def endpoint_has_no_escape(events):
    rows=[e for e in events if e.get('request')=='missing' and e.get('stage')=='escape_ports']
    seen={e['side'] for e in rows}
    return [side for side in sorted(seen) if not any(e.get('ports') for e in rows if e['side']==side)]

class RepairBudget:
    """Bound expensive signal trials without starving later eligible footprints.

    Negative eligibility depends on exact copper and footprint, not the failing
    signal net. A changed checkpoint may legitimately enable a previous leaf.
    """
    def __init__(self, max_trials=8, max_probes=64):
        self.max_trials=max_trials; self.max_probes=max_probes
        self.probes=set(); self.ineligible=set(); self.trials=0

    @property
    def available(self):
        return self.trials < self.max_trials and len(self.probes) < self.max_probes

    def reserve(self, board_hash, ref, net):
        key=(board_hash,ref,net)
        if not self.available or (board_hash,ref) in self.ineligible or key in self.probes:
            return False
        self.probes.add(key)
        return True

    def record(self, board_hash, ref, outcome):
        if outcome.get('leaf',{}).get('guards_pass'):
            self.trials+=1
        elif outcome.get('status')=='no_guarded_leaf':
            self.ineligible.add((board_hash,ref))

    def summary(self):
        return dict(probes=len(self.probes), guarded_trials=self.trials,
                    ineligible_footprints=len(self.ineligible),
                    max_probes=self.max_probes, max_trials=self.max_trials)

def run(board,rules,target,out,*,native_python,cli,adapter,sources=(),seconds=40,focus=None):
 out=Path(out);out.mkdir(exist_ok=False);board=Path(board);rules=Path(rules);result=dict(accepted=False,status='not_run',source=str(board),target=target);started=time.monotonic()
 def invoke(cmd,label):
  with (out/(label+'.log')).open('w') as f:subprocess.run(list(map(str,cmd)),stdout=f,stderr=subprocess.STDOUT,check=True)
 def finish(status):
  result.update(status=status,elapsed_seconds=time.monotonic()-started);(out/'result.json').write_text(json.dumps(result,indent=2));return result
 if target.get('mode','signal')!='signal':return finish('protected_target')
 focus=focus or target['source'].rsplit('.',1)[0]
 cmd=[native_python,'-m','pnr.plane_leaf',board,'--rules',rules,'--focus',focus,'--out-dir',out/'leaf']
 for source in sources:cmd+=['--annotation-source',source]
 try:invoke(cmd,'leaf')
 except subprocess.CalledProcessError as exc:
  result['worker_returncode']=exc.returncode;return finish('leaf_worker_error')
 leaf=json.loads((out/'leaf/result.json').read_text());result['leaf']=leaf
 if not leaf.get('guards_pass'):return finish('no_guarded_leaf')
 # Keep all unrelated copper fixed. The native adapter independently validates
 # every track and transition; no pad/clearance or current rules are relaxed.
 points=[target['source_xy'],target['target_xy']];box=[min(p[0] for p in points)-3,min(p[1] for p in points)-3,max(p[0] for p in points)+3,max(p[1] for p in points)+3]
 cmd=[native_python,adapter,out/'leaf/candidate.kicad_pcb','--out-dir',out/'signal','--net',target['net'],'--source-pad',target['source'],'--target-pad',target['target'],'--bounds',*box,'--pitch','.05','--preserve-copper','--layers','--joint','--max-expansions','150000','--max-seconds',seconds,'--kicad-cli',cli,'--rules',rules]
 for end in ['source','target']:
  if target.get(end+'_uuid'):cmd+=['--'+end+'-pad-uuid',target[end+'_uuid']]
 try:invoke(cmd,'signal')
 except subprocess.CalledProcessError as exc:
  result['worker_returncode']=exc.returncode;return finish('signal_worker_error')
 signal=json.loads((out/'signal/result.json').read_text());result['signal']=signal
 if not signal.get('accepted') or signal.get('after_opens',float('inf'))>=leaf['before_opens']:return finish('signal_did_not_close')
 for ext in ['.kicad_pcb','.kicad_pro']:
  shutil.copy2(out/'signal'/('candidate'+ext),out/('candidate'+ext))
 shutil.copy2(out/'signal/candidate.drc.json',out/'candidate.drc.json')
 if (out/'signal/fp-lib-table').exists():shutil.copy2(out/'signal/fp-lib-table',out/'fp-lib-table')
 result.update(accepted=True,before_opens=leaf['before_opens'],after_opens=signal['after_opens'],lost_pad_entries=signal.get('lost_pad_entries',[]))
 return finish('routed_with_plane_leaf_repair')

def main():
 import argparse
 ap=argparse.ArgumentParser();ap.add_argument('board',type=Path);ap.add_argument('--rules',type=Path,required=True);ap.add_argument('--target-json',type=Path,required=True);ap.add_argument('--out-dir',type=Path,required=True);ap.add_argument('--adapter',type=Path,required=True);ap.add_argument('--kicad-cli',required=True);ap.add_argument('--annotation-source',type=Path,action='append',default=[]);ap.add_argument('--focus');ap.add_argument('--seconds',type=float,default=40);a=ap.parse_args()
 result=run(a.board,a.rules,json.loads(a.target_json.read_text()),a.out_dir,native_python=sys.executable,cli=a.kicad_cli,adapter=a.adapter,sources=a.annotation_source,seconds=a.seconds,focus=a.focus);print(json.dumps(result))
if __name__=='__main__':main()
