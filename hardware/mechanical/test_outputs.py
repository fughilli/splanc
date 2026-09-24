"""Round-trip STEP checks on generated shell parts and interface assertions."""
import json,sys
from pathlib import Path
import cadquery as cq
root=Path(sys.argv[1] if len(sys.argv)>1 else 'output/mechanical')
for product in ('mini','max'):
 p=root/product;r=json.loads((p/'manifest.json').read_text());shells={}
 for part in ('base','lid'):
  q=cq.importers.importStep(str(p/(part+'.step')));assert q.val().isValid();assert len(q.val().Solids())==1,(product,part,'disconnected shell');assert q.val().Volume()>0;shells[part]=q
 assert shells['base'].intersect(shells['lid']).val().Volume()<.01
 assert r['checks']['base_lid_overlap_mm3']<.01
 print(product,r['checks']['outside_mm'],'STEP roundtrip: one valid solid per shell, no shell overlap')
