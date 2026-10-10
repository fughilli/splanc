"""Read-only, bounded experiment status dashboard; never controls a router."""
import argparse,json,time,shutil
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
HTML='''<!doctype html><meta charset="utf-8"><title>Splanc performance experiments</title><style>body{font:16px system-ui;background:#101620;color:#e4edf9;margin:3vw}h1{font-size:26px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}article{background:#1c2737;padding:20px;border-radius:12px}a{color:#78c4ff}pre{font:13px ui-monospace;white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:#a5b3c5}</style><h1>Splanc performance experiments</h1><p class="muted">Live investigation status. Benchmarks and provisional candidates are not accepted routing results. Protected Mini: 48 opens, zero native DRC violations.</p><p id="disk"></p><main id="rows"></main><p id="updated" class="muted"></p><script>
async function update(){try{const r=await fetch('/status.json',{cache:'no-store'});const d=await r.json();document.querySelector('#disk').textContent=`External disk free: ${d.free_gib.toFixed(1)} GiB · Stop bulk output below 25 GiB · Budget 3 GiB per experiment`;const container=document.querySelector('#rows');container.replaceChildren();for(const [key,row] of Object.entries(d.experiments)){const el=document.createElement('article'),h=document.createElement('h2'),a=document.createElement('a'),p=document.createElement('pre');h.textContent=row.title;a.textContent='Open experiment';a.href=row.url;p.textContent=JSON.stringify(row.progress,null,2);el.append(h,a,p);container.append(el)}document.querySelector('#updated').textContent='Polled '+new Date().toLocaleTimeString()}catch(e){document.querySelector('#updated').textContent='Status fetch failed: '+e.message}}update();setInterval(update,3000)
</script>'''
def main():
 p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--port',type=int,default=8774);a=p.parse_args();root=a.root.resolve()
 class Handler(BaseHTTPRequestHandler):
  def do_GET(self):
   if self.path.split('?')[0]=='/status.json':
    rows={}
    for name,title,port in [('gpu','GPU and batched placement costs',8771),('cpu','CPU routing and worker efficiency',8772),('epochs','Routing epochs and DRC proxies',8773)]:
     path=root/name/'status.json'
     try:progress=json.loads(path.read_text())
     except (OSError,ValueError):progress={'status':'starting','phase':'profile and workload selection'}
     rows[name]={'title':title,'url':f'http://mac-mini.tail6b8ad3.ts.net:{port}/','progress':progress}
    data=json.dumps({'time':time.time(),'free_gib':shutil.disk_usage(root).free/2**30,'experiments':rows}).encode();mime='application/json'
   elif self.path.split('?')[0]=='/':data=HTML.encode();mime='text/html; charset=utf-8'
   else:self.send_error(404);return
   self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  def log_message(self,*args):pass
 ThreadingHTTPServer(('0.0.0.0',a.port),Handler).serve_forever()
if __name__=='__main__':main()
