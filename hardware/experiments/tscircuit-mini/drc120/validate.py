"""Compare cold CLI and warm native errors, including restoration after faults."""
import argparse,json,time,sys,collections,re
from pathlib import Path
from client import run_drc,warm
p=argparse.ArgumentParser();p.add_argument('fixtures',type=Path);p.add_argument('service',type=Path);p.add_argument('out',type=Path);a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
CLI='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
def signature(r):
 return {key:sorted((v['type'],v['severity'],tuple(sorted(i['uuid'] for i in v.get('items',[])))) for v in r[key]) for key in ('violations','unconnected_items','schematic_parity')}
rows=[]
for i,name in enumerate(('baseline','open','baseline','width','baseline','short','baseline','via','baseline','clearance','baseline','placement','baseline')):
 board=a.fixtures/(name+'.kicad_pcb');prefix=a.out/f'{i:02d}-{name}'
 t=time.perf_counter();cold=run_drc(CLI,board,prefix.with_suffix('.cold.json'),final=True);coldtime=time.perf_counter()-t
 t=time.perf_counter();hot=warm(board,a.service);warmtime=time.perf_counter()-t;prefix.with_suffix('.warm.json').write_text(json.dumps(hot,indent=2))
 exact=signature(cold)==signature(hot);row=dict(case=name,cold_seconds=coldtime,warm_seconds=warmtime,opens=len(hot['unconnected_items']),violations=len(hot['violations']),exact_signature_match=exact,model_update=hot['_warm_native']['model_update']);rows.append(row);print(json.dumps(row),flush=True)
 (a.out/'results.json').write_text(json.dumps(rows,indent=2))
 if not exact:
  # KiCad's first-error-per-item suppression depends on native item order.
  # Never substitute this report: the adapter MUST fall back to exact CLI.
  from unittest.mock import patch
  import importlib
  try:cold_module=importlib.import_module('pnr.native_drc_cli')
  except ImportError:cold_module=importlib.import_module('pnr.native_drc')
  cold_function='_run_cold' if hasattr(cold_module,'_run_cold') else 'run_drc'
  with patch.object(cold_module,cold_function,wraps=getattr(cold_module,cold_function)) as native_cli:
   gate=run_drc(CLI,board,prefix.with_suffix('.adapter.json'),service=a.service)
   native_cli.assert_called_once()
  if '_warm_native' in gate or gate!=json.loads(prefix.with_suffix('.adapter.json').read_text()):raise AssertionError('Fallback was not the exact fresh CLI output')
  if not gate['violations'] and not gate['unconnected_items']:raise AssertionError('CLI fallback missed fault')
  row['fallback_cli_verified']=True
  row['fallback_exact_uuid_match']=signature(gate)==signature(cold)
  (a.out/'results.json').write_text(json.dumps(rows,indent=2))
 expected={'open':{'via_dangling'},'width':{'track_width'},'short':{'shorting_items'},'via':{'annular_width','via_diameter'},'clearance':{'clearance'},'placement':{'track_dangling'}}
 for result in (cold,hot):
  if not expected.get(name,set())<={v['type'] for v in result['violations']}:raise AssertionError('Expected native fault missing: '+name)
 if name!='baseline' and not hot['violations'] and not hot['unconnected_items']:raise AssertionError('Fault undetected')
 if name=='baseline' and (hot['violations'] or hot['unconnected_items']):raise AssertionError('Restoration did not clear fault')
