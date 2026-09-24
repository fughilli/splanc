from pathlib import Path
import os,subprocess,shutil,sys,json
from collections import Counter
p=Path(sys.argv[1]);py='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3';env=dict(os.environ,PYTHONPATH=str(Path('hardware/pnr').resolve()))
shutil.copy('output/fresh-pnr-20260919/source-footprint-probe/fp-lib-table',p/'fp-lib-table')
source=str(p/'source.kicad_pcb') if (p/'source.kicad_pcb').exists() else 'output/fresh-pnr-20260919/fresh-12-round-01/source.kicad_pcb'
cmds=[[py,'-m','pnr.writeback',source,str(p/'placed.json'),'--out',str(p/'diagnostic.kicad_pcb'),'--rules',str(p/'rules.json'),'--routes',str(p/'routes.json')],[py,'-m','pnr.planes',str(p/'diagnostic.kicad_pcb'),'--rules',str(p/'rules.json')],['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli','pcb','drc','--format','json','--output',str(p/'diagnostic.drc.json'),str(p/'diagnostic.kicad_pcb')]]
cmds.insert(1,[py,'-m','pnr.plane_access',str(p/'diagnostic.kicad_pcb'),'--out',str(p/'diagnostic.kicad_pcb'),'--fab-model','hardware/splanc_dev/mini-plane-access-fab.json','--report',str(p/'plane-access.json'),'--annotation-source','hardware/splanc_dev/elec/src/splanc_mini.ato'])
with (p/'native-diagnostic.log').open('w') as f:
 for cmd in cmds:subprocess.run(cmd,env=env,stdout=f,stderr=subprocess.STDOUT,check=True)
d=json.loads((p/'diagnostic.drc.json').read_text());print(p,len(d['unconnected_items']),Counter(v['type'] for v in d['violations']))
