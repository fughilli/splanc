"""Bounded native validation; a stale report can never certify a new attempt."""
import json
import subprocess
from pathlib import Path

def run_drc(cli,board,report,*,timeout=45,retries=1,env=None):
    report=Path(report)
    command=[str(cli),'pcb','drc',str(board),'--format','json','--output',str(report)]
    log=report.with_suffix('.log')
    with log.open('w') as stream:
        for attempt in range(retries+1):
            if report.exists():report.unlink()
            try:
                subprocess.run(command,env=env,stdout=stream,stderr=subprocess.STDOUT,check=True,timeout=timeout)
                result=json.loads(report.read_text())
                if not isinstance(result.get('violations'),list) or not isinstance(result.get('unconnected_items'),list):
                    raise ValueError('incomplete native DRC report')
                return result
            except (subprocess.TimeoutExpired,subprocess.CalledProcessError,ValueError,OSError) as exc:
                if report.exists():report.unlink()
                stream.write('\nNative DRC attempt %d failed: %s\n'%(attempt+1,exc));stream.flush()
                if attempt==retries:raise
