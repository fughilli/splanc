"""Internal registered PP flexure strip / compliant-tip geometric prototype.
Preserve r3; export new solids, poses and conservative tolerance checks.
"""
from pathlib import Path
import json,math,shutil
import cadquery as cq
from generate_enclosures import box,cylinder
R=Path('output/button-flexure-r2');R.mkdir(exist_ok=True);SRC=Path('output/product-renders-campaign-r3')
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
 xs=[34.,42.,51.,59.] if small else [32.,44.,82.,89.];split=9 if small else 10;lo=min(xs)-5.5;hi=max(xs)+5.5;roof=15.5
 b=cq.importers.importStep(str(src/'base.step'));l=cq.importers.importStep(str(src/'lid.step'))
 # Rebuild just the front wall around former oversized flange slots.
 patch=box(lo,-3.2,6.0,hi-lo,2.2,roof-6.0)
 b=b.union(patch)
 transfer=box(lo,-3.3,split-.05,hi-lo,2.5,roof-split+.05)
 l=l.cut(transfer)
 # Old inner tongue obstructed the plungers. Replace locally with raised joint.
 oldtongue=box(lo,-1.11,split-1.5,hi-lo,1.3,2.5)
 b=b.cut(oldtongue);l=l.cut(oldtongue)
 # Separate the rebuilt raised wall from lid exactly at the new plane.
 l=l.cut(patch)
 # Clear the former inward joint ledge in the new spring bay.
 l=l.cut(box(lo,-1.0,11.1,hi-lo,2.5,4.4))
 # Retain original five-mm square face silhouette. Recess receives full stroke.
 for x in xs:
  pocket=box(x-2.8,-3.3,6.3,5.6,1.75,5.6,.3)
  b=b.cut(pocket);l=l.cut(pocket)
  # Side-supported inward stops; moving shoulders stay above the PCB.
  for sign in (-1,1):
   side=x+2.55 if sign>0 else x-3.35
   b=b.union(box(side,-1.1,8.0,.8,2.4,2.2))
   lip=x+1.7 if sign>0 else x-3.35
   b=b.union(box(lip,1.0,8.0,1.65,.3,2.2))
 # Raised seam follows front wall, not through any moving plunger envelope.
 points=[(lo-1,split),(lo,split),(lo,roof),(hi,roof),(hi,split),(hi+1,split)]
 # 0.4mm free gasket in a0.3mm closed gland: nominal25% squeeze.
 groove=path_solid(points,-3.0,1.0,.3)
 b=b.cut(groove);l=l.cut(groove)
 # Internal rail seats against the case; lid fingers trap it during assembly.
 frame=box(lo,-.9,14.0,hi-lo,.5,1.2)
 for x in (lo+.6,hi-.6):
  b=b.union(box(x-.5,-1.1,13.3,1.0,.81,.7))
  pin=tube_y(x,-1.1,14.6,.4,.65);b=b.union(pin)
  frame=frame.cut(tube_y(x,-1.2,14.6,.5,1.3))
  l=l.union(box(x-.8,-1.1,15.5,1.6,1.6,.61))
  l=l.union(box(x-.8,-.4,14.0,1.6,.25,2.11))
 assembly=frame;moving=[]
 for n,x in enumerate(xs):
  cap=box(x-2.5,-4.55,6.6,5,1.1,5,.5)
  cap=cap.union(box(x-.55,-3.45,Z-.55,1.1,2.55,1.1,.15))
  cap=cap.union(box(x-2.2,-1.0,8.05,4.4,.4,2.1,.15))
  cap=cap.union(box(x-.45,-.9,9.5,.9,.3,2.45))
  # Two folded planar springs connect an upper internal rail to each shuttle.
  for side in (-1,1):
   path=[(x+side*2.9,14.35),(x+side*2.9,13.4),(x+side*.9,13.4),(x+side*.9,12.7),(x+side*2.9,12.7),(x+side*2.9,11.8),(x,11.8)]
   spring=path_solid(path,-.85,.25,.3)
   assembly=assembly.union(spring)
   emit(f'flexure-{n+1}-{side}',spring,'button',product,folder,group='Internal button flexure strip',motion='spring',button_index=n,anchor_z=14.35,moving_z=11.8)
  moving.append(cap);assembly=assembly.union(cap)
  emit('button-shuttle-'+str(n+1),cap,'button',product,folder,group='Internal button flexure strip',motion='rigid',button_index=n)
  tip=tube_y(x,-.6,Z,.4,2.05)
  emit('compliant-tip-'+str(n+1),tip,'seal',product,folder,group='Internal compliant contact tips',motion='tip',button_index=n,tip_start=-.6,tip_end=1.45)
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
 over=b.intersect(l);overlap=over.val().Volume()
 if overlap>.01:
  print('OVERLAP',[(v.BoundingBox().xmin,v.BoundingBox().xmax,v.BoundingBox().ymin,v.BoundingBox().ymax,v.BoundingBox().zmin,v.BoundingBox().zmax) for v in over.val().Solids()],flush=True)
 assert overlap<.01,(product,overlap)
 cq.exporters.export(assembly,str(folder/'button-flexure-strip.step'))
 emit('base',b,'shell_base',product,folder);emit('lid',l,'shell_lid',product,folder)
 emit('button-frame',frame,'button',product,folder,group='Button flexure strip')
 if weather:
  # Continuous raised front section replaces the former straight gasket segment.
  gasket=cq.importers.importStep(str(src/'seam-gasket.step')).cut(box(lo-1,-3.3,split-1,hi-lo+2,2,2))
  gasket=gasket.union(path_solid(points,-2.8,.6,.4))
  emit('seam-gasket',gasket,'seal',product,folder)
 reports[product]={'valid':True,'shell_overlap_mm3':overlap,'strip_solids':len(assembly.val().Solids()),'travel_mm':[0,1.6],'travel_tolerance_mm':.1,'guide_radius_mm':1.2,'required_radius_with_xy_tolerance_mm':guide_required_radius,'rigid_shaft_pcb_checks':checks,'raised_joint_z_mm':roof,'lowest_retaining_shoulder_z_with_tolerance_mm':7.85,'pcb_top_with_tolerance_mm':7.6,'joint_clearance_mm':roof-(15.2+.2),'status':'geometry prototype; compliant-tip actuation/force/fatigue and gasket compression unqualified'}
 assert len(assembly.val().Solids())==1,(product,len(assembly.val().Solids()))
 print(product,reports[product]['strip_solids'],overlap,flush=True)
