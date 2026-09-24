"""Explicit-interface live PnR telemetry, immutable pins and annotated snapshots."""
import argparse,copy,json,os,re,subprocess,threading,time,uuid,sys
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
ap=argparse.ArgumentParser();ap.add_argument('root',type=Path);ap.add_argument('--port',type=int,default=8766);ap.add_argument('--listen',action='append');ap.add_argument('--allow-origin',action='append',default=[]);a=ap.parse_args();root=a.root.resolve();root.mkdir(parents=True,exist_ok=True)
repo=Path(__file__).resolve().parents[3];assets=Path(__file__).parent/'dist';lock=threading.RLock();state=dict(schema='pnr-live-state-v1',run=str(root.parent),revision=0,lanes={},events=[],search={},errors=[]);seen=set();cache={}
sys.path.insert(0,str(repo/'hardware/pnr'))
from pnr.runtime_controls import read as read_controls,write as write_controls,LIMITS
from settings import seed as seed_settings,save as save_settings
preferences=repo/'output/pnr-settings.json'
state['controls']=seed_settings(root/'control.json',preferences);state['active_controls']=None
ki='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3'
def geometry(event):
 sha=event['board_sha256']
 if sha not in cache:
  folder=root/'geometry';folder.mkdir(exist_ok=True);f=folder/(sha+'.json')
  if not f.exists():
   with (folder/(sha+'.log')).open('w') as log:subprocess.run([ki,str(Path(__file__).parent/'extract.py'),event['board'],str(f)],env=dict(os.environ,PYTHONPATH=str(repo/'hardware/pnr')),stdout=log,stderr=subprocess.STDOUT,check=True,timeout=40)
  cache[sha]=json.loads(f.read_text())
 return cache[sha]
def from_graph(g):
 import math
 parts=[]
 for c in g['components']:
  angle=math.radians(c['rot']);pads=[]
  for p in c['pads']:
   x,y=p['offset'];xy=[c['pos'][0]+x*math.cos(angle)-y*math.sin(angle),c['pos'][1]+x*math.sin(angle)+y*math.cos(angle)]
   pads.append(dict(number=p['name'],net=p['net'],xy=xy,size=p['size'],angle=c['rot'],shape='rect',layers=['F.Cu' if c['side']=='top' else 'B.Cu']))
  parts.append(dict(ref=c['ref'],xy=c['pos'],pads=pads))
 return dict(frame='mm-y-up',width=g['outline']['width'],height=g['outline']['height'],parts=parts,tracks=[],vias=[],zones=[])
