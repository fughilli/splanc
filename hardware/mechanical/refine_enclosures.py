"""Scalloped access, visible nominal fasteners, and weather-treatment study.
Builds from the immutable black/inlay STEP and scene; never moves electronics.
"""
import json,copy,shutil,math
from pathlib import Path
import cadquery as cq
from generate_enclosures import box,cylinder,ring
SRC=Path('output/product-renders-black');OUT=Path('output/product-renders-access');OUT.mkdir(exist_ok=True)
scene=json.loads((SRC/'scene.json').read_text());items=[];report={}
def emit(name,q,material,product,folder=None):
 s=q.val() if isinstance(q,cq.Workplane) else q
 assert s.isValid(),name
 v,f=s.tessellate(.055,.12)
 items.append(dict(name=name,product=product,material=material,vertices=[[p.x,p.y,p.z] for p in v],faces=[list(t) for t in f]))
 if folder:cq.exporters.export(q,str(folder/(name+'.step')))
def loft_xy(x,y,z,w,h,top,W,H):
 return cq.Workplane('XY',origin=(x,y,z)).rect(w,h).workplane(offset=top-z).rect(W,H).loft()
def bowl(lid,x,y,top,w,h,tw,th,holes):
 # Add a lowered molded roof, then remove the flared cavity and port throats.
 floor=14.0
 outer=loft_xy(x,y,floor-1.6,w+3.2,h+3.2,top,tw+3.2,th+3.2)
 inner=loft_xy(x,y,floor,w,h,top+.5,tw,th)
 lid=lid.union(outer).cut(inner)
 for hx,hy,hw,hh in holes:lid=lid.cut(box(hx-hw/2,hy-hh/2,11.5,hw,hh,top))
 return lid
def funnel_y(x,y,z,w,h,depth,W,H,direction=1):
 return cq.Workplane('XZ',origin=(x,y,z)).rect(W,H).workplane(offset=-direction*depth).rect(w,h).loft()
def funnel_x(x,y,z,w,h,depth,W,H):
 return cq.Workplane('YZ',origin=(x,y,z)).rect(W,H).workplane(offset=-depth).rect(w,h).loft()
def screw(x,y,top,d,head_r,depth,length):
 seat=top-depth
 head=cylinder(x,y,seat,head_r,depth-.15)
 socket=cq.Workplane('XY',origin=(x,y,top-.9)).polygon(6,d*.82).extrude(1.1)
 head=head.cut(socket)
 return head.union(cylinder(x,y,seat-length,d/2,length))
