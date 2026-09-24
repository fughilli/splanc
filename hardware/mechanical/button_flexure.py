"""External registered PP flexure strip / compliant-tip geometric prototype.
Preserve r3; export new solids, poses and conservative tolerance checks.
"""
from pathlib import Path
import json,math,shutil
import cadquery as cq
from generate_enclosures import box,cylinder
R=Path('output/button-flexure-r1');R.mkdir(exist_ok=True);SRC=Path('output/product-renders-campaign-r3')
scene=json.loads((SRC/'scene.json').read_text());outitems=[];reports={}
TRAVEL=1.6;Z=9.1

def tube_y(x,y,z,r,length):return cq.Workplane('XZ',origin=(x,y,z)).circle(r).extrude(-length)
def path_solid(points,y,t,width):
 pieces=[]
 for x,z in points:pieces.append(tube_y(x,y,z,width/2,t))
 for (x,z),(xx,zz) in zip(points,points[1:]):
  dx,dz=xx-x,zz-z;L=math.hypot(dx,dz);nx,nz=-dz/L*width/2,dx/L*width/2
  pieces.append(cq.Workplane('XZ',origin=(0,y,0)).polyline([(x+nx,z+nz),(xx+nx,zz+nz),(xx-nx,zz-nz),(x-nx,z-nz)]).close().extrude(-t))
 q=pieces[0]
 for p in pieces[1:]:q=q.union(p)
 return q

def emit(name,q,mat,product,folder,**metadata):
 v,f=q.val().tessellate(.04,.12)
 outitems.append(dict(name=name,product=product,material=mat,vertices=[[a.x,a.y,a.z] for a in v],faces=[list(t) for t in f],**metadata))
 cq.exporters.export(q,str(folder/(name+'.step')))

