"""Package r7 STEP parts and a portable, texture-packed Blender motion studio."""
from pathlib import Path
import json,hashlib,zipfile,shutil
root=Path.cwd();cad=root/'output/family-layout-r7';studio=root/'output/blender-motion-studio-r2'
assert (cad/'fit-validation.json').exists() and (studio/'project-validation.json').exists()
readme=(root/'hardware/mechanical/FAMILY-LAYOUT-R7.md').read_text()
(studio/'README.md').write_text(readme+'\nOpen splanc-motion-studio.blend and read START HERE in the Text Editor.\n')
archive=root/'hardware/mechanical/releases/splanc-family-layout-r7.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('README.md',readme)
 for prod in ('splanc','splanc-weather','max'):
  for p in (cad/prod).iterdir():
   if p.suffix in ('.step','.stl'):z.write(p,p.relative_to(cad))
 for name in ('compact-validation.json','fit-validation.json','usb-bridge-drc.json','design.json'):
  z.write(cad/name,name)
 z.write(root/'hardware/mechanical/family-layout.json','family-layout.json')
blendzip=studio/'splanc-motion-studio-r2.zip'
with zipfile.ZipFile(blendzip,'w',zipfile.ZIP_DEFLATED) as z:
 for name in ('splanc-motion-studio.blend','README.md','project-validation.json','entry-b.png','macro-roll.png','splanc-r7.png','max-r7.png'):z.write(studio/name,name)
for path in (archive,blendzip):
 with zipfile.ZipFile(path) as z:assert z.testzip() is None
manifest={p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [archive,blendzip,studio/'splanc-motion-studio.blend']}
(studio/'release-manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps(manifest,indent=2))
downloads=root/'output/mechanical-viewer/downloads';downloads.mkdir(exist_ok=True)
for p in [archive,blendzip]:shutil.copy2(p,downloads/p.name)
