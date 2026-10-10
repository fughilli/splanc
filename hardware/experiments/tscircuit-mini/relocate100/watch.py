from pathlib import Path
import json,time,subprocess,shutil
root=Path('output/fresh-pnr-20260919/relocate100');out=Path('output/pdf/mini-relocate100-20260921');out.mkdir(parents=True,exist_ok=True)
doc='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';ki='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3';pop='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'
(out/'notes.json').write_text(json.dumps(['Fixed 70 x 55 mm outline; all explicit constraints retained except pogo XY.','Translation-only: original side and pad geometry preserved.','Layered placement cost is an approximate ranking; native DRC and actual reroute assess the result.','Baseline cached; each candidate gets 12 signal routing passes. Fifteen electrical nets remain deferred.']))
seen=set();jobs=[];deadline=time.monotonic()+2400
while time.monotonic()<deadline:
 ready=set(root.glob('relocation/round-*/result.json'))
 if ready!=seen:
  subprocess.run(['python3','/private/tmp/pnr-runtime.py','hardware/tools/export_elastic_experiment.py',str(root),'--out',str(out)],check=True,stdout=subprocess.DEVNULL)
  subprocess.run([doc,'hardware/tools/render_elastic_experiment.py',str(out)],check=True)
  (out/'review.json').write_text(json.dumps(dict(status='pending',reviewed_pages=[])))
  for r in sorted(ready-seen):
   p=r.parent;subprocess.run(['python3','hardware/experiments/tscircuit-mini/relocate100/native_diagnostic.py',str(p)],check=True)
   folder=out/p.name;f=(p/'pdf.log').open('w');jobs.append((subprocess.Popen([doc,'hardware/tools/export_mini_review.py',str(p/'diagnostic.kicad_pcb'),'--out-dir',str(folder),'--pdftoppm',pop],stdout=f,stderr=subprocess.STDOUT),f))
   subprocess.run([ki,'hardware/tools/scan_via_proximity.py',str(p/'diagnostic.kicad_pcb'),'--radius-mm','5','--out-dir',str(p/'via-scan')],check=True,stdout=subprocess.DEVNULL)
  seen=ready
 if len(seen)>=3:break
 time.sleep(5)
for p,f in jobs:
 code=p.wait();f.close();print('layer PDF exit',code,flush=True)
print('watch complete',len(seen),flush=True)
