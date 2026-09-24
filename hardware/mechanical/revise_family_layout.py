"""r6 mechanical layout: east Splanc LED ports and rotated compact MAX Pi bay."""
from pathlib import Path
import json,copy,shutil
import cadquery as cq
from generate_enclosures import box,cylinder,ring
SRC=Path('output/button-dfa-r5');FALL=Path('output/product-renders-campaign-r3');OUT=Path('output/family-layout-r6');OUT.mkdir(exist_ok=True)
s=json.loads((SRC/'scene.json').read_text());items=copy.deepcopy(s['items']);reports={}
def read(prod,name):
 p=SRC/prod/(name+'.step')
 if not p.exists():p=FALL/prod/(name+'.step')
 return cq.importers.importStep(str(p))
def emit(prod,name,q,mat):
 global items
 assert q.val().isValid(),(prod,name)
 v,f=q.val().tessellate(.04,.12)
 items=[i for i in items if not(i['product']==prod and i['name']==name)]
 items.append(dict(product=prod,name=name,material=mat,vertices=[[a.x,a.y,a.z] for a in v],faces=[list(t) for t in f]))
 d=OUT/prod;d.mkdir(exist_ok=True);cq.exporters.export(q,str(d/(name+'.step')))
 if name in ('base','lid'):cq.exporters.export(q,str(d/(name+'.stl')),tolerance=.04,angularTolerance=.1)
def loft(x,y,z,w,h,top,W,H):return cq.Workplane('XY',origin=(x,y,z)).rect(w,h).workplane(offset=top-z).rect(W,H).loft()
def transform_pi(q):return q.translate((-225,-8,0)).rotate((0,0,0),(0,0,1),90).translate((285,28,0))
def pi_vertex(v):return [285-(v[1]-8),28+(v[0]-225),v[2]]
for prod in ('mini','mini-weather','splanc','splanc-weather','max','max-weather'):
 d=OUT/prod;d.mkdir(exist_ok=True)
 source=SRC/prod if (SRC/prod).exists() else FALL/prod
 for p in source.glob('*.step'):shutil.copy2(p,d/p.name)
for prod in ('splanc','splanc-weather'):
 b=read(prod,'base');l=read(prod,'lid')
 # Remove the old front connector well without touching the front rail/retainer.
 l=l.cut(box(33,2.3,11.5,54,26,14))
 l=l.union(box(33,-1,22.8,54,29.3,2.2))
 l=l.union(box(33,-3.2,15.5,54,2.2,9.5))
 # East edge bowl matches Mini: two vertically stacked top-entry connectors.
 outer=loft(94,30.5,12.4,13.2,24.2,25,17.2,31.2)
 inner=loft(94,30.5,14,10,21,25.5,14,28)
 l=l.union(outer).cut(inner).intersect(box(-3.2,-3.2,0,106.4,86.4,25))
 for x,y in [(94,25),(94,36)]:l=l.cut(box(x-4.4,y-4.7,11.5,8.8,9.4,16))
 # Weather collars follow their connectors; the front seam remains unchanged.
 for i in items:
  if i['product']!=prod:continue
  for idx,(old,new) in enumerate([((50,12),(94,25)),((70,12),(94,36))]):
   if i['name'].startswith(f'board.led{idx}.conn-') or i['name']==f'LED-connector-seal-{idx+1}':
    dx,dy=new[0]-old[0],new[1]-old[1];i['vertices']=[[v[0]+dx,v[1]+dy,v[2]] for v in i['vertices']]
   if i['name']==f'LED-connector-seal-{idx+1}':
    try:emit(prod,i['name'],read(prod,i['name']).translate((new[0]-old[0],new[1]-old[1],0)),'seal')
    except FileNotFoundError:pass
 emit(prod,'base',b,'shell_base');emit(prod,'lid',l,'shell_lid')
 cq.exporters.export(l.rotate((0,0,0),(1,0,0),180).translate((0,0,25)),str(OUT/prod/'lid-print.step'))
 reports[prod]={'shell_overlap_mm3':b.intersect(l).val().Volume(),'base_solids':len(b.val().Solids()),'lid_solids':len(l.val().Solids()),'connector_centers_mm':[[94,25],[94,36]],'buttons_unchanged':True}
 print(prod,reports[prod],flush=True)
# Rebuild only MAX's right service bay; preserve power distribution and its banks.
prod='max';W=292.;H=134.;b=read(prod,'base');l=read(prod,'lid')
b=b.intersect(box(-1,-1,-1,226,136,55));l=l.intersect(box(-1,-1,-1,226,136,55))
right=box(219.5,0,0,W-219.5,H,47,5).edges('>Z or <Z').chamfer(.5).cut(box(219.4,2.8,2.5,W-219.4-2.8,H-5.6,48,2))
rl=box(219.5,0,47,W-219.5,H,6,5).edges('>Z').chamfer(.5).cut(box(219.4,2.8,46.9,W-219.4-2.8,H-5.6,3.3,2))
# Return the tongue and shelf along the shortened end and joining long sides.
rl=rl.union(ring(3.1,3.1,45.2,W-6.2,H-6.2,2,.9,2).intersect(box(220,-1,44,80,136,10)))
rl=rl.union(ring(2.7,2.7,47,W-5.4,H-5.4,.8,1.3,2).intersect(box(220,-1,44,80,136,10)))
b=b.union(right);l=l.union(rl)
for x,y in [(281.5,31.5),(281.5,89.5),(232.5,31.5),(232.5,89.5)]:
 b=b.union(cylinder(x,y,2.5,3.6,5.5)).cut(cylinder(x,y,1.4,1.25,8))
