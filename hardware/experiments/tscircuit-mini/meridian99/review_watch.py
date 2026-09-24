from pathlib import Path
import json,time,subprocess,shutil
root=Path('output/fresh-pnr-20260919/meridian99');out=Path('output/pdf/mini-meridian99-20260921');out.mkdir(parents=True,exist_ok=True)
doc='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';ki='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3';pop='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'
(out/'notes.json').write_text(json.dumps(['Mechanically unconstrained diagnostic. All component centres may move; footprints remain rigid.','Every positive feedback cell inserts 0.05 mm in X and Y; no magnitude weighting.','Cycle 1 is the cached full29 first signal round. Later cycles reroute from scratch, 12 passes each.','Electrical power/USB nets remain deferred in this signal-stage experiment. Native DRC is separate.','Board size changes: read dimensions; figures are fitted to page, not one physical print scale.']))
seen=set();jobs=[];deadline=time.monotonic()+2400
while time.monotonic()<deadline:
 ready=set(root.glob('expansion/round-*/result.json'))
 if ready!=seen:
  subprocess.run(['python3','/private/tmp/pnr-runtime.py','hardware/tools/export_elastic_experiment.py',str(root),'--out',str(out)],check=True,stdout=subprocess.DEVNULL)
  subprocess.run([doc,'hardware/tools/render_elastic_experiment.py',str(out)],check=True)
  (out/'review.json').write_text(json.dumps(dict(status='pending',reviewed_pages=[])))
  for r in sorted(ready-seen):
   p=r.parent;subprocess.run(['python3','/private/tmp/native-diagnostic-arrays.py',str(p)],check=True)
   folder=out/p.name;f=(p/'pdf.log').open('w');jobs.append((subprocess.Popen([doc,'hardware/tools/export_mini_review.py',str(p/'diagnostic.kicad_pcb'),'--out-dir',str(folder),'--pdftoppm',pop],stdout=f,stderr=subprocess.STDOUT),f))
   subprocess.run([ki,'hardware/tools/scan_via_proximity.py',str(p/'diagnostic.kicad_pcb'),'--radius-mm','5','--out-dir',str(p/'via-scan')],check=True,stdout=subprocess.DEVNULL)
  seen=ready
 if len(seen)>=4:break
 time.sleep(5)
for p,f in jobs:
 code=p.wait();f.close();print('layer PDF exit',code,flush=True)
print('watch complete',len(seen),flush=True)
