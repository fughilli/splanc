"""Rebuild enclosure STEP/render deliverables from native board designs.
Run with the isolated CadQuery Python. KiCad Python is used only for extraction.
"""
import argparse,subprocess,sys,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--mini',type=Path,required=True);p.add_argument('--max-project',type=Path,default=Path('hardware/splanc_max'));p.add_argument('--out',type=Path,default=Path('output/mechanical'));p.add_argument('--kicad-python',default='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3');a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
here=Path(__file__).resolve().parent
inputs={'mini':a.mini,'max-lv':a.max_project/'boards/splanc_max_lv.kicad_pcb','max-power':a.max_project/'boards/splanc_max_power.kicad_pcb'}
for name,path in inputs.items():subprocess.run([a.kicad_python,str(here/'extract_board.py'),str(path),'--out',str(a.out/(name+'-board.json'))],check=True)
subprocess.run([sys.executable,str(here/'generate_enclosures.py'),'--mini',str(a.out/'mini-board.json'),'--mini-ports',str(here/'mini-ports.json'),'--max',str(a.max_project/'interface.json'),'--max-lv',str(a.out/'max-lv-board.json'),'--max-power',str(a.out/'max-power-board.json'),'--out',str(a.out)],check=True)
manifest={str(p.resolve()):hashlib.sha256(p.read_bytes()).hexdigest() for p in [*inputs.values(),a.max_project/'interface.json',here/'mini-ports.json',here/'generate_enclosures.py']};(a.out/'input-hashes.json').write_text(json.dumps(manifest,indent=2))
print('Wrote enclosure STEP parts, assemblies, renders and validation manifests:',a.out)
