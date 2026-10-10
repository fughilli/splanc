"""Round-trip safety checks for exported embossed shell STEP files."""
from pathlib import Path
import json
import cadquery as cq
root=Path('output/product-renders-black');results={}
for product,top in [('mini',20),('splanc',25),('max',53)]:
 shapes={name:cq.importers.importStep(str(root/product/(name+'.step'))) for name in ('base','lid')}
 result={name:{'valid':s.val().isValid(),'solids':len(s.val().Solids()),'volume_mm3':s.val().Volume()} for name,s in shapes.items()}
 result['shell_overlap_mm3']=shapes['base'].intersect(shapes['lid']).val().Volume()
 result['emboss_height_mm']=shapes['lid'].val().BoundingBox().zmax-top
 assert result['shell_overlap_mm3']<.01,(product,result)
 assert all(result[name]['valid'] and result[name]['solids']==1 and result[name]['volume_mm3']>0 for name in shapes)
 assert abs(result['emboss_height_mm'])<.001
 logo=cq.importers.importStep(str(root/product/'logo-white-inlay.step'))
 result['logo_valid']=logo.val().isValid()
 result['logo_lid_overlap_mm3']=logo.intersect(shapes['lid']).val().Volume()
 result['logo_top_mm']=logo.val().BoundingBox().zmax
 assert result['logo_valid'] and result['logo_lid_overlap_mm3']<.001
 assert abs(result['logo_top_mm']-top)<.001
 assert abs(logo.val().BoundingBox().zmin-(top-.7))<.001
 results[product]=result
(root/'validation.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results,indent=2))
