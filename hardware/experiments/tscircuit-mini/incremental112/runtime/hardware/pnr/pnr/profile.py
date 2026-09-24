"""Opt-in per-process profiles for isolated PnR phases and kernel experiments.

python -m pnr.profile --label case --module pnr.some_module ARG ...
PNR_PROFILE_DIR chooses output; unset means unprofiled execution.
CPU profiles measure this process only. Native subprocess wall time appears as
wait time; profile those children independently rather than attributing to Python.
"""
import argparse,cProfile,hashlib,json,os,pstats,resource,runpy,sys,time,uuid,threading
from pathlib import Path
from contextlib import contextmanager
spans={}
active=False
@contextmanager
def span(name):
 if not os.environ.get('PNR_PROFILE_DIR'):yield;return
 start=time.perf_counter();cpu=time.process_time()
 try:yield
 finally:
  record=spans.setdefault(name,dict(calls=0,wall_seconds=0,cpu_seconds=0));record['calls']+=1;record['wall_seconds']+=time.perf_counter()-start;record['cpu_seconds']+=time.process_time()-cpu

def run(label,fn):
 global active
 dest=os.environ.get('PNR_PROFILE_DIR')
 if not dest or active:return fn()
 active=True
 root=Path(dest);root.mkdir(parents=True,exist_ok=True);key=f'{time.time_ns()}-{os.getpid()}-{uuid.uuid4().hex[:6]}';profile=cProfile.Profile();spans.clear();start=time.perf_counter();cpu=time.process_time();error=None
 stopped=threading.Event()
 def checkpoint():
  while not stopped.wait(60):
   try:
    profile.dump_stats(str(root/(key+'.live.pstats')))
    record=dict(schema='pnr-profile-live-v1',label=label,pid=os.getpid(),wall_seconds=time.perf_counter()-start,cpu_seconds=time.process_time()-cpu,iteration=os.environ.get('PNR_LIVE_ITERATION'),candidate=os.environ.get('PNR_LIVE_CANDIDATE'),status='running',search_backend=os.environ.get('PNR_SEARCH_BACKEND','python'))
    temp=root/(key+'.live.tmp');temp.write_text(json.dumps(record));temp.replace(root/(key+'.live.json'))
   except Exception as ex:
    print('Profile checkpoint failed: '+repr(ex),file=sys.stderr)
 thread=threading.Thread(target=checkpoint,daemon=True);thread.start()
 try:
  profile.enable();return fn()
 except BaseException as ex:
  if not isinstance(ex,SystemExit) or ex.code not in (0,None):error=repr(ex)
  raise
 finally:
  stopped.set();thread.join();profile.disable();active=False;wall=time.perf_counter()-start;process=time.process_time()-cpu;raw=root/(key+'.pstats');profile.dump_stats(str(raw));stats=pstats.Stats(profile);rows=[]
  for (path,line,name),(primitive,calls,self_time,cumulative,callers) in stats.stats.items():
   rows.append(dict(file=path,line=line,function=name,calls=calls,primitive_calls=primitive,self_seconds=self_time,cumulative_seconds=cumulative))
  rows.sort(key=lambda x:x['self_seconds'],reverse=True)
  result=dict(schema='pnr-profile-v1',label=label,pid=os.getpid(),parent_pid=os.getppid(),iteration=os.environ.get('PNR_LIVE_ITERATION'),candidate=os.environ.get('PNR_LIVE_CANDIDATE'),wall_seconds=wall,cpu_seconds=process,max_rss_raw=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,rss_units='bytes on macOS; KiB on Linux',error=error,spans=spans,hot_functions=rows[:100],profile=str(raw.resolve()),python=sys.version,argv=sys.argv)
  sources={}
  for module in tuple(sys.modules.values()):
   name=getattr(module,'__name__','');path=getattr(module,'__file__',None)
   if name.startswith('pnr.') and path and Path(path).is_file():sources[str(Path(path).resolve())]=hashlib.sha256(Path(path).read_bytes()).hexdigest()
  library=os.environ.get('PNR_RUST_SEARCH_LIB')
  if library and Path(library).is_file():sources[str(Path(library).resolve())]=hashlib.sha256(Path(library).read_bytes()).hexdigest()
  result.update(source_hashes=sources,search_backend=os.environ.get('PNR_SEARCH_BACKEND','python'),function_timer='elapsed; process CPU recorded separately')
  (root/(key+'.json')).write_text(json.dumps(result,indent=2))
  for suffix in ('.live.json','.live.pstats'):
   (root/(key+suffix)).unlink(missing_ok=True)
  from pnr.live import emit
  emit('profile_complete',data={k:v for k,v in result.items() if k not in ('hot_functions','spans','argv')})
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--label',required=True);ap.add_argument('--module',action='store_true');ap.add_argument('target');ap.add_argument('args',nargs=argparse.REMAINDER);a=ap.parse_args();sys.argv=[a.target,*a.args]
 run(a.label,lambda:runpy.run_module(a.target,run_name='__main__') if a.module else runpy.run_path(a.target,run_name='__main__'))
if __name__=='__main__':
 sys.modules['pnr.profile']=sys.modules[__name__]
 main()