def ingest():
 event_dir=root/'events';event_dir.mkdir(exist_ok=True);last_mtime=None;last_restart=None
 while True:
  restart_file=root.parent/'restart-status.json'
  if restart_file.exists():
   stamp_restart=restart_file.stat().st_mtime_ns
   if stamp_restart!=last_restart:
    with lock:state['restart_status']=json.loads(restart_file.read_text());state['revision']+=1
    last_restart=stamp_restart
  stamp=event_dir.stat().st_mtime_ns
  if stamp==last_mtime:
   time.sleep(.25);continue
  # Files are atomically renamed into this immutable event directory. A rename
  # during this scan changes mtime and is discovered on the next pass.
  last_mtime=stamp
  with os.scandir(event_dir) as entries:
   pending=sorted(entry.name for entry in entries if entry.name.endswith('.json') and entry.name not in seen)
  for name in pending:
   f=event_dir/name
   if f.name in seen:continue
   try:
    e=json.loads(f.read_text());geo=geometry(e) if 'board' in e else (from_graph(e['layout']) if 'layout' in e else None)
    with lock:
     lane=state['lanes'].setdefault(e['candidate'],dict(id=e['candidate'],draft={},costs={},frames=[]));lane.update(event_id=e['id'],time=e['time'],iteration=e['iteration'],kind=e['kind'])
     if e['data'].get('phase'):lane['phase']=e['data']['phase']
     if e['kind']=='controls_applied':state['active_controls']=e['data']
     if e['kind']=='worker_config_applied':lane['worker_config']=e['data']
     if e['kind']=='phase_complete':lane['phase']=e['data']['name'];lane['opens']=e['data']['opens'];lane['violations']=e['data']['violations']
     if geo:
      if lane.get('geometry') and e.get('board_sha256')!=lane.get('board_sha256'):lane['previous']=lane['geometry']
      lane['geometry']=geo;lane['board_sha256']=e.get('board_sha256');lane['geometry_event_id']=e['id'];lane['draft']={}
     if e['kind']=='phase_complete':lane['frames'].append(dict(name=e['data']['name'],board_sha256=e['board_sha256'],event_id=e['id'],opens=e['data']['opens'],violations=e['data']['violations']))
     if e['kind']=='route_result':lane['opens']=e['data'].get('opens');lane['last_route']=e['data'];lane['copper_changed_at']=time.time() if e['data'].get('accepted') else lane.get('copper_changed_at',0)
     if e['kind']=='candidate_queued':lane['moves']=e['data'].get('moves',[]);lane['cost']=e['data'].get('cost')
     if e['kind']=='route_start':lane['target']=e['data']['target']
     if e['kind']=='signal_net_added':lane['draft'][e['data']['net']]=e['data']['tracks']
     if e['kind']=='signal_net_removed':lane['draft'].pop(e['data']['net'],None)
     if e['kind']=='placement_costs':lane['costs'][e['data']['ref']]=e['data']
     if e['kind']=='batch_alternatives':state['search'][str(e['iteration'])]=e['data']
     if e['kind'] in ('candidate_queued','candidate_start','candidate_complete','candidate_failed'):lane['status']=e['kind'].removeprefix('candidate_')
     if e['kind']=='iteration_complete':lane['status']='accepted' if e['data'].get('accepted') else 'rejected'
     summary={k:e[k] for k in ('id','time','kind','candidate','iteration')};summary['data']={k:v for k,v in e['data'].items() if k not in ('tracks','candidates','alternatives','probes','electrical_audit','pad_entry','final')};state['events'].append(summary);state['events']=state['events'][-300:];state['revision']+=1
    seen.add(f.name)
   except Exception as ex:
    with lock:state['errors'].append(dict(file=f.name,error=str(ex)));state['errors']=state['errors'][-10:];state['revision']+=1
    seen.add(f.name)
  time.sleep(.25)
def current(selected=None,full=True):
 with lock:
  if full:return copy.deepcopy(dict(state,server_time=time.time()))
  # Filter before copying: unselected board geometry never enters the copy.
  lanes={key:{k:v for k,v in lane.items() if key==selected or k not in ('geometry','previous','draft')} for key,lane in state['lanes'].items()}
  return copy.deepcopy(dict(state,lanes=lanes,server_time=time.time()))
