"""r7: compact MAX stack, enclosed USB and underside Ethernet latch access.
Run from repository root with the CadQuery runtime. r6 remains immutable.
"""
from pathlib import Path
import json, shutil
import cadquery as cq
from generate_enclosures import box,cylinder
SRC=Path('output/family-layout-r6'); OUT=Path('output/family-layout-r7')
OUT.mkdir(exist_ok=True)
for p in SRC.iterdir():
 if p.is_dir():shutil.copytree(p,OUT/p.name,dirs_exist_ok=True)
 elif p.name in ('design.json','user-view.json'):shutil.copy2(p,OUT/p.name)
s=json.loads((SRC/'scene.json').read_text())
def read(n):return cq.importers.importStep(str(SRC/'max'/f'{n}.step'))
def emit(n,q,material=None):
 assert q.val().isValid(),n
 cq.exporters.export(q,str(OUT/'max'/f'{n}.step'))
 if n in ('base','lid'):cq.exporters.export(q,str(OUT/'max'/f'{n}.stl'))
 v,f=q.val().tessellate(.04,.12)
 old=next((i for i in s['items'] if i['product']=='max' and i['name']==n),None)
 s['items']=[i for i in s['items'] if not(i['product']=='max' and i['name']==n)]
 s['items'].append(dict(product='max',name=n,material=material or old['material'],vertices=[[a.x,a.y,a.z] for a in v],faces=[list(t) for t in f]))
b=read('base')
# Remove an empty horizontal band of wall, preserving the joint and lid details.
b=b.intersect(box(-30,-10,-5,340,155,35)).union(b.intersect(box(-30,-10,40,340,155,30)).translate((0,0,-10)))
l=read('lid').translate((0,0,-10))
# Continuous exterior wall hides both USB sockets and the rigid internal bridge.
b=b.union(box(226,131.2,2.5,41,2.8,34.5))
# Open-bottom finger tunnel, ending beyond the PCB edge at Y113.
# The 19mm-wide port opening continues upward; the lower relief is 22mm wide.
finger=box(263.8,114,-1,22,22,14,2)
b=b.cut(finger)
for x,y in [(4,4),(4,130),(167.5,4),(167.5,130),(288,4),(288,130)]:b=b.cut(cylinder(x,y,25,1.25,15))
# Internal pocket follows the lowered USB-C shell; outer USB cover remains solid.
c=read('usb-male-C-envelope').translate((0,0,-8)).val().BoundingBox()
b=b.cut(box(c.xmin-.3,c.ymin-.3,c.zmin-.3,c.xlen+.6,c.ylen+.6,c.zlen+.6))
h=cq.importers.importStep('output/mechanical/max/lv-pcb-envelope.step').translate((-225,-8,0)).rotate((0,0,0),(0,0,1),90).translate((285,28,-8)).val().BoundingBox()
b=b.cut(box(h.xmin-.3,h.ymin-.3,h.zmin-.3,h.xlen+.6,h.ylen+.6,h.zlen+.6))
b=b.cut(l)
emit('base',b);emit('lid',l);emit('logo-white-inlay',read('logo-white-inlay').translate((0,0,-10)))
for i in list(s['items']):
 if i['product']!='max':continue
 n=i['name']
 if n.startswith('case-screw'):emit(n,read(n).translate((0,0,-10)))
 elif n.startswith('lv-pcb-envelope'):i['vertices']=[[x,y,z-8] for x,y,z in i['vertices']]
 elif n.startswith('ribbon-clearance'):i['vertices']=[[x,y,z-10] for x,y,z in i['vertices']]
 elif n.startswith('hat-standoff'):emit(n,read(n).intersect(box(220,20,9.6,80,110,18.4)))
 elif n=='usb-jumper-pcb-envelope':emit(n,read(n).intersect(box(220,100,0,80,35,36.6)))
 elif n=='usb-male-C-envelope':emit(n,read(n).translate((0,0,-8)))
# STEP HAT is exported too, so STEP and viewer agree.
q=cq.importers.importStep('output/mechanical/max/lv-pcb-envelope.step').translate((-225,-8,0)).rotate((0,0,0),(0,0,1),90).translate((285,28,-8))
s['items']=[i for i in s['items'] if not(i['product']=='max' and i['name'].startswith('lv-pcb-envelope'))]
emit('lv-pcb-envelope',q,'pcb')
s['revision']='family-layout-r7';s['dimensions']['max']=[292,134,43]
(OUT/'scene.json').write_text(json.dumps(s))
report={'outside_mm':[292,134,43],'hat_bottom_z_mm':28,'standoff_mm':18.4,'previous_standoff_mm':26.4,'bridge_mm':[24,32,1.6],'bridge_connector_spacing_mm':18.4,'ethernet_finger_relief_mm':{'x':[263.8,285.8],'y':[114,136],'z':[-1,13]},'shell_overlap_mm3':b.intersect(l).val().Volume(),'base_solids':len(b.val().Solids()),'lid_solids':len(l.val().Solids())}
assert report['base_solids']==report['lid_solids']==1,report
assert report['shell_overlap_mm3']<1e-5
(OUT/'compact-validation.json').write_text(json.dumps(report,indent=2));print(report,flush=True)

(OUT/'validation.json').write_text(json.dumps({'revision':'family-layout-r7','compact':report,'other_products':'unchanged r6; see r6 validation'},indent=2))
design=json.loads((OUT/'design.json').read_text());design['revision']='family-layout-r7';design['layout_contract']='hardware/mechanical/family-layout.json';(OUT/'design.json').write_text(json.dumps(design,indent=2))
