"""Handle ONLY explicit UI restart epochs; archive partial work, preserve rounds."""
from pathlib import Path
import argparse,subprocess,os,signal,time,json,hashlib

def processes():
 out={}
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,args='],text=True).splitlines():
  v=line.strip().split(None,2)
  if len(v)==3:out[int(v[0])]=(int(v[1]),v[2])
 return out

def stop_tree(pid,expected):
 rows=processes()
 if pid not in rows:return
 if expected not in rows[pid][1]:raise RuntimeError('Controller PID identity changed; refusing to stop')
 targets={pid}
 while True:
  more={p for p,(parent,cmd) in rows.items() if parent in targets}
  if more<=targets:break
  targets|=more
 for p in sorted(targets):
  try:os.kill(p,signal.SIGTERM)
  except ProcessLookupError:pass
 time.sleep(.5)
 remaining=processes()
 for p in targets:
  if p in remaining and remaining[p][1]==rows[p][1]:
   try:os.kill(p,signal.SIGKILL)
   except ProcessLookupError:pass

 deadline=time.monotonic()+3
 while time.monotonic()<deadline:
  remaining=processes()
  if not any(p in remaining and remaining[p][1]==rows[p][1] for p in targets):return
  time.sleep(.1)
 raise RuntimeError('Workers did not stop; partial boards were not archived')

def archive(root,epoch):
 dest=root/'interrupted'/f'epoch-{epoch:03d}';dest.mkdir(parents=True,exist_ok=False)
 for folder in sorted((root/'relocation').glob('round-*')):
  if not (folder/'result.json').exists():folder.rename(dest/folder.name)
 if (root/'termination.json').exists():(root/'termination.json').rename(dest/'termination-before-restart.json')
 return dest

def launch_spec(root):
 """Verify a staged runtime BEFORE stopping any running work."""
 manifest=root/'next-controller.json'
 if not manifest.exists():return dict(driver=str(Path(__file__).with_name('run.py').resolve()),wrapper='/private/tmp/pnr-runtime.py')
 spec=json.loads(manifest.read_text())
 files=spec['files']
 for name in ('driver','wrapper'):
  if spec[name] not in files:raise ValueError('Unhashed controller entry: '+name)
 for name,digest in files.items():
  if hashlib.sha256(Path(name).read_bytes()).hexdigest()!=digest:raise ValueError('Staged runtime changed: '+name)
 return spec

def main():
 ap=argparse.ArgumentParser();ap.add_argument('root',type=Path);ap.add_argument('--pid',required=True,type=int);ap.add_argument('--identity',required=True);a=ap.parse_args()
 root=a.root.resolve();control=root/'live/control.json';status=root/'restart-status.json'
 previous=json.loads(status.read_text()) if status.exists() else {}
 handled=previous.get('handled_epoch',0);pid=previous.get('controller_pid',a.pid);identity=previous.get('controller_identity',a.identity);child=None
 def record(**extra):
  obj=dict(handled_epoch=handled,controller_pid=pid,controller_identity=identity,time=time.time(),**extra);tmp=status.with_suffix('.tmp');tmp.write_text(json.dumps(obj,indent=2));tmp.replace(status)
 record(status='watching')
 while True:
  request=json.loads(control.read_text());epoch=request.get('restart_epoch',0)
  if epoch>handled:
   try:
    spec=launch_spec(root)
    record(status='stopping',requested_epoch=epoch);stop_tree(pid,identity)
    saved=archive(root,epoch)
    driver=Path(spec['driver']);env=dict(os.environ,PNR_RUN_ROOT=str(root))
    log=(root/f'restart-{epoch:03d}.log').open('w')
    child=subprocess.Popen(['python3',spec['wrapper'],str(driver)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);log.close()
    pid=child.pid;identity=str(driver);handled=epoch
    (saved/'restart.json').write_text(json.dumps(dict(request=request,driver=str(driver),driver_sha256=hashlib.sha256(driver.read_bytes()).hexdigest(),runtime=spec,new_pid=pid),indent=2))
    record(status='restarted',archive=str(saved))
   except Exception as ex:
    handled=epoch;record(status='failed',error=repr(ex))
  if child is not None and child.poll() is not None:
   record(status='controller_finished',exit_code=child.returncode);child=None
  time.sleep(1)
if __name__=='__main__':main()
