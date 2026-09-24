"""Flat-backed drafted-prism button strip, inserted from inside before the PCB.
Preserve r3; export new solids, poses and conservative tolerance checks.
"""
from pathlib import Path
import json,math,shutil
import cadquery as cq
from generate_enclosures import box,cylinder
R=Path('output/button-dfa-r5');R.mkdir(exist_ok=True);SRC=Path('output/product-renders-campaign-r3')
scene=json.loads((SRC/'scene.json').read_text());outitems=[];reports={}
TRAVEL=.6;Z=9.1

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

def drafted_path(points,rear,t,width):
 pieces=[]
 for x,z in points:
  pieces.append(cq.Workplane('XZ',origin=(x,rear,z)).circle(width/2).extrude(t,taper=1.0))
 for (x,z),(xx,zz) in zip(points,points[1:]):
  dx,dz=xx-x,zz-z;length=math.hypot(dx,dz);nx,nz=-dz/length*width/2,dx/length*width/2
  pieces.append(cq.Workplane('XZ',origin=(0,rear,0)).polyline([(x+nx,z+nz),(xx+nx,zz+nz),(xx-nx,zz-nz),(x-nx,z-nz)]).close().extrude(t,taper=1.0))
 q=pieces[0]
 for p in pieces[1:]:q=q.union(p)
 return q

def emit(name,q,mat,product,folder,**metadata):
 v,f=q.val().tessellate(.04,.12)
 outitems.append(dict(name=name,product=product,material=mat,vertices=[[a.x,a.y,a.z] for a in v],faces=[list(t) for t in f],**metadata))
 cq.exporters.export(q,str(folder/(name+'.step')))
 if name in ('base','lid'):cq.exporters.export(q,str(folder/(name+'.stl')),tolerance=.04,angularTolerance=.1)

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
 l=l.cut(box(lo,-1.0,11.1,hi-lo,3.4,6.05))
 # Full-size clearance apertures: every section of each prism passes through.
 for x in xs:
  aperture=box(x-2.85,-3.4,Z-1.45,5.7,2.6,2.9)
  b=b.cut(aperture);l=l.cut(aperture)
 # Pogo pads are accessed before enclosure assembly; retain a closed floor.
 if small:
  board=json.loads(Path('output/mechanical/mini-board.json').read_text())
  px,py=next(c['position'] for c in board['components'] if c['ref']=='TP1')
  b=b.union(box(px-5.7,py-6.95,0,11.4,13.9,2.2))
 # Raised seam follows front wall, not through any moving plunger envelope.
 points=[(lo-1,split),(lo,split),(lo,roof),(hi,roof),(hi,split),(hi+1,split)]
 # 0.4mm free gasket in a0.3mm closed gland: nominal25% squeeze.
 groove=path_solid(points,-3.0,1.0,.3)
 b=b.cut(groove);l=l.cut(groove)
 # A plain rail bears on the inner wall; a plain lid land backs it.
 # No pins, sockets, hooks or rear projections on the separately printed strip.
 rear=1.45
 frame=cq.Workplane('XZ',origin=((lo+hi)/2,rear,16.0)).rect(hi-lo,1.8).extrude(rear+1.0,taper=1.0)
 # Both portions extend continuously to the lid top: no suspended shelf.
 lid_top=20.0 if small else 25.0
 l=l.union(box(lo,-1.1,17.15,hi-lo,3.35,lid_top-17.15))
 l=l.union(box(lo,rear,16.1,hi-lo,.8,lid_top-16.1))
 assembly=frame;moving=[]
 for n,x in enumerate(xs):
  # 0.95deg straight-pull draft: 5.2x2.4 rear -> approximately5x2.2 front.
  cap=cq.Workplane('XZ',origin=(x,rear,Z)).rect(5.2,2.4).extrude(6.0,taper=.95)
  for side in (-1,1):
   path=[(x+side*2.7,15.4),(x+side*2.7,14.0),(x+side*.9,14.0),(x+side*.9,12.5),(x+side*2.7,12.5),(x+side*2.7,11.0),(x+side*.7,11.0),(x+side*.7,10.2)]
   spring=drafted_path(path,rear,.3,.8)
   assembly=assembly.union(spring)
   emit(f'flexure-{n+1}-{side}',spring,'button',product,folder,group='Flat-backed button strip',motion='spring',button_index=n,anchor_z=15.4,moving_z=10.2)
  moving.append(cap);assembly=assembly.union(cap)
  emit('button-shuttle-'+str(n+1),cap,'button',product,folder,group='Flat-backed button strip',motion='rigid',button_index=n)
 assert b.val().isValid() and l.val().isValid() and len(b.val().Solids())==len(l.val().Solids())==1
 over=b.intersect(l);overlap=over.val().Volume()
 if overlap>.01:
  print('OVERLAP',[(v.BoundingBox().xmin,v.BoundingBox().xmax,v.BoundingBox().ymin,v.BoundingBox().ymax,v.BoundingBox().zmin,v.BoundingBox().zmax) for v in over.val().Solids()],flush=True)
 assert overlap<.01,(product,overlap)
 cq.exporters.export(assembly,str(folder/'button-flexure-strip.step'))
 emit('base',b,'shell_base',product,folder);emit('lid',l,'shell_lid',product,folder)
 lid_print=l.rotate((0,0,0),(1,0,0),180).translate((0,0,lid_top))
 cq.exporters.export(lid_print,str(folder/'lid-print.step'))
 cq.exporters.export(lid_print,str(folder/'lid-print.stl'),tolerance=.04,angularTolerance=.1)
 emit('button-frame',frame,'button',product,folder,group='Flat-backed button strip')
 if weather:
  # Continuous raised front section replaces the former straight gasket segment.
  gasket=cq.importers.importStep(str(src/'seam-gasket.step')).cut(box(lo-1,-3.3,split-1,hi-lo+2,2,2))
  gasket=gasket.union(path_solid(points,-2.8,.6,.4))
  emit('seam-gasket',gasket,'seal',product,folder)
 # Print orientation: common rear plane lies on Z=0, all material above it.
 # Rotate rear face down to the print bed; all relief grows upward.
 printpart=assembly.rotate((0,0,0),(1,0,0),-90).translate((0,0,rear))
 assert printpart.val().BoundingBox().zmin>-.00001
 cq.exporters.export(printpart,str(folder/'button-strip-print.step'))
 cq.exporters.export(printpart,str(folder/'button-strip-print.stl'),tolerance=.02,angularTolerance=.1)
 reports[product]={'flexure_width_mm':.8,'flexure_thickness_mm':.3,'rail_height_mm':1.8,'retainer_capture_mm':.8,'retainer_zmin_mm':16.1,'lid_top_mm':lid_top,'valid':True,'shell_overlap_mm3':overlap,'strip_solids':len(assembly.val().Solids()),'rear_plane_y_mm':rear,'front_face_mm':[5.001015,2.201015],'rear_face_mm':[5.2,2.4],'draft_degrees':.95,'nominal_gap_mm':.3,'nominal_motion_review_mm':[0,.6],'full_actuation_tolerance_validated':False,'print_zmin_mm':printpart.val().BoundingBox().zmin,'pogo_access':'closed; board-level EoL only','status':'assembly/geometric prototype; stop/force, full tolerance stack, flexure fatigue and tool design unqualified'}
 assert len(assembly.val().Solids())==1,(product,len(assembly.val().Solids()))
 print(product,reports[product]['strip_solids'],overlap,flush=True)
