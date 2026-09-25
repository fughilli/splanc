"""Opt-in warm native DRC client. Errors/ambiguity/timeouts fall back to full CLI.

Use final=True for final acceptance/publication gates; warm requests never refill
zones. Caller must save/refill first, exactly as for the existing CLI wrapper.
"""
import hashlib,json,os,shutil,time,uuid
from pathlib import Path

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def warm(board,root,timeout=45):
 root=Path(root).resolve();board=Path(board).resolve();ready=json.loads((root/'ready.json').read_text())
 if ready['version']!='10.0.6':raise ValueError('Warm backend not qualified for this KiCad version')
 if sum(1 for _ in (root/'boards').iterdir())>=64:raise ValueError('Private snapshot budget exhausted; use CLI or start a new session')
 try:os.kill(ready['pid'],0)
 except ProcessLookupError:raise RuntimeError('Native warm host has exited')
 request=f'{time.time_ns():020d}-{uuid.uuid4().hex}';folder=root/'boards'/request;folder.mkdir()
 target=folder/ready['board_name'];before={}
 for suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru'):
  src=board.with_suffix(suffix)
  if src.exists():
   before[str(src)]=sha(src);shutil.copyfile(src,target.with_suffix(suffix))
 table=board.parent/'fp-lib-table'
 if table.exists():
  before[str(table)]=sha(table);(folder/'fp-lib-table').write_text(table.read_text().replace('${KIPRJMOD}',str(board.parent)))
 if any(sha(p)!=h for p,h in before.items()):raise ValueError('Input changed during capture')
 pro=json.loads(target.with_suffix('.kicad_pro').read_text())
 if pro.get('board',{}).get('design_settings',{}).get('drc_exclusions'):raise ValueError('DRC exclusions require cold CLI')
 profile={ext:sha(target.with_suffix(ext)) if target.with_suffix(ext).exists() else None for ext in ('.kicad_pro','.kicad_dru')}
 profile['table']=sha(folder/'fp-lib-table') if (folder/'fp-lib-table').exists() else None
 if profile!=ready['policy']:raise ValueError('Project/rules/library policy changed')
 pending=root/'requests'/(request+'.tmp');pending.write_text(json.dumps(dict(board=str(target))));pending.rename(pending.with_suffix('.json'))
 reply=root/'replies'/(request+'.json');deadline=time.monotonic()+timeout
 while not reply.exists():
  if time.monotonic()>deadline:raise TimeoutError('Warm DRC deadline expired')
  time.sleep(.01)
 response=json.loads(reply.read_text())
 if not response.get('ok'):raise RuntimeError(response.get('error','Invalid warm reply'))
 if response['request_id']!=request or response['board_sha256']!=before[str(board)] or response['policy']!=profile or response['pid']!=ready['pid']:raise ValueError('Stale/mismatched response')
 if any(sha(p)!=h for p,h in before.items()):raise ValueError('Original input changed during evaluation')
 result=response['result']
 if not all(isinstance(result.get(key),list) for key in ('violations','unconnected_items','schematic_parity')):raise ValueError('Incomplete native result')
 result['source']=board.name
 result['_warm_native']={key:value for key,value in response.items() if key not in ('result','ok')}
 return result

def run_drc(cli,board,report,*,timeout=45,retries=1,env=None,service=None,final=False):
 # Import the preserved baseline only in the staged runtime or use the live cold
 # wrapper for experiment callers. Both retain retries and stale-report deletion.
 try:from pnr.native_drc import _run_cold as cold
 except ImportError:
  try:from pnr.native_drc_cli import run_drc as cold
  except ImportError:from pnr.native_drc import run_drc as cold
 config=os.environ if env is None else env;root=service or config.get('PNR_DRC_SERVICE')
 report=Path(report);report.unlink(missing_ok=True)
 if root and not final:
  try:
   result=warm(board,root,timeout)
   if result['violations'] or result['schematic_parity']:raise ValueError('Nonzero warm findings require exact CLI report')
   temporary=report.with_suffix(report.suffix+'.tmp');temporary.write_text(json.dumps(result,indent=2));temporary.replace(report);return result
  except Exception as error:
   report.with_suffix('.warm-fallback.json').write_text(json.dumps(dict(reason=str(error),board=str(board),time=time.time()),indent=2))
 return cold(cli,board,report,timeout=timeout,retries=retries,env=env)

# Preserve separate worker and caller timings; waiting time is not kernel CPU.
_run_drc=run_drc
def run_drc(cli,board,report,*,timeout=45,retries=1,env=None,service=None,final=False):
 started=time.perf_counter();cpu=time.process_time();result=None;error=None
 try:
  result=_run_drc(cli,board,report,timeout=timeout,retries=retries,env=env,service=service,final=final)
  return result
 except Exception as exc:
  error=repr(exc);raise
 finally:
  metadata=dict(schema='native-drc-profile-v1',wall_seconds=time.perf_counter()-started,caller_cpu_seconds=time.process_time()-cpu,backend='warm' if result and '_warm_native'in result else 'cli',final_gate=final,error=error,board=str(Path(board).resolve()))
  if result and '_warm_native'in result:metadata['worker']=result['_warm_native']
  Path(report).with_suffix('.timing.json').write_text(json.dumps(metadata,indent=2))
