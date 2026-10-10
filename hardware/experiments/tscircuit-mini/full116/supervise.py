"""Run the frozen outer loop and retain truthful terminal/process provenance."""
from pathlib import Path
import subprocess,json,time,hashlib,os
root=Path(__file__).resolve().parent
cfg=json.loads((root/'command.json').read_text());env=dict(os.environ,**cfg['env'])
manifest=json.loads((root/'frozen-inputs.json').read_text())
def verify():
 return [n for n,h in manifest.items() if not (root/n).is_file() or hashlib.sha256((root/n).read_bytes()).hexdigest()!=h]
if verify():raise RuntimeError('Frozen inputs changed before launch')
with (root/'routing.log').open('w') as log:
 p=subprocess.Popen(cfg['command'],env=env,stdout=log,stderr=subprocess.STDOUT)
 identity=subprocess.check_output(['ps','-p',str(p.pid),'-o','pid=,lstart=,command='],text=True).strip()
 (root/'controller-process.json').write_text(json.dumps(dict(pid=p.pid,started=time.time(),identity=identity,command=cfg['command']),indent=2))
 hold=subprocess.Popen(['caffeinate','-i','-w',str(p.pid)])
 code=p.wait();hold.wait()
(root/'process-exit.json').write_text(json.dumps(dict(exit_code=code,finished=time.time()),indent=2))
if not (root/'termination.json').exists():
 (root/'termination.json').write_text(json.dumps(dict(reason='controller_failure' if code else 'missing_stop_record',plateau_observed=False,exit_code=code),indent=2))
(root/'frozen-verification.json').write_text(json.dumps(dict(checked=len(manifest),changed=verify()),indent=2))
