from pathlib import Path
import time,shutil,subprocess,json
log=Path('/private/tmp/mini-fresh-29.log');base=Path('output/fresh-pnr-20260919');src=Path('bazel-bin/hardware/splanc_dev');deadline=time.monotonic()+1800
while time.monotonic()<deadline:
 s=log.read_text()
 if 'Build did NOT complete' in s or 'Build completed successfully' in s:break
 time.sleep(5)
else:raise RuntimeError('archive watcher budget exhausted')
dst=base/'fresh-29-final';dst.mkdir();shutil.copytree(src/'splanc_mini.mesh_experiment.board.diagnostics',base/'fresh-29-diagnostics');shutil.copyfile(log,base/'fresh-29-build.log')
for p in src.glob('splanc_mini.mesh_experiment.board.*'):
 if p.is_file():shutil.copyfile(p,dst/p.name)
for n in ('fp-lib-table',):
 p=base/'fresh-29-diagnostics'/n
 if p.exists():shutil.copyfile(p,dst/n)
subprocess.run(['python3','hardware/tools/freeze_mini_inputs.py',str(base/'fresh-29-source'),'--verify'],check=True)
b=dst/'splanc_mini.mesh_experiment.board.kicad_pcb'
if b.exists():subprocess.run(['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli','pcb','drc',str(b),'--format','json','--output',str(dst/'verified-native.drc.json')],check=True)
print('Archived full29 and verified frozen inputs.',flush=True)
