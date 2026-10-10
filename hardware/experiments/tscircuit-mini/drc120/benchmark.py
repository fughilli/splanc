"""Alternating comparable CLI/API checks of saved immutable fixtures."""
import hashlib,json,os,shutil,subprocess,time,statistics
from pathlib import Path
ROOT=Path.cwd();OUT=ROOT/'output/drc120/copper-only';OUT.mkdir(parents=True,exist_ok=True)
CLI='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
PY='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3'
fixtures={
 'led2':'output/pnr-regression118/qualified-ladder-v2/01-connector-led-2-seed-0/routed.kicad_pcb',
 'chaser20':'output/pnr-regression118/qualified-ladder-v2/08-chaser-20-plane-seed-0/routed.kicad_pcb',
 'mini48':'output/fresh-pnr-20260919/fresh-28-final/splanc_mini.fab.board.kicad_pcb',
 'mini186':'output/fresh-pnr-20260919/fresh119-20260924/reviews/source-round-01/diagnostic.kicad_pcb'}
rows=[]
for i in range(5):
 t=time.perf_counter();subprocess.run([CLI,'version'],stdout=subprocess.DEVNULL,check=True);rows.append(dict(mode='cli_version',wall=time.perf_counter()-t))
for label,name in fixtures.items():
 src=ROOT/name;folder=OUT/label;folder.mkdir(exist_ok=True);board=folder/src.name
 for suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru'):
  if src.with_suffix(suffix).exists():shutil.copyfile(src.with_suffix(suffix),board.with_suffix(suffix))
 table=src.parent/'fp-lib-table'
 if table.exists():(folder/'fp-lib-table').write_text(table.read_text().replace('${KIPRJMOD}',str(src.parent)))
 pro=board.with_suffix('.kicad_pro');settings=json.loads(pro.read_text());severities=settings['board']['design_settings']['rule_severities'];severities['lib_footprint_issues']='ignore';severities['lib_footprint_mismatch']='ignore';pro.write_text(json.dumps(settings,indent=2))
 for i in range(5):
  report=folder/f'cli-{i}.json';t=time.perf_counter()
  with (folder/f'cli-{i}.log').open('w') as log:
   subprocess.run([CLI,'pcb','drc',str(board),'--format','json','--output',str(report)],stdout=log,stderr=log,check=True,timeout=90)
  result=json.loads(report.read_text());row=dict(label=label,mode='cli',iteration=i,wall=time.perf_counter()-t,violations=len(result['violations']),opens=len(result['unconnected_items']))
  rows.append(row);print(json.dumps(row),flush=True)
 with (folder/'api.log').open('w') as log:
  t=time.perf_counter();subprocess.run([PY,str(ROOT/'hardware/experiments/tscircuit-mini/drc120/probe.py'),str(board),str(folder)],stdout=log,stderr=log,check=True,timeout=180)
  rows.append(dict(label=label,mode='api_process_total',wall=time.perf_counter()-t))
 print(label, (folder/'api.json').read_text(),flush=True)
(OUT/'results.json').write_text(json.dumps(dict(rows=rows,fixtures=fixtures,parallel_active_build=True),indent=2))
