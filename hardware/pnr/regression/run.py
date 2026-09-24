#!/usr/bin/env python3
"""Fresh circuit -> native PCB -> production P/R -> saved native DRC acceptance.

Missing tools, timeout, illegal placement, opens and *any* native DRC finding fail.
Never skips/x-fails difficult cases. Outputs persist in a new, refused-if-existing
run directory, including rejected boards, stage logs and source hashes.
"""
import argparse,hashlib,json,os,shutil,subprocess,sys,time,traceback
from pathlib import Path
from collections import Counter
from xml.etree import ElementTree as ET
from designs import designs
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
KI='/Applications/KiCad/KiCad.app/Contents'

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def acceptance(pnr,audit,drc):
 reasons=[]
 if not pnr.get('legal'):reasons.append('illegal_placement')
 if not pnr.get('converged') or pnr.get('unrouted') or pnr.get('deferred'):reasons.append('incomplete_pnr')
 if audit.get('netlist_preserved') is not True:reasons.append('changed_pin_netlist')
 if audit.get('subwidth_tracks'):reasons.append('undersized_copper')
 if any(not r['qualified'] for r in audit.get('pad_entries',[])):reasons.append('unqualified_pad_entry')
 if not isinstance(drc.get('unconnected_items'),list) or not isinstance(drc.get('violations'),list):reasons.append('invalid_drc_report')
 else:
  if drc['unconnected_items']:reasons.append('native_unconnected_items')
  if drc['violations']:reasons.append('native_drc_violations')
 return reasons

