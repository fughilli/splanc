from pathlib import Path
import os,sys,json,subprocess,time,shutil,hashlib
root=Path('output/fresh-pnr-20260919/mesh98-comparison');out=Path('output/pdf/mini-mesh98-comparison-20260921');out.mkdir(parents=True,exist_ok=True)
(out/'notes.json').write_text(json.dumps(['Live comparison: refreshed after each completed routing cycle. Review ledger may still be pending.','Baseline-v1: fixed channel relationships and broad net-box fallback.','Candidate-v2: refreshed relationships and localized disconnected-terminal/corridor feedback.','Same corrected pad geometry, fixed outline, 12 detailed-router iterations per cycle.','Counts describe early signal routing; native DRC and complete electrical routing remain required.']))
doc='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';env=dict(os.environ,PYTHONPATH=str(Path('hardware/pnr').resolve()));seen=set();deadline=time.monotonic()+2400
while time.monotonic()<deadline:
 ready={str(p.parent) for p in root.glob('*/round-*/result.json')}
 if ready!=seen:
  subprocess.run([sys.executable,'hardware/tools/export_elastic_experiment.py',str(root),'--out',str(out)],env=env,check=True,stdout=subprocess.DEVNULL)
  subprocess.run([doc,'hardware/tools/render_elastic_experiment.py',str(out)],check=True)
  (out/'review.json').write_text(json.dumps(dict(status='pending',completed_cycles=len(ready),reviewed_pages=[])))
  print('PDF refreshed',len(ready),flush=True)
  for folder in sorted(ready-seen):
   p=Path(folder)
   for name in ('source.kicad_pcb','rules.json'):shutil.copyfile(Path('output/fresh-pnr-20260919/fresh-28-diagnostics')/name,p/name)
   subprocess.run([sys.executable,'/private/tmp/native-diagnostic-arrays.py',str(p)],check=True)
  seen=ready
 if len(seen)>=6:break
 time.sleep(5)
else:raise RuntimeError('watcher exhausted bounded budget')
