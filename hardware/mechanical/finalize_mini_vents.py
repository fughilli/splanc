"""Increase cosmetic pressure-vent pitch to admit all three 0.5mm chamfers."""
import json
from pathlib import Path
import cadquery as cq
from generate_enclosures import box,cylinder
R=Path('output/product-renders-final')
for p in ('mini','mini-weather'):
 q=cq.importers.importStep(str(R/p/'lid.step'));q=q.union(box(31,50.5,17.7,8,3,2.3))
 for x in (32.6,35,37.4):q=q.cut(cylinder(x,52,17,.55,4))
 edges=[e for e in q.val().Edges() if e.geomType()=='CIRCLE' and abs(e.Center().y-52)<.001 and abs(e.Center().z-20)<.001 and 31<e.Center().x<39]
 assert len(edges)==3,len(edges)
 q=q.newObject(edges).chamfer(.5);assert q.val().isValid() and len(q.val().Solids())==1
 cq.exporters.export(q,str(R/p/'lid.step'))
(R/'mini-vent-validation.json').write_text(json.dumps({'pitch_mm':2.4,'bore_diameter_mm':1.1,'chamfer_mm':.5,'minimum_web_at_mouth_mm':.3,'chamfered_vent_count':3},indent=2)+'\n')
print('All three Mini vents chamfered at0.5mm; pitch2.4mm')
