"""Remove the lower center-post remnants; hang the bosses from the port lintel.

Keep the floor and original wall/lower lip. Apply after the bank/trim passes.
"""
from pathlib import Path
import json
import cadquery as cq
from generate_enclosures import box,cylinder

root=Path('output/product-renders-final');report={}
floor=2.5;ceiling=12.3+21/2
interior=box(2.8,2.8,floor,329.4,128.4,ceiling-floor)
for product in ('max','max-weather'):
    q=cq.importers.importStep(str(root/product/'base.step'))
    before=q.val().Volume();checks=[]
    for y in (4,130):
        lower=cylinder(167.5,y,floor,3.001,ceiling-floor).intersect(interior)
        q=q.cut(lower)
        checks.append(q.intersect(lower).val().Volume())
    assert q.val().isValid() and len(q.val().Solids())==1
    assert max(checks)<1e-6
    cq.exporters.export(q,str(root/product/'base.step'))
    report[product]={'boss_bottom_z_mm':ceiling,'removed_mm3':before-q.val().Volume(),
                     'lower_boss_remnant_mm3':checks,'valid':True}
(root/'boss-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
