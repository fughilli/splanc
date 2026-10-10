from pathlib import Path
import subprocess,time,json,shutil
root=Path('output/fresh-pnr-20260919/full104');out=Path('output/pdf/mini-full104-20260921');out.mkdir(parents=True,exist_ok=True)
doc='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';ki='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3';pop='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'
seen={p for p in root.glob('relocation/round-*/result.json') if (out/p.parent.name/'manifest.json').exists() and (p.parent/'via-scan/scan.json').exists()};deadline=time.monotonic()+172900
while time.monotonic()<deadline:
 for r in sorted(root.glob('relocation/round-*/result.json')):
  if r in seen:continue
  p=r.parent;folder=out/p.name
  # Even cached baseline gets an exact hash-bound fresh export.
  with (p/'pdf.log').open('w') as log:
   subprocess.run([doc,'hardware/tools/export_mini_review.py',str(p/'diagnostic.kicad_pcb'),'--out-dir',str(folder),'--pdftoppm',pop],stdout=log,stderr=subprocess.STDOUT,check=True)
  subprocess.run([ki,'hardware/tools/scan_via_proximity.py',str(p/'diagnostic.kicad_pcb'),'--radius-mm','5','--out-dir',str(p/'via-scan')],check=True,stdout=subprocess.DEVNULL)
  subprocess.run([doc,'hardware/tools/review_mini_contacts.py',str(folder),'layers'],check=True,stdout=subprocess.DEVNULL)
  subprocess.run([doc,'hardware/tools/review_mini_contacts.py',str(p/'via-scan'),'vias'],check=True,stdout=subprocess.DEVNULL)
  seen.add(r);print('exported',p.name,flush=True)
 if (root/'termination.json').exists() and set(root.glob('relocation/round-*/result.json')) <= seen:break
 time.sleep(5)
print('export watcher stopped',len(seen),flush=True)