# Preserve electronics, fasteners and optical parts; discard old independent caps/boots.
for i in scene['items']:
 if 'pogo-service-seal-cover' in i['name']:continue
 if i['product'] in ('mini','splanc','splanc-weather') and (i['name'] in ('base','lid','seam-gasket') or i['material']=='button' or 'button-bonded-boot' in i['name']):continue
 outitems.append(i)
scene['items']=outitems;scene['revision']='button-dfa-r5';(R/'scene.json').write_text(json.dumps(scene));(R/'validation.json').write_text(json.dumps(reports,indent=2))

(R/'design.json').write_text(json.dumps({'revision':'button-dfa-r5','flexure_width_mm':.8,'flexure_thickness_mm':.3,'retainer_capture_mm':.8,'rear_plane_y_mm':1.45,'draft_degrees':.95,'body_depth_mm':6,'front_face_mm':[5,2.2],'rear_face_mm':[5.2,2.4],'nominal_gap_mm':.3,'switch_travel_mm':[.1,.3],'review_travel_mm':.6,'assembly':'insert strip outward through full-size apertures before PCB installation; close lid against plain rail','qualification':'nominal motion only; full supplier tolerance/force/overload and tooling unqualified'},indent=2))

shutil.copy2('output/button-flexure-r1/user-view.json',R/'user-view.json')
