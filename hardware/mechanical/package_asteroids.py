"""Package an asteroid render as an offline viewer and a local served copy."""
import argparse,json,shutil,zipfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--hd',action='store_true');args=ap.parse_args()
name='asteroids-hd-r1' if args.hd else 'asteroids-r1'
root=Path('output')/name;shot=root/'asteroids'
video=shot/'asteroids.mp4';assert video.exists(),video
report=json.loads((root/'video-validation.json').read_text())['asteroids']
expected=[1920,1080] if args.hd else [640,360]
assert report['dimensions']==expected and report['frames']==(720 if args.hd else 192)
poster='frame-360.png' if args.hd else 'frame-096.png'
title='Splanc asteroid field · 30 seconds · Full HD' if args.hd else 'Splanc asteroid field · draft'
(root/'index.html').write_text(f'''<!doctype html><meta name="viewport" content="width=device-width"><title>{title}</title><body style="background:#050505;color:#eee;font:18px system-ui;margin:30px"><h1>{title}</h1><video controls loop playsinline preload="metadata" poster="asteroids/{poster}" style="width:min(100%,1440px)" src="asteroids/asteroids.mp4"></video><p>Zero-gravity SKU arrivals and collisions · actual relative product sizes.</p><a style="color:#9df" href="asteroids/asteroids.mp4" download>Download MP4</a></body>''')
files=[root/'index.html',root/'simulation.json',root/'catalog.json',root/'video-validation.json',video,shot/poster]
served=Path('output/mechanical-viewer')/('asteroids-hd' if args.hd else 'asteroids')
archive=Path('hardware/mechanical/releases')/f'splanc-{name}.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 for p in files:
  rel=p.relative_to(root);target=served/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target);z.write(p,rel)
print(archive,archive.stat().st_size)
