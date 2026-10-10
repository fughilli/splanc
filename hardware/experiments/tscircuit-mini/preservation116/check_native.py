import sys,json,importlib.util
from pathlib import Path
sys.path.insert(0,str(Path('hardware/experiments/tscircuit-mini/incremental112/runtime/hardware/pnr').resolve()))
import pnr
pnr.__path__.insert(0,str(Path('hardware/pnr/pnr').resolve()))
spec=importlib.util.spec_from_file_location('preservation116_native', 'hardware/experiments/tscircuit-mini/preservation116/native_loop.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=Path('output/fresh-pnr-20260919/pogo114-20260924/candidate');o=Path('output/preservation116')
rules=json.loads((p/'electrical/native-loop/policy/prepare.json').read_text());rules['restoration_partition']=json.loads((p/'electrical/seed-inventory.json').read_text())['partition'];(o/'rules.json').write_text(json.dumps(rules))
m.main([str(p/'phases/09-final-audit/diagnostic.kicad_pcb'),'--worker','inspect','--rules',str(o/'rules.json'),'--report',str(o/'inventory.json')])
inv=json.loads((o/'inventory.json').read_text());targets=m.scheduled_route_jobs(inv['targets'],{})
required=[t for t in targets if t['restoration_required']]
assert len(required)==3,[(t['source'],t['target']) for t in required]
assert all(t['restoration_required'] for t in targets[:3])
from pnr.connectivity_restore import lost_connections
loss=lost_connections(rules['restoration_partition'],inv['partition']);assert len(loss)==3
print(json.dumps(dict(first_jobs=[{k:t[k] for k in ('source','target','net','restoration_required')} for t in targets[:5]], lost_groups=len(loss)),indent=2))
(o/'native-validation.json').write_text(json.dumps(dict(first_jobs=targets[:5],lost_connections=loss),indent=2))
