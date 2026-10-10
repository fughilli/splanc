"""Package the checked clean CAD, portable Blender scene and review evidence."""
from pathlib import Path
import json,zipfile,hashlib,shutil
root=Path.cwd();cad=root/'output/compact-handheld-r9';studio=root/'output/blender-motion-studio-r4'
for p in [cad/'fit-validation.json',cad/'dfa-validation.json',cad/'visual-review.md',studio/'project-validation.json']:assert p.exists(),p
readme=(root/'hardware/mechanical/CLEAN-ENCLOSURES.md').read_text()
archive=root/'hardware/mechanical/releases/splanc-compact-handheld-r9.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('README.md',readme)
 for p in sorted(cad.glob('*/*')):
  if p.suffix in ('.step','.stl'):z.write(p,p.relative_to(cad))
 for name in ('fit-validation.json','dfa-validation.json','validation.json','design.json','visual-review.md'):z.write(cad/name,name)
 z.write(root/'hardware/mechanical/enclosure-spec.json','enclosure-spec.json')
blendzip=studio/'splanc-motion-studio-r4.zip'
with zipfile.ZipFile(blendzip,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('README.md',readme+'\nRead the Blender START HERE text block for camera controls.\n')
 for name in ('splanc-motion-studio.blend','project-validation.json','entry-b.png','macro-roll.png','mini-r9.png','splanc-r9.png','max-r9.png'):z.write(studio/name,name)
manifest={}
for p in (archive,blendzip):
 with zipfile.ZipFile(p) as z:assert z.testzip() is None
 manifest[p.name]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
 shutil.copy2(p,root/'output/mechanical-viewer/downloads'/p.name)
(cad/'release-manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps(manifest,indent=2))
