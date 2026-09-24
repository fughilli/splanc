"""Trim the 0.1mm loft construction overhang flush with MAX's outer wall."""
from pathlib import Path
import cadquery as cq,json
from generate_enclosures import box
R=Path('output/product-renders-final');records={}
for p in ('max','max-weather'):
 q=cq.importers.importStep(str(R/p/'base.step'));before=q.val().Volume();q=q.intersect(box(0,0,0,335,134,47))
 assert q.val().isValid() and len(q.val().Solids())==1
 cq.exporters.export(q,str(R/p/'base.step'));records[p]={'max_x_mm':q.val().BoundingBox().xmax,'construction_overhang_removed_mm3':before-q.val().Volume()}
(R/'panel-trim-validation.json').write_text(json.dumps(records,indent=2)+'\n');print(records)