def main():
 global REPO
 ap=argparse.ArgumentParser(description=__doc__)
 ap.add_argument('--repo',type=Path,default=Path(os.environ.get('BUILD_WORKSPACE_DIRECTORY',REPO)))
 ap.add_argument('--out',type=Path,required=True);ap.add_argument('--case',action='append',default=[])
 ap.add_argument('--seed',type=int,action='append');ap.add_argument('--rounds',type=int,default=4)
 ap.add_argument('--timeout',type=float,default=600)
 ap.add_argument('--python')
 ap.add_argument('--initial-pool',action='store_true',help='Compare a bounded set of legal global placements before round one')
 ap.add_argument('--initial-starts',type=int,default=8)
 ap.add_argument('--initial-finalists',type=int,default=3)
 ap.add_argument('--kicad-python',default=KI+'/Frameworks/Python.framework/Versions/3.9/bin/python3')
 ap.add_argument('--kicad-cli',default=KI+'/MacOS/kicad-cli')
 ap.add_argument('--library',type=Path,default=Path(KI+'/SharedSupport/footprints'))
 args=ap.parse_args();REPO=args.repo.resolve();args.python=args.python or str(REPO/'output/pnr-regression-runtime/bin/python')
 out=args.out.resolve();out.mkdir(parents=True,exist_ok=False)
 allcases=designs();cases=[c for c in allcases if not args.case or c['name'] in args.case]
 if not cases or (set(args.case)-{c['name'] for c in cases}):raise SystemExit('Unknown/empty case selection')
 source_files=sorted((REPO/'hardware/pnr/pnr').rglob('*.py'))+sorted((REPO/'hardware/pnr/regression').glob('*.py'))
 manifest={str(p.relative_to(REPO)):sha(p) for p in source_files}
 freeze=out/'source-freeze'
 for source_path in source_files:
  target=freeze/source_path.relative_to(REPO);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source_path,target)
 frozen_here=freeze/'hardware/pnr/regression'
 env=dict(os.environ,PYTHONPATH=str(freeze/'hardware/pnr'),PNR_LOCAL_PRESSURE='1')
 # Ambient experiment switches must not silently change the suite configuration.
 for key in list(env):
  if key.startswith('PNR_') and key not in ('PNR_LOCAL_PRESSURE','PNR_JOINT_ACCESS'):del env[key]
 if args.initial_pool:
  if not 2 <= args.initial_starts <= 128 or not 1 <= args.initial_finalists <= min(args.initial_starts,16):
   raise ValueError('Invalid initial placement pool size/finalist budget')
  env.update(PNR_INITIAL_POOL='1',PNR_INITIAL_STARTS=str(args.initial_starts),PNR_INITIAL_FINALISTS=str(args.initial_finalists),PNR_INITIAL_PROXY_BUDGET=str(args.initial_starts))
 provenance=dict(schema='pnr-regression-v1',source_hashes=manifest,seeds=args.seed or [0],
                 arguments={k:str(v) if isinstance(v,Path) else v for k,v in vars(args).items()},
                 pnr_environment={k:v for k,v in env.items() if k.startswith('PNR_')})
 (out/'provenance.json').write_text(json.dumps(provenance,indent=2))
 for key,cmd in [('python',[args.python,'-m','pip','freeze']),('kicad',[args.kicad_cli,'version'])]:
  (out/(key+'-version.txt')).write_text(subprocess.check_output(cmd,text=True))
 results=[]
 def stage(root,name,cmd):
  t=time.monotonic()
  with (root/(name+'.log')).open('w') as log:
   subprocess.run(list(map(str,cmd)),cwd=REPO,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=args.timeout)
  return time.monotonic()-t
 for spec in cases:
  for seed in args.seed or [0]:
   root=out/(spec['name']+'-seed-'+str(seed));root.mkdir()
   (root/'design.json').write_text(json.dumps(spec,indent=2))
   result=dict(case=spec['name'],seed=seed,components=spec['expected_components'],passed=False,stages={},directory=str(root));t=time.monotonic()
   print('START '+root.name,flush=True)
   try:
    def run(name,cmd):result['stages'][name]=stage(root,name,cmd)
    run('generate',[args.kicad_python,frozen_here/'native.py','make',root,'--library',args.library])
    source=sha(root/'source.kicad_pcb')
    graph=json.loads((root/'source-graph.json').read_text())
    assert len(graph['components'])==spec['expected_components']
    assert sum(bool(p['net']) for c in graph['components'] for p in c['pads'])==spec['expected_connected_pads']
    run('place-route',[args.python,frozen_here/'route_case.py',root,seed,args.rounds])
    board=root/'routed.kicad_pcb'
    run('writeback',[args.kicad_python,'-m','pnr.writeback',root/'source.kicad_pcb',root/'placed.json','--out',board,'--rules',root/'rules.json','--routes',root/'routes.json'])
    run('planes',[args.kicad_python,'-m','pnr.planes',board,'--rules',root/'rules.json'])
    run('refill',[args.kicad_python,'-m','pnr.planes',board,'--rules',root/'rules.json','--refill-only'])
    run('audit',[args.kicad_python,frozen_here/'native.py','audit',root,'--pcb',board])
    run('drc',[args.kicad_cli,'pcb','drc',board,'--format','json','--output',root/'drc.json'])
    run('via-scan',[args.kicad_python,REPO/'hardware/tools/scan_via_proximity.py',board,'--radius-mm','5','--out-dir',root/'via-scan'])
    pnr=json.loads((root/'pnr-report.json').read_text());audit=json.loads((root/'native-audit.json').read_text());drc=json.loads((root/'drc.json').read_text())
    result.update(reasons=acceptance(pnr,audit,drc),opens=len(drc['unconnected_items']),violations=dict(Counter(x['type'] for x in drc['violations'])),
     tracks=audit['tracks'],vias=audit['vias'],copper_length_mm=audit['copper_length_mm'],pnr=pnr,
     source_board_sha256=source,board_sha256=sha(board),project_sha256=sha(board.with_suffix('.kicad_pro')))
    if source!=sha(root/'source.kicad_pcb'):result['reasons'].append('source_changed')
    result['passed']=not result['reasons']
   except Exception as ex:
    result.update(error=str(ex),traceback=traceback.format_exc(),reasons=['stage_failure'])
   result['elapsed_seconds']=time.monotonic()-t
   (root/'result.json').write_text(json.dumps(result,indent=2));results.append(result)
   (out/'summary.json').write_text(json.dumps(dict(passed=all(r['passed'] for r in results),complete=False,results=results),indent=2))
   print(('PASS ' if result['passed'] else 'FAIL ')+root.name+' '+str(result.get('reasons')),flush=True)
 changed=[p for p,digest in manifest.items() if sha(freeze/p)!=digest]
 summary=dict(passed=all(r['passed'] for r in results) and not changed,complete=True,source_changed_during_run=changed,results=results)
 (out/'summary.json').write_text(json.dumps(summary,indent=2))
 suite=ET.Element('testsuite',name='native-pnr-ladder',tests=str(len(results)),failures=str(sum(not r['passed'] for r in results)))
 for r in results:
  test=ET.SubElement(suite,'testcase',name=r['case']+'-seed-'+str(r['seed']),time=str(r['elapsed_seconds']))
  if not r['passed']:ET.SubElement(test,'failure',message=', '.join(r['reasons'])).text=json.dumps(r,indent=2)
 if changed:ET.SubElement(suite,'error',message='frozen_source_changed').text=json.dumps(changed)
 ET.ElementTree(suite).write(out/'junit.xml',encoding='utf-8',xml_declaration=True)
 return 0 if summary['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
