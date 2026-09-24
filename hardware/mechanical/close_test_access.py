"""Close Mini board-test access in a separate mechanical checkpoint."""
from pathlib import Path
import cadquery as cq,json,shutil
from generate_enclosures import box
src=Path('output/button-flexure-r2');out=Path('output/button-dfa-r3');out.mkdir(exist_ok=True)
for p in src.rglob('*'):
 if p.is_file() and 'pogo-service-seal-cover' not in p.name:
  dest=out/p.relative_to(src);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
s=json.loads((src/'scene.json').read_text());s['items']=[i for i in s['items'] if 'pogo-service-seal-cover' not in i['name']]
board=json.loads(Path('output/mechanical/mini-board.json').read_text());x,y=next(c['position'] for c in board['components'] if c['ref']=='TP1')
report={}
for product in ('mini','mini-weather'):
 p=out/product/'base.step';base=cq.importers.importStep(str(p));patch=box(x-5.7,y-6.95,0,11.4,13.9,2.2)
 before=base.val().Volume();base=base.union(patch);assert base.val().isValid() and len(base.val().Solids())==1
 assert base.intersect(patch).val().Volume()>patch.val().Volume()-.0001
 cq.exporters.export(base,str(p));v,f=base.val().tessellate(.04,.12)
 for i in s['items']:
  if i['product']==product and i['name']=='base':i.update(vertices=[[a.x,a.y,a.z] for a in v],faces=[list(t) for t in f])
 report[product]={'pogo_location_mm':[x,y],'floor_thickness_mm':2.2,'added_material_mm3':base.val().Volume()-before,'through_opening_closed':True}
s['revision']='button-dfa-r3-in-progress';(out/'scene.json').write_text(json.dumps(s));(out/'test-access-validation.json').write_text(json.dumps(report,indent=2));print(report)