for product in ('mini','splanc','mini-weather','splanc-weather'):
 small=product.startswith('mini');baseprod='mini' if small else 'splanc';weather=product.endswith('weather');folder=R/product;folder.mkdir(exist_ok=True)
 src=SRC/product
 for p in src.glob('*.step'):
  if not any(k in p.name for k in ('button','base.step','lid.step','seam-gasket')):shutil.copy2(p,folder/p.name)
 xs=[34.,42.,51.,59.] if small else [32.,44.,82.,89.];split=9 if small else 10;lo=min(xs)-4.4;hi=max(xs)+4.4;roof=12.1
 b=cq.importers.importStep(str(src/'base.step'));l=cq.importers.importStep(str(src/'lid.step'))
 # Rebuild just the front wall around former oversized flange slots.
 patch=box(lo,-3.2,6.8,hi-lo,2.2,roof-6.8)
 b=b.union(patch)
 transfer=box(lo,-3.3,split-.05,hi-lo,2.5,roof-split+.05)
 l=l.cut(transfer)
 # Old inner tongue obstructed the plungers. Replace locally with raised joint.
 oldtongue=box(lo,-1.11,split-1.5,hi-lo,1.3,2.5)
 b=b.cut(oldtongue);l=l.cut(oldtongue)
 # Separate the rebuilt raised wall from lid exactly at the new plane.
 l=l.cut(patch)
 # Narrow guide bores, swept/tolerance envelopes fit these without flanges.
 for x in xs:
  bore=tube_y(x,-4,Z,1.0,5.4);b=b.cut(bore);l=l.cut(bore)
  # Integral inward stops at the two shoulder margins. At rest cap back=-5.1.
  for z in (6.85,10.95):b=b.union(box(x-1.3,-3.5,z,2.6,.31,.4))
 # Raised seam follows front wall, not through any moving plunger envelope.
 points=[(lo-1,split),(lo,split),(lo,roof),(hi,roof),(hi,split),(hi+1,split)]
 # 0.4mm free gasket in a0.3mm closed gland: nominal25% squeeze.
 groove=path_solid(points,-3.0,1.0,.3)
 b=b.cut(groove);l=l.cut(groove)
 # Registered external frame: two molding pins and two end screws (M1.6).
 frame=box(lo,-5.8,4.8,hi-lo,.8,.7).union(box(lo,-5.8,13.6,hi-lo,.8,.7))
 for x in (lo+.6,hi-.6):
  frame=frame.union(box(x-.6,-5.8,4.8,1.2,.8,9.5))
  # Bosses meet the stationary frame only; separated from moving spring tracks.
  b=b.union(box(x-.7,-5,4.8,1.4,1.81,1.2))
  # Integral locating sleeve nests in the enclosure bore; screw clamps it.
  sleeve=tube_y(x,-5,5.4,.9,2.05);frame=frame.union(sleeve)
  b=b.cut(tube_y(x,-5.01,5.4,1.0,2.15))
  if x>lo+1:
   for dx in (-.25,.25):b=b.cut(tube_y(x+dx,-5.01,5.4,1.0,2.15))
  hole=tube_y(x,-7,5.4,.55,4.5);frame=frame.cut(hole);b=b.cut(hole)
 # Both-direction travel stops: the outer bezel catches the cap shoulders.
 bezel=box(lo-.8,-6.8,4.3,hi-lo+1.6,.4,10.6)
 for x in xs:bezel=bezel.cut(box(x-2.0,-7,7.1,4.0,1,4.0))
 for x in (lo+.6,hi-.6):bezel=bezel.cut(tube_y(x,-7,5.4,.9,1))
 # Keep bezel as a separate fixed retainer; registrations fix its orientation.
 assembly=frame;moving=[];spring_shapes=[]
 for n,x in enumerate(xs):
  cap=box(x-2.2,-6.4,6.9,4.4,1.3,4.4,.3).union(box(x-1.7,-7.2,7.4,3.4,.8,3.4,.25))
  stem=box(x-.55,-5.1,Z-.55,1.1,3.55,1.1,.15);cap=cap.union(stem)
  # Mechanical interlock for the proposed second-shot compliant contact tip.
  cap=cap.union(tube_y(x,-1.7,Z,.55,.4))
  springs=[]
  for side in (-1,1):
   path=[(x+2.6,5.15),(x+2.6,5.85),(x-2.6,5.85),(x-2.6,6.5),(x+1.7,6.5),(x+1.7,7.05)] if side<0 else [(x-2.6,13.95),(x-2.6,13.1),(x+2.6,13.1),(x+2.6,12.4),(x-1.7,12.4),(x-1.7,11.15)]
   spring=path_solid(path,-6.0,.55,.4);springs.append(spring);spring_shapes.append(spring)
   emit(f'flexure-{n+1}-{side}',spring,'button',product,folder,group='Button flexure strip',motion='spring',button_index=n,anchor_z=path[0][1],moving_z=path[-1][1])
  moving.append(cap);assembly=assembly.union(cap)
  for spring in springs:assembly=assembly.union(spring)
  emit('button-shuttle-'+str(n+1),cap,'button',product,folder,group='Button flexure strip',motion='rigid',button_index=n)
  # Released TPE tip. Kinematic compression is shown in viewer, not a force model.
  tip=tube_y(x,-1.3,Z,.4,2.75)
  emit('compliant-tip-'+str(n+1),tip,'seal',product,folder,group='Compliant contact tips',motion='tip',button_index=n,tip_start=-1.3,tip_end=1.45)
 # Tolerance checks: rigid moving swept box remains below joint and above PCB.
 pcb=box(-.2,-.2,5.6,70.4 if small else 100.4,55.4 if small else 80.4,2.0)
 checks=[]
 for x,cap in zip(xs,moving):
  # Shoulder stop contacts are intentional at inward/outward endpoints.
  for travel in (0,.4,.8,1.2,1.6,1.7):
   # The electronics-facing rigid shaft is the only rigid portion entering case.
   shaft=box(x-.75,-5.3+travel,Z-.75,1.5,3.95,1.5)
   checks.append({'x':x,'travel':travel,'pcb_mm3':shaft.intersect(pcb).val().Volume()})
 assert max(c['pcb_mm3'] for c in checks)<1e-6
 # Bore radius1.0 exceeds shaft square corner at tolerance by sqrt(.75^2*2)
 # so use a conservative required circular guide clearance test below.
 guide_required_radius=math.sqrt(.55**2+.55**2)+math.sqrt(.2**2+.2**2)
 # Enlarge all guides to1.2mm radius for full diagonal tolerance.
 for x in xs:
  bore=tube_y(x,-4,Z,1.2,5.4);b=b.cut(bore);l=l.cut(bore)
 assert guide_required_radius<1.2
 assert b.val().isValid() and l.val().isValid() and len(b.val().Solids())==len(l.val().Solids())==1
 overlap=b.intersect(l).val().Volume();assert overlap<.01,(product,overlap)
 cq.exporters.export(assembly,str(folder/'button-flexure-strip.step'))
 emit('base',b,'shell_base',product,folder);emit('lid',l,'shell_lid',product,folder)
 emit('button-frame',frame,'button',product,folder,group='Button flexure strip')
 emit('button-retainer-bezel',bezel,'shell_base',product,folder,group='Button retainer bezel')
 for n,x in enumerate((lo+.6,hi-.6),1):
  screw=tube_y(x,-7.4,5.4,1.2,.6).union(tube_y(x,-6.8,5.4,.8,3.4))
  socket=cq.Workplane('XZ',origin=(x,-7.41,5.4)).polygon(6,1.0).extrude(-.35)
  screw=screw.cut(socket)
  emit('button-retainer-screw-'+str(n),screw,'fastener',product,folder,group='Button retainer fasteners')
 if weather:
  # Continuous raised front section replaces the former straight gasket segment.
  gasket=cq.importers.importStep(str(src/'seam-gasket.step')).cut(box(lo-1,-3.3,split-1,hi-lo+2,2,2))
  gasket=gasket.union(path_solid(points,-2.8,.6,.4))
  emit('seam-gasket',gasket,'seal',product,folder)
 reports[product]={'valid':True,'shell_overlap_mm3':overlap,'strip_solids':len(assembly.val().Solids()),'travel_mm':[0,1.6],'travel_tolerance_mm':.1,'guide_radius_mm':1.2,'required_radius_with_xy_tolerance_mm':guide_required_radius,'rigid_shaft_pcb_checks':checks,'raised_joint_z_mm':roof,'lowest_shaft_z_with_tolerance_mm':8.35,'pcb_top_with_tolerance_mm':7.6,'joint_clearance_mm':roof-(9.1+.55+.2),'status':'geometry prototype; compliant-tip actuation/force/fatigue and gasket compression unqualified'}
 print(product,reports[product]['strip_solids'],overlap,flush=True)