response_cache={}
def state_response(query):
 with lock:
  selected=query.get('lane',[None])[0]
  selected=selected or next((k for k in state['lanes'] if not k.endswith('/search')),None)
  rev=state['revision']
  if query.get('since',[None])[0]==str(rev) and query.get('run',[None])[0]==state['run']:
   return json.dumps(dict(unchanged=True,revision=rev,run=state['run']),separators=(',',':')).encode()
  key=(rev,selected)
  if key not in response_cache:
   # Cache only the current revision; no retained historical geometry copies.
   for old in list(response_cache):
    if old[0]!=rev:del response_cache[old]
   response_cache[key]=json.dumps(current(selected,full=False),separators=(',',':')).encode()
  return response_cache[key]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,obj,status=200):
  raw=obj if isinstance(obj,bytes) else json.dumps(obj,separators=(',',':')).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  path=self.path.split('?')[0]
  if path=='/api/controls':
   return self.send(dict(requested=read_controls(root/'control.json'),active=state.get('active_controls'),limits=LIMITS,max_total_workers=16))
  if path=='/api/state':
   return self.send(state_response(parse_qs(urlparse(self.path).query)))
  if path.startswith('/api/geometry/'):
   sha=path.rsplit('/',1)[-1]
   if not re.fullmatch('[a-f0-9]{64}',sha) or sha not in cache:return self.send({'error':'not found'},404)
   return self.send(cache[sha])
  if path.startswith('/api/snapshots/'):
   name=path.rsplit('/',1)[-1]
   if not re.fullmatch('[a-f0-9]{32}',name):return self.send({'error':'invalid id'},400)
   p=root/'snapshots'/(name+'.json')
   return self.send(json.loads(p.read_text())) if p.exists() else self.send({'error':'not found'},404)
  f=assets/('index.html' if path=='/' else path.lstrip('/'))
  if not f.resolve().is_relative_to(assets.resolve()) or not f.is_file():return self.send({'error':'not found'},404)
  raw=f.read_bytes();self.send_response(200);self.send_header('Cache-Control','no-store');self.send_header('Content-Type','text/html' if f.suffix=='.html' else 'application/javascript' if f.suffix=='.js' else 'text/css');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_POST(self):
  if self.headers.get('Origin') not in [None,f'http://127.0.0.1:{a.port}',f'http://localhost:{a.port}',*a.allow_origin]:return self.send({'error':'origin rejected'},403)
  size=int(self.headers.get('Content-Length',0))
  if size>1000000:return self.send({'error':'request too large'},413)
  try:
   body=json.loads(self.rfile.read(size) or '{}')
   if self.path=='/api/controls':
    with lock:
     updated=save_settings(root/'control.json',preferences,body['values'],body.get('expected_revision'),body.get('apply_mode','boundary'));state['controls']=updated;state['revision']+=1
     folder=root/'control-history';folder.mkdir(exist_ok=True);(folder/(str(updated['revision'])+'.json')).write_text(json.dumps(updated,indent=2))
    return self.send(updated)
   if self.path=='/api/pin':
    key=uuid.uuid4().hex;snapshot=current();folder=root/'pins';folder.mkdir(exist_ok=True);(folder/(key+'.json')).write_text(json.dumps(snapshot));return self.send(dict(pin_id=key,state=snapshot))
   if self.path=='/api/snapshot':
    pin=body['pin_id']
    if not re.fullmatch('[a-f0-9]{32}',pin):raise ValueError('invalid pin')
    snapshot=json.loads((root/'pins'/(pin+'.json')).read_text());rects=body.get('annotations',[])
    selected=body.get('view',{});selected_lane=snapshot['lanes'].get(selected.get('lane'),{});selected_phase=selected.get('phase','live')
    if selected_phase!='live':
     frame=selected_lane['frames'][int(selected_phase)];snapshot['selected_geometry']=cache[frame['board_sha256']]
    if len(rects)>500:raise ValueError('too many rectangles')
    for rect in rects:
     if len(rect['bounds'])!=4 or not all(isinstance(v,(int,float)) and abs(v)<100000 for v in rect['bounds']):raise ValueError('invalid bounds')
    key=uuid.uuid4().hex;bundle=dict(schema='pnr-annotated-snapshot-v1',id=key,created_at=time.time(),coordinate_frame='mm-y-up',state=snapshot,annotations=rects,view=body.get('view',{}),note=body.get('note','')[:10000]);folder=root/'snapshots';folder.mkdir(exist_ok=True);dest=folder/(key+'.json');dest.write_text(json.dumps(bundle,indent=2));return self.send(dict(id=key,path=str(dest),url='/api/snapshots/'+key))
   self.send({'error':'not found'},404)
  except (ValueError,KeyError,FileNotFoundError) as ex:self.send({'error':str(ex)},400)
servers=[ThreadingHTTPServer((host,a.port),Handler) for host in (a.listen or ['127.0.0.1'])]
threading.Thread(target=ingest,daemon=True).start()
for server in servers[:-1]:threading.Thread(target=server.serve_forever,daemon=True).start()
for server in servers:print(f'Live PnR: http://{server.server_address[0]}:{a.port}',flush=True)
servers[-1].serve_forever()
