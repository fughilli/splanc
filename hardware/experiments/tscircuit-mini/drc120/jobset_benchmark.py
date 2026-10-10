"""Measure native full DRC reuse through supported KiCad jobsets (unchanged board)."""
import json,subprocess,time,shutil,uuid,resource,random,statistics,hashlib
from pathlib import Path
ROOT=Path.cwd();OUT=ROOT/'output/drc120/jobset';OUT.mkdir(parents=True,exist_ok=True)
CLI='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
fixtures={
 'led2':'output/pnr-regression118/qualified-ladder-v2/01-connector-led-2-seed-0/routed.kicad_pcb',
 'chaser20':'output/pnr-regression118/qualified-ladder-v2/08-chaser-20-plane-seed-0/routed.kicad_pcb',
 'mini48':'output/fresh-pnr-20260919/fresh-28-final/splanc_mini.fab.board.kicad_pcb',
 'mini186':'output/fresh-pnr-20260919/fresh119-20260924/reviews/source-round-01/diagnostic.kicad_pcb'}
rows=[]
for label,name in fixtures.items():
 src=ROOT/name;folder=OUT/label;folder.mkdir(exist_ok=True);board=folder/src.name
 for suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru'):
  if src.with_suffix(suffix).exists():shutil.copyfile(src.with_suffix(suffix),board.with_suffix(suffix))
 table=src.parent/'fp-lib-table'
 if table.exists():(folder/'fp-lib-table').write_text(table.read_text().replace('${KIPRJMOD}',str(src.parent)))
 jobs=[]
 for i in range(8):jobs.append(dict(id=str(uuid.uuid4()),type='pcb_drc',description=f'Warm DRC {i}',settings=dict(output_filename=f'drc-{i}.json',format='json',parity=False,report_all_track_errors=False,refill_zones=False,save_board=False,fail_on_error=False,severity=48,units='mm')))
 tasks=['cold']*5+['batch']*5;random.Random(120).shuffle(tasks)
 for index,mode in enumerate(tasks):
  target=folder/f'{mode}-{index}';target.mkdir(exist_ok=True)
  if mode=='batch':
   jf=target/'checks.kicad_jobset';jf.write_text(json.dumps(dict(meta=dict(version=1),jobs=jobs,outputs=[dict(id=str(uuid.uuid4()),type='folder',only=[],description='Benchmark',settings=dict(output_path=str(target)))])))
   cmd=[CLI,'jobset','run','--file',str(jf),str(board.with_suffix('.kicad_pro'))]
  else:cmd=[CLI,'pcb','drc',str(board),'--format','json','--output',str(target/'drc-0.json')]
  t=time.perf_counter();r0=resource.getrusage(resource.RUSAGE_CHILDREN)
  with (target/'log').open('w') as log:subprocess.run(cmd,stdout=log,stderr=log,check=True,timeout=180)
  wall=time.perf_counter()-t;r1=resource.getrusage(resource.RUSAGE_CHILDREN);reports=list(target.glob('drc-*.json'))
  if len(reports)!=(8 if mode=='batch' else 1):raise RuntimeError('Missing native reports: '+str(target))
  def signature(d):return {key:sorted(json.dumps(v,sort_keys=True) for v in d[key]) for key in ('violations','unconnected_items','schematic_parity')}
  normalized=[signature(json.loads(f.read_text())) for f in reports]
  # Unconnected MST edge selection can vary; record exact disagreement explicitly.
  row=dict(label=label,mode=mode,index=index,wall=wall,cpu=r1.ru_utime+r1.ru_stime-r0.ru_utime-r0.ru_stime,n=len(reports),opens=len(normalized[0]['unconnected_items']),violations=len(normalized[0]['violations']),batch_reports_identical=all(s==normalized[0] for s in normalized),sha256=hashlib.sha256(board.read_bytes()).hexdigest())
  rows.append(row);print(json.dumps(row),flush=True);(OUT/'results.json').write_text(json.dumps(rows,indent=2))