# Preserve electronics, fasteners and optical parts; discard old independent caps/boots.
for i in scene['items']:
 if i['product'] in ('mini','splanc','splanc-weather') and (i['name'] in ('base','lid','seam-gasket') or i['material']=='button' or 'button-bonded-boot' in i['name']):continue
 outitems.append(i)
scene['items']=outitems;scene['revision']='button-flexure-r1';(R/'scene.json').write_text(json.dumps(scene));(R/'validation.json').write_text(json.dumps(reports,indent=2))

(R/'design.json').write_text(json.dumps({'revision': 'button-flexure-r1', 'travel_mm': 1.6, 'travel_tolerance_mm': 0.1, 'gap_nominal_mm': 0.3, 'gap_tolerance_mm': 0.2, 'switch_travel_mm': [0.1, 0.3], 'lateral_stackup_mm': 0.2, 'vertical_stackup_mm': 0.2, 'flexure_material': 'PP candidate; resin/shrinkage/fatigue unqualified', 'status': 'geometric prototype; compliant-tip force/overtravel require bench validation', 'tip_material': 'TPE candidate; compression-force curve and overload unqualified', 'tolerance_status': 'Allocated +/-0.20mm interface envelope, NOT verified supplier stack-up', 'gasket_free_section_mm': 0.4, 'gland_depth_mm': 0.3, 'nominal_gasket_squeeze': 0.25},indent=2))