mini=json.loads(Path('output/mechanical/mini-board.json').read_text())
splanc=json.loads(Path('hardware/splanc/interface.json').read_text())['boards']['splanc']
maxi=json.loads(Path('hardware/splanc_max/interface.json').read_text())
for product in ('mini','splanc','max'):
 folder=OUT/product;folder.mkdir(exist_ok=True)
 base=cq.importers.importStep(str(SRC/product/'base.step'));lid=cq.importers.importStep(str(SRC/product/'lid.step'))
 if product!='max':
  small=product=='mini';top=20 if small else 25;split=9 if small else 10;w,h=(70,55) if small else (100,80)
  mounts=mini['mounts'] if small else splanc['mounts'];ux=14 if small else 18
  if small:
   lid=bowl(lid,64,25.5,top,10,21,14,28,[(64,20,8.5,9),(64,31,8.5,9)])
   # Keep the lowered roof inside the original outer envelope.
   lid=lid.intersect(box(-3.2,-3.2,0,w+6.4,h+6.4,top))
   ports=[(64,20),(64,31)]
  else:
   ports=[tuple(c['position']) for c in splanc['connectors'] if c['kind']=='jst_ph3_vertical']
   cx=sum(x for x,y in ports)/len(ports);cy=sum(y for x,y in ports)/len(ports);span=max(y for x,y in ports)-min(y for x,y in ports)
   lid=bowl(lid,cx,cy,top,10,span+10,14,span+17,[(x,y,8.8,9.4) for x,y in ports])
   lid=lid.intersect(box(-3.2,-3.2,0,w+6.4,h+6.4,top))
  cut=funnel_y(ux,-3.3,9.25,11,6.5,4.3,16,10)
  base=base.cut(cut);lid=lid.cut(cut)
  screws=[(p['x'],p['y'],2.5,2.25,1.8,top-6) for p in mounts]
  seam=ring(-3.1,-3.1,split-.25,w+6.2,h+6.2,.5,1.1,2.8)
 else:
  top=53;split=47;w=335;h=134;ports=[]
  screws=[(x,y,3,2.7,2,14) for x,y in ((4,4),(331,4),(4,130),(331,130),(167.5,4),(167.5,130))]
  for c in maxi['boards']['power']['connectors']:
   if c['kind']!='led_output3':continue
   x=7+c['position'][0];north=c['edge']=='north';y=134.1 if north else -.1
   cut=funnel_y(x,y,12.3,18.1,13,7.2,18.8,23,-1 if north else 1)
   base=base.cut(cut)
  # East Pi port bank: pull the wall in to the actual connector plane.
  # A wide recessed panel replaces the 20mm-deep narrow tunnels.
  panel=box(309,11,6,2.8,56,24)
  base=base.union(funnel_x(335.1,39,18,57.6,26.6,26.1,69.6,38.6)).union(panel).cut(funnel_x(335.1,39,18,52,21,23.3,64,33))
  for yy,width,height in ((18.2,19,17),(37.1,17,18),(55,17,18)):
   base=base.cut(box(307,yy-width/2,9,8,width,height))
  for xx,ww in ((236.2,12),(250.8,9),(264.2,9)):
   base=base.cut(funnel_y(xx,-.1,12,ww,6,8.2,ww+5,12))
  seam=ring(.15,.15,46.75,334.7,133.7,.5,1.1,4.8)
 # Export normal shells and reuse the original real-CAD components.
 assert len(base.val().Solids())==len(lid.val().Solids())==1,(product,'disconnected shell')
 emit('base',base,'shell_base',product,folder);emit('lid',lid,'shell_lid',product,folder)
 for i in scene['items']:
  if i['product']==product and i['name'] not in ('base','lid'):items.append(copy.deepcopy(i))
 for p in (SRC/product).glob('*.step'):
  if p.name not in ('base.step','lid.step'):shutil.copy2(p,folder/p.name)
 for n,(x,y,d,r,depth,length) in enumerate(screws):emit('case-screw-'+str(n+1),screw(x,y,top,d,r,depth,length),'fastener',product,folder)
 report[product]={'base_valid':base.val().isValid(),'lid_valid':lid.val().isValid(),'base_solids':len(base.val().Solids()),'lid_solids':len(lid.val().Solids()),'shell_overlap_mm3':base.intersect(lid).val().Volume(),'fasteners':len(screws),'connector_poses_unchanged':True,'fastener_note':'Nominal socket-head visual geometry, unthreaded shafts; final thread-forming screw/insert specification pending.'}
 # Weather version: perimeter gasket, screw-head sealing rings, connector collars.
 weather=product+'-weather';wf=OUT/weather;wf.mkdir(exist_ok=True)
 wb=base;wl=lid
 gasket=seam.intersect(base.union(lid));wb=wb.cut(gasket);wl=wl.cut(gasket)
 if product=='max':
  # Solid vent blanking layers; thermal performance is explicitly unqualified.
  wl=wl.union(box(14,28,49.3,191,82,.9)).union(box(232,16,49.3,64,44,.9))
  wb=wb.union(box(19,26,1.6,175,66,.9))
 else:
  # Bonded acoustic/pressure membranes sit behind openings, not in sound paths.
  if product=='mini':emit('pressure-membrane',box(30,49,16.7,10,5,.35),'seal',weather,wf)
  mx,my=(next(c['position'] for c in mini['components'] if c['ref']=='MIC1') if any(c['ref']=='MIC1' for c in mini['components']) else (35,40)) if product=='mini' else splanc['microphone']['position']
  emit('acoustic-membrane',cylinder(mx,my,1.6,2,.35),'seal',weather,wf)
 emit('base',wb,'shell_base',weather,wf);emit('lid',wl,'shell_lid',weather,wf);emit('seam-gasket',gasket,'seal',weather,wf)
 for i in list(items):
  if i['product']==product and i['name'] not in ('base','lid'):
   cp=copy.deepcopy(i);cp['product']=weather;items.append(cp)
 for n,(x,y,d,r,depth,length) in enumerate(screws):
  seal=cylinder(x,y,top-depth-.15,r+.08,.3).cut(cylinder(x,y,top-depth-.3,d/2+.05,.7))
  emit('screw-seal-'+str(n+1),seal,'seal',weather,wf)
 if product!='max':
  for n,(x,y) in enumerate(ports):
   collar=ring(x-4.6,y-4.9,13.5,9.2,9.8,.65,.6,.65)
   emit('LED-connector-seal-'+str(n+1),collar,'seal',weather,wf)
  collar=ring(ux-5.4,6.0,0,10.8,6.4,.6,.7,.8).rotate((0,0,0),(1,0,0),90).translate((0,.15,0))
  emit('USB-perimeter-seal',collar,'seal',weather,wf)
 else:
  for c in maxi['boards']['power']['connectors']:
   if c['kind']!='led_output3':continue
   x=7+c['position'][0];y=127 if c['edge']=='north' else 7
   collar=ring(x-8.9,8.4,0,17.8,10,.6,.75,.6).rotate((0,0,0),(1,0,0),90).translate((0,y,0))
   emit('output-seal-'+c['ref'],collar,'seal',weather,wf)
 for p in folder.glob('*.step'):
  if p.name not in ('base.step','lid.step'):shutil.copy2(p,wf/p.name)
 report[weather]={'base_valid':wb.val().isValid(),'lid_valid':wl.val().isValid(),'status':'weather-treatment concept, not ingress-rated; mating faces need sealed plugs/caps; seam transitions and coating masking require qualification; MAX closed vents require thermal testing'}
 (wf/'README.txt').write_text(report[weather]['status']+'\nConformal coat PCB after assembly, masking contacts, sensors, RF and service points. Gasket and collar solids are provisional.\n')
 print(product,'done',flush=True)
scene['items']=items;scene['dimensions'].update({p+'-weather':scene['dimensions'][p] for p in ('mini','splanc','max')});scene['revision']='scalloped-access-and-weather-study'
(OUT/'scene.json').write_text(json.dumps(scene));(OUT/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('Prepared',len(items),'objects')
