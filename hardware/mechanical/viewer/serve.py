"""Serve only the built mechanical viewer, with gzip mesh delivery."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
import argparse,re
p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8767);p.add_argument('--bind',default='127.0.0.1');a=p.parse_args()
root=Path('output/mechanical-viewer').resolve()
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(root),**kwargs)
 def end_headers(self):
  path=urlsplit(self.path).path
  if '/advertising-kit/sim/' in path:
   immutable=re.search(r'/models/(mini|splanc|max)-[a-f0-9]{16}\.(json|bin|bin\.gz)$',path)
   self.send_header('Cache-Control','public, max-age=31536000, immutable' if immutable else 'no-cache')
  super().end_headers()
 def do_GET(self):
  if self.path in ('/mini.json','/splanc.json','/max.json','/splanc-weather.json') and 'gzip' in self.headers.get('Accept-Encoding',''):
   payload=(root/(self.path[1:]+'.gz')).read_bytes();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Encoding','gzip');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
  else:super().do_GET()
print(f'Serving mechanical viewer on {a.bind}:{a.port}',flush=True)
# Allow parallel ES-module and model requests beyond the default backlog of 5.
class ViewerServer(ThreadingHTTPServer):
 request_queue_size=64
ViewerServer((a.bind,a.port),Handler).serve_forever()
