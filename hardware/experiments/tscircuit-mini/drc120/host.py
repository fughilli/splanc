"""Native DRC on wx main thread in a private initialized KiCad editor.

The model is isolated from the visible seed. No sockets or UI clicking. Full
native checks run every request; this is NOT regional/incremental DRC.
"""
import hashlib,json,os,sys,time,traceback,resource
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from report import parse,item_index
from model import split_board,synchronize
from dependencies import library_inputs,verify
import pcbnew as k
import wx

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def put(p,data):
 p=Path(p);tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(data,indent=2));tmp.replace(p)
def policy(path):
 return {ext:sha(path.with_suffix(ext)) if path.with_suffix(ext).exists() else None for ext in ('.kicad_pro','.kicad_dru')} | {'table':sha(path.parent/'fp-lib-table') if (path.parent/'fp-lib-table').exists() else None}

class Host:
 def __init__(self,root):
  self.root=Path(root);self.board=None;self.loaded=None;self.parsed=None;self.calls=0;self.attempts=0;self.ready=False;self.keepalive=[]
  self.timer=wx.Timer();self.timer.Bind(wx.EVT_TIMER,self.tick);self.timer.Start(20)
 def tick(self,event):
  if not self.ready:
   try:
    visible=k.GetBoard()
    if not visible or not visible.GetFileName():return
    if any(isinstance(w,wx.Dialog) and w.IsModal() for w in wx.GetTopLevelWindows()):return
    self.seed=Path(visible.GetFileName());self.policy=policy(self.seed)
    self.library_inputs,self.footprint_ids=library_inputs(visible,k.SETTINGS_MANAGER.GetUserSettingsPath())
    for name in sorted({f.GetFPID().GetLibNickname().c_str() for f in visible.GetFootprints()}):k.GetFootprints(name)
    self.ready=True
    put(self.root/'ready.json',dict(pid=os.getpid(),version=k.GetBuildVersion(),started=time.time(),module=__file__,sha256=sha(__file__),policy=self.policy,board_name=self.seed.name,seed_sha256=sha(self.seed),library_inputs=self.library_inputs,footprint_ids=self.footprint_ids))
   except Exception:
    self.timer.Stop()
    put(self.root/'startup-error.json',dict(error=traceback.format_exc(),pid=os.getpid()))
    return
  requests=sorted((self.root/'requests').glob('*.json'))
  if not requests:return
  request=requests[0];self.timer.Stop();reply=self.root/'replies'/request.name
  try:
   data=json.loads(request.read_text())
   if data.get('op')=='stop':
    put(reply,dict(stopped=True));request.unlink();wx.GetApp().ExitMainLoop();return
   if self.attempts>=64:raise RuntimeError('Host request budget exhausted; use CLI or start a new session')
   self.attempts+=1
   started=time.perf_counter();cpu=time.process_time();path=Path(data['board']).resolve()
   if not path.is_relative_to(self.root/'boards'):raise ValueError('Only private input copies under boards/ are permitted')
   before=sha(path);profile=policy(path);verify(self.library_inputs)
   if profile!=self.policy:raise ValueError('Project/rules/library policy changed; cold CLI required')
   pro=json.loads(path.with_suffix('.kicad_pro').read_text())
   if pro.get('board',{}).get('design_settings',{}).get('drc_exclusions'):raise ValueError('DRC exclusions require CLI')
   mode=dict(mode='reuse');key=before;parse_time=0
   if key!=self.loaded:
    t=time.perf_counter();parsed=split_board(path.read_text());parse_time=time.perf_counter()-t
    incoming=k.LoadBoard(str(path))
    if incoming is None:raise ValueError('Native board load failed')
    ids=sorted({f.GetFPID().GetLibNickname().c_str()+':'+f.GetFPID().GetLibItemName().c_str() for f in incoming.GetFootprints() if f.GetFPID().GetLibNickname().c_str()})
    if ids!=self.footprint_ids:raise ValueError('Footprint library inventory changed; cold CLI required')
    self.keepalive.append(incoming)
    if self.board is not None:self.board,mode=synchronize(self.board,incoming,self.parsed,parsed,k,self.keepalive)
    else:self.board=incoming;mode=dict(mode='load')
    self.parsed=parsed;self.loaded=key
   load=time.perf_counter()-started;report=self.root/'reports'/(request.stem+'.rpt');t=time.perf_counter()
   if not k.WriteDRCReport(self.board,str(report),k.EDA_UNITS_MM,False):raise RuntimeError('Native DRC failed')
   drc_time=time.perf_counter()-t;t=time.perf_counter();result=parse(report.read_text(),item_index(self.board,k));conversion=time.perf_counter()-t
   verify(self.library_inputs)
   if sha(path)!=before or policy(path)!=profile:raise ValueError('Inputs changed during evaluation')
   result.update(coordinate_units='mm',kicad_version=k.GetBuildVersion(),source=path.name)
   self.calls+=1
   put(reply,dict(request_id=request.stem,result=result,ok=True,report=str(report),board_sha256=before,policy=profile,model_update=mode,parse_seconds=parse_time,load_seconds=load,drc_seconds=drc_time,conversion_seconds=conversion,wall_seconds=time.perf_counter()-started,cpu_seconds=time.process_time()-cpu,rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,pid=os.getpid()))
  except Exception:
   self.board=None;self.loaded=None;self.parsed=None
   put(reply,dict(ok=False,request_id=request.stem,error=traceback.format_exc(),pid=os.getpid()))
  request.unlink();self.timer.Start(20)

HOST=None
def start(root):
 global HOST
 HOST=Host(root)