# Preserve electronics, fasteners and optical parts; discard old independent caps/boots.
for i in scene['items']:
 if i['product'] in ('mini','splanc','splanc-weather') and (i['name'] in ('base','lid','seam-gasket') or i['material']=='button' or 'button-bonded-boot' in i['name']):continue
 outitems.append(i)
scene['items']=outitems;scene['revision']='button-flexure-r2';(R/'scene.json').write_text(json.dumps(scene));(R/'validation.json').write_text(json.dumps(reports,indent=2))

(R/'design.json').write_text(json.dumps({'revision': 'button-flexure-r2', 'travel_mm': 1.6, 'travel_tolerance_mm': 0.1, 'gap_nominal_mm': 0.3, 'gap_tolerance_mm': 0.2, 'switch_travel_mm': [0.1, 0.3], 'lateral_stackup_mm': 0.2, 'vertical_stackup_mm': 0.2, 'assembly': 'internal rail trapped by shell; only original 5mm button faces external', 'flexure_material': 'PP candidate; resin/shrinkage/fatigue unqualified', 'status': 'geometric prototype; compliant-tip force/overtravel require bench validation', 'tip_material': 'TPE candidate; compression-force curve and overload unqualified', 'tolerance_status': 'Allocated +/-0.20mm interface envelope, NOT verified supplier stack-up', 'gasket_free_section_mm': 0.4, 'gland_depth_mm': 0.3, 'nominal_gasket_squeeze': 0.25},indent=2))

shutil.copy2('output/button-flexure-r1/user-view.json',R/'user-view.json')