# Case screws move with the new end wall; center screws remain over the power bay.
for x,y in [(W-4,4),(W-4,H-4)]:
 b=b.union(cylinder(x,y,2.5,3,44.5)).cut(cylinder(x,y,35,1.25,15))
 l=l.cut(cylinder(x,y,44.9,3.3,2.1)).cut(cylinder(x,y,45,1.75,10)).cut(cylinder(x,y,51,3,3))
# Recessed north panel gives direct access to all Ethernet/USB sockets.
# x is old y reversed; y is old x, so the USB bridge remains inside y134.
panel=box(226,112,6,61,2.8,24)
b=b.union(panel)
# Sloped walls support the recessed panel; no detached geometry.
outer=cq.Workplane('XZ',origin=(256.5,134,18)).rect(67,34).workplane(offset=22).rect(61,24).loft()
inner=cq.Workplane('XZ',origin=(256.5,134.1,18)).rect(61.4,28.4).workplane(offset=19.3).rect(55.4,18.4).loft()
b=b.union(outer).cut(inner)
for oldy,width,height in [(18.2,19,17),(37.1,17,18),(55,17,18)]:
 x=285-(oldy-8);b=b.cut(box(x-width/2,110,9,width,28,height))
# A solid front web conceals the USB jumper; the other port windows stay open.
b=b.union(box(245,131.2,2.5,22,2.8,44.5))
# Power and HDMI access on the new east end; generous shared cable recess.
b=b.cut(box(282,32,8.3,12,48,8.7))
# Vent roof and floor of Pi bay, retain the central power-bank lid styling.
for x in range(235,281,6):
 l=l.cut(box(x,40,49,2.4,55,6,1));b=b.cut(box(x,42,-1,2.4,44,4,1))
# Recenter the white inlay and its matching recess for the shorter enclosure.
logo=read(prod,'logo-white-inlay');l=l.union(logo);logo=logo.translate(((W-335)/2,0,0));l=l.union(box(W/2-43,52,50.2,86,30,2.8)).cut(logo)
# Reserve clearances for the rotating full assembly, including PCB substrate
# at the recessed port bank and the rigid USB bridge behind its opening.
for filename in ['pi5-pcb-envelope.step','usb-jumper-pcb-envelope.step']:
 q=transform_pi(cq.importers.importStep(str(Path('output/mechanical/max')/filename)))
 bb=q.val().BoundingBox();cut=box(bb.xmin-.3,bb.ymin-.3,bb.zmin-.3,bb.xlen+.6,bb.ylen+.6,bb.zlen+.6)
 if filename.startswith('pi5'):cut=cut.intersect(box(220,110,0,80,30,50))
 b=b.cut(cut);l=l.cut(cut)
b=b.cut(l)
# Outer top/end chamfers on newly constructed edges where supported by OCC.
chamfers=[]
for name,q in [('base',b),('lid',l)]:
 try:
  q=q.edges('>Z').chamfer(.5);chamfers.append(name)
 except Exception:pass
 if name=='base':b=q
 else:l=q
for i in items:
 if i['product']!='max':continue
 if i['name'].startswith('Pi-port-') or i['name'].startswith('lv-pcb-envelope'):i['vertices']=[pi_vertex(v) for v in i['vertices']]
 if i['name'] in ('case-screw-2','case-screw-4'):i['vertices']=[[v[0]+W-335,v[1],v[2]] for v in i['vertices']]
for n in ('case-screw-2','case-screw-4'):emit(prod,n,read(prod,n).translate((W-335,0,0)),'fastener')
# Include the rotated supports, cooler and USB bridge explicitly in CAD/viewer.
for p in Path('output/mechanical/max').glob('*.step'):
 if p.stem.startswith(('hat-standoff','active-cooler','usb-jumper','usb-male')):
  emit(prod,p.stem,transform_pi(cq.importers.importStep(str(p))),'nickel' if 'standoff' in p.stem or 'usb-male' in p.stem else 'pcb' if 'pcb' in p.stem else 'nylon')
emit(prod,'base',b,'shell_base');emit(prod,'lid',l,'shell_lid');emit(prod,'logo-white-inlay',logo,'logo_white')
reports[prod]={'outside_mm':[W,H,53],'previous_outside_mm':[335,H,53],'length_reduction_mm':335-W,'rotation_degrees':90,'pi_board_local_to_case':'[285-y,28+x,8+z]','port_sides':{'ethernet_usb':'north (output bank side)','power_hdmi':'east (end)'},'shell_overlap_mm3':b.intersect(l).val().Volume(),'base_solids':len(b.val().Solids()),'lid_solids':len(l.val().Solids()),'chamfered_new_top_edges':chamfers}
print(prod,reports[prod],flush=True)
s['items']=items;s['revision']='family-layout-r6';s['dimensions']['max']=[W,H,53]
(OUT/'scene.json').write_text(json.dumps(s));(OUT/'layout-validation.json').write_text(json.dumps(reports,indent=2))
for f in ('validation.json','design.json','user-view.json'):
 if (SRC/f).exists():shutil.copy2(SRC/f,OUT/f)

(OUT/'validation.json').write_text(json.dumps({'revision':'family-layout-r6','layout':reports,'button_reference':'unchanged r5 button strip; check_button_dfa.py reruns nominal motion checks'},indent=2))
design=json.loads((OUT/'design.json').read_text());design['revision']='family-layout-r6';design['layout_contract']='hardware/mechanical/family-layout.json';(OUT/'design.json').write_text(json.dumps(design,indent=2))
