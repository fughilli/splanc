"""Build offline/tailnet comparison gallery and archive the six motion previews."""
from pathlib import Path
import json,shutil,zipfile,hashlib,html
root=Path('output/motion-studies-r1');catalog=json.loads((root/'catalog.json').read_text())
head='''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Splanc motion studies</title><style>*{box-sizing:border-box}body{background:#090b0e;color:#eee;font:15px system-ui;max-width:1500px;margin:30px auto;padding:24px}h1{font-size:26px}h2{font-size:20px;margin-top:36px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}article{background:#15191e;border:1px solid #2d333c;border-radius:10px;padding:12px}video{width:100%;aspect-ratio:16/9;background:black}h3{font-size:15px}button,a{color:#c1f0e1}button{background:#29333b;border:0;border-radius:4px;padding:7px 10px;margin:4px;cursor:pointer}p{color:#a7b0ba;line-height:1.5}@media(max-width:850px){.grid{grid-template-columns:1fr}}</style><h1>Splanc · motion studies / 01</h1><p>Low-quality motion selection · 640×360 · 24fps · current r5 CAD. Mini and Splanc/GNSS use the same rectangular button design; MAX has no external button array.</p>'''
parts=[head]
for kind,title in [('entrance','Diagonal entrances · black / HDRI reflections'),('family','Reverse crash zoom · charcoal velvet')]:
 parts.append('<h2>'+title+'</h2><div class="grid">')
 for s in catalog:
  if s['kind']!=kind:continue
  n=s['name'];movie=root/n/(n+'.mp4');assert movie.stat().st_size>10000,movie
  poster=f"{n}/frame-{s['frames']:03}.png"
  parts.append(f'''<article><h3>{html.escape(s['label'])}</h3><video id="{n}" controls muted loop playsinline preload="metadata" poster="{poster}" src="{n}/{n}.mp4"></video><div><button onclick="document.getElementById('{n}').play()">Play</button><button onclick="const v=document.getElementById('{n}');v.pause();v.currentTime=v.duration/2">Middle</button><button onclick="const v=document.getElementById('{n}');v.pause();v.currentTime=Math.max(0,v.duration-.08)">End</button><a download href="{n}/{n}.mp4">MP4</a></div></article>''')
 parts.append('</div>')
parts.append('<p>Motion and geometry preview only. Noise, denoising softness and lack of motion blur are intentional at this stage. Choose an entrance and a family arrangement before refinement.</p>')
(root/'index.html').write_text(''.join(parts))
serve=Path('output/mechanical-viewer/motion-studies');serve.mkdir(exist_ok=True)
files=[root/'index.html',root/'catalog.json',root/'family-button-audit.json',root/'video-validation.json']
for s in catalog:
 n=s['name'];files.extend([root/n/(n+'.mp4'),root/n/'shot.json',root/n/f"frame-{s['frames']:03}.png"])
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files};(root/'SHA256.json').write_text(json.dumps(manifest,indent=2));files.append(root/'SHA256.json')
archive=Path('hardware/mechanical/releases/splanc-motion-studies-r1-20260922.zip')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 for p in files:
  rel=p.relative_to(root);z.write(p,rel);dest=serve/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
 z.write('hardware/mechanical/MOTION-STUDIES.md','README.md')
with zipfile.ZipFile(archive) as z:assert z.testzip() is None
print(archive,archive.stat().st_size,hashlib.sha256(archive.read_bytes()).hexdigest())
