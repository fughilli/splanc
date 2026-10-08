"""Single-pass family CAD from design parameters and electronics references.
No previous enclosure STEP or scene is read. Booleans express named features;
there are no repair patches or post-processing enclosure scripts.
"""
from pathlib import Path
import json,gzip,math,argparse,copy
import cadquery as cq
from logo import embossed_logo
from generate_enclosures import board_shape,populated
HERE=Path(__file__).resolve().parent
SPEC=json.loads((HERE/'enclosure-spec.json').read_text())
REFERENCE=HERE/'assets/frozen-r9'

def box(x,y,z,w,d,h,r=0):
 q=cq.Workplane('XY').box(w,d,h,centered=False)
 if r:q=q.edges('|Z').fillet(min(r,w/3,d/3))
 return q.translate((x,y,z))
def cyl(x,y,z,r,h):return cq.Workplane('XY',origin=(x,y,z)).circle(r).extrude(h)
def ring(x,y,z,w,d,h,t,r=0):return box(x,y,z,w,d,h,r).cut(box(x+t,y+t,z-.1,w-2*t,d-2*t,h+.2,max(0,r-t)))
def loft_xy(x,y,z,w,h,zt,wt,ht):return cq.Workplane('XY',origin=(x,y,z)).rect(w,h).workplane(offset=zt-z).rect(wt,ht).loft()
def funnel(x,y,z,w,h,depth,wo,ho,north=False):return cq.Workplane('XZ',origin=(x,y,z)).rect(wo,ho).workplane(offset=depth if north else -depth).rect(w,h).loft()
def port_plane(origin,normal,u,offset=0):
 return cq.Plane(origin=tuple(origin[i]+normal[i]*offset for i in range(3)),xDir=u,normal=normal)
def port_profile(origin,normal,u,offset,width,height,radius=None):
 plane=port_plane(origin,normal,u,offset)
 if radius is None:return cq.Workplane(plane).slot2D(width,height).val()
 wire=cq.Workplane(plane).rect(width,height).val()
 return wire.fillet2D(radius,wire.Vertices())
def port_loft(origin,normal,u,sections,capsule=False):
 wires=[port_profile(origin,normal,u,t,w,h,None if capsule else min(SPEC['usb_c']['well_corner_radius_mm'],h/3)) for t,w,h in sections]
 return cq.Workplane(obj=cq.Solid.makeLoft(wires,True))
def usb_c_features(origin,normal,u,outer_distance,add_support=False):
 """Shell-conformal throat plus an outward-opening cable well, in port-local mm.
 t=0 is the real connector shell's mating face; positive t points outside.
 The sole thin web sits just behind the mating face, so it cannot obstruct the plug overmold.
 """
 d=SPEC['usb_c'];back=d['web_back_mm'];front=back+d['web_thickness_mm'];wi,hi=d['well_inner_mm'];wo,ho=d['well_outer_mm']
 sw=d['shell_width_mm']+2*d['radial_clearance_mm'];sh=d['shell_height_mm']+2*d['radial_clearance_mm']
 draft=2*d['web_thickness_mm']*math.tan(math.radians(d['opening_draft_deg']))
 throat=port_loft(origin,normal,u,[(back-.05,sw,sh),(front+.01,sw+draft,sh+draft)],True)
 backrelief=port_loft(origin,normal,u,[(-5,wi,hi),(back,wi,hi)])
 well=port_loft(origin,normal,u,[(front,wi,hi),(outer_distance,wo,ho),(outer_distance+15,wo,ho)])
 cut=throat.union(backrelief).union(well)
 support=port_loft(origin,normal,u,[(back,wi+3.2,hi+3.2),(outer_distance,wo+4,ho+4)]) if add_support else None
 # End sealant before the mouth, rather than bridging the air in the well.
 setback=SPEC['seam_seal']['connector_end_setback_mm']
 stop=port_loft(origin,normal,u,[(-5,wo+2*setback,ho+2*setback),(outer_distance+1,wo+2*setback,ho+2*setback)])
 return cut,support,stop

def path(points,y,t,width,draft=0):
 pieces=[]
 for x,z in points:pieces.append(cq.Workplane('XZ',origin=(x,y,z)).circle(width/2).extrude(t,taper=draft))
 for (x,z),(xx,zz) in zip(points,points[1:]):
  dx,dz=xx-x,zz-z;L=math.hypot(dx,dz);nx,nz=-dz/L*width/2,dx/L*width/2
  pieces.append(cq.Workplane('XZ',origin=(0,y,0)).polyline([(x+nx,z+nz),(xx+nx,zz+nz),(xx-nx,zz-nz),(x-nx,z-nz)]).close().extrude(t,taper=draft))
 q=pieces[0]
 for a in pieces[1:]:q=q.union(a)
 return q

def screw(x,y,top,d=2.5,head=2.25,seat=1.8,length=12):
 z=top-seat
 q=cyl(x,y,z,head,seat-.15).cut(cq.Workplane('XY',origin=(x,y,top-.9)).polygon(6,d*.82).extrude(1.1))
 return q.union(cyl(x,y,z-length,d/2,length))

class Build:
 def __init__(self,out):
  self.out=out;out.mkdir(parents=True,exist_ok=True);self.items=json.loads(gzip.decompress((HERE/'assets/reference-electronics.json.gz').read_bytes()))['items'];self.reports={};self.shapes={}
  self.items=[i for i in self.items if not (i['product']=='max' and i['name'].startswith(('M5-lug','busbar-lug-tab')))]
  for i in self.items:
   if i['product']=='max':
    dx=SPEC['max'].get('service_extension_mm',0);i['vertices']=[[x+dx,y,z] for x,y,z in i['vertices']]
   if i['product'] in ('mini','splanc'):
    dz=SPEC['handheld'].get('assembly_z_shift_mm',0);i['vertices']=[[x,y,z+dz] for x,y,z in i['vertices']]
 def emit(self,p,n,q,mat,**extra):
  if p in ('mini','splanc') and n not in ('lid-print','button-strip-print'):
   dz=SPEC['handheld'].get('assembly_z_shift_mm',0);q=q.translate((0,0,dz))
   for key in ('anchor_z','moving_z'):
    if key in extra:extra[key]+=dz
  shape=q.val().fix();q=cq.Workplane(obj=shape);assert shape.isValid(),(p,n)
  self.shapes[p,n]=q
  folder=self.out/p;folder.mkdir(exist_ok=True)
  cq.exporters.export(q,str(folder/(n+'.step')))
  if n in ('base','lid','button-flexure-strip','lid-print','button-strip-print'):cq.exporters.export(q,str(folder/(n+'.stl')),tolerance=.04,angularTolerance=.12)
  if n in ('button-flexure-strip','lid-print','button-strip-print'):return
  v,f=shape.tessellate(.04,.12)
  self.items.append(dict(product=p,name=n,material=mat,vertices=[[a.x,a.y,a.z] for a in v],faces=[list(a) for a in f],**extra))
 def handheld(self,p):
  common=SPEC['handheld'];d=common[p];bt=common['button'];w,h=d['board'];top=d['top'];split=d['split'];xs=d['buttons'];lo=min(xs)-5.5;hi=max(xs)+5.5
  # Work in the board-reference frame, then emit at the enclosure-floor datum.
  bottom=-common.get('assembly_z_shift_mm',0);floor_z=bottom+common['floor'];roof=common.get('roof',2.2)
  # One hollow shell; a stepped separation surface raises the joint above buttons.
  outer=box(-3.2,-3.2,bottom,w+6.4,h+6.4,top-bottom,3).edges('>Z or <Z').chamfer(SPEC['edge_chamfer'])
  cavity=box(-1,-1,floor_z,w+2,h+2,top-roof-floor_z,1)
  body=outer.cut(cavity)
  separator=box(-10,-10,-1,w+20,h+20,split+1).union(box(lo,-3.3,split,hi-lo,2.3,bt['raised_seam_z']-split))
  b=body.intersect(separator);l=body.cut(separator)
  # Registered joint on side/rear walls, clear of the moving front strip.
  tongue=ring(-.75,-.75,split-1.4,w+1.5,h+1.5,1.5,.6,1)
  tongue=tongue.cut(box(-5,-5,0,w+10,6.3,30))
  ledge=ring(-1.1,-1.1,split,w+2.2,h+2.2,.8,.95,1).cut(box(-5,-5,0,w+10,6.3,30))
  l=l.union(ledge).union(tongue)
  board=json.loads((HERE/'assets/mini-board-reference.json').read_text()) if p=='mini' else json.loads((REFERENCE/'splanc/interface.json').read_text())['boards']['splanc']
  for j,m in enumerate(board['mounts'],1):
   x,y=m['x'],m['y'];b=b.union(cyl(x,y,floor_z,3,5.8-floor_z)).cut(cyl(x,y,bottom+.9,1.05,5.8))
   l=l.union(cyl(x,y,9.1,3,top-9.1)).cut(cyl(x,y,5.8,1.4,top)).cut(cyl(x,y,top-1.8,2.5,2))
   self.emit(p,f'case-screw-{j}',screw(x,y,top,length=top-6),'fastener')
  # Lowered east connector bowl is part of the shell definition, with a single cut.
  ports=d['led_ports'];x=ports[0][0];y=sum(a[1] for a in ports)/2
  bowl=loft_xy(x,y,12.4,13.2,24.2,top,17.2,31.2)
  bowlcut=loft_xy(x,y,14,10,21,top+.5,14,28)
  l=l.union(bowl).intersect(outer).cut(bowlcut)
  for x,y in ports:l=l.cut(box(x-4.4,y-4.7,11.5,8.8,9.4,top))
  usb,usb_support,usb_seal_stop=usb_c_features((d['usb_x'],-1.45,9.13),(0,-1,0),(1,0,0),1.75,True)
  b=b.union(usb_support.intersect(separator)).cut(usb)
  l=l.union(usb_support.cut(separator)).cut(usb)
  b=b.intersect(outer);l=l.intersect(outer)
  for j,(x,y) in enumerate(d['lightpipes'],1):
   l=l.cut(cyl(x,y,7.8,1.1,top))
   self.emit(p,f'lightpipe-{j}',cyl(x,y,8.1,.9,top-8.1),'lightpipe')
  if p=='mini':
   b=b.cut(cyl(63,10,bottom-.1,.9,common['floor']+.2))
  for x in (w/2-2,w/2,w/2+2):l=l.cut(cyl(x,h-3,top-3,.55,4))
  # A flat rail, supported lid lands and one-piece drafted button strip.
  rear=bt['rear_y'];z=bt['center_z']
  frame=cq.Workplane('XZ',origin=((lo+hi)/2,rear,bt['rail_z'])).rect(hi-lo,bt['rail_height']).extrude(rear+1,taper=1)
  assembly=frame
  l=l.union(box(lo,-1.1,17.15,hi-lo,3.35,top-17.15)).union(box(lo,rear,bt['retainer_z'],hi-lo,bt['retainer_depth'],top-bt['retainer_z']))
  for j,x in enumerate(xs):
   cap=cq.Workplane('XZ',origin=(x,rear,z)).rect(bt['rear_width'],bt['rear_height']).extrude(bt['depth'],taper=bt['draft_deg'])
   aperture=box(x-bt['aperture'][0]/2,-3.4,z-bt['aperture'][1]/2,bt['aperture'][0],2.6,bt['aperture'][1])
   b=b.cut(aperture);l=l.cut(aperture)
   for side in (-1,1):
    points=[(x+side*2.7,15.4),(x+side*2.7,14),(x+side*.9,14),(x+side*.9,12.5),(x+side*2.7,12.5),(x+side*2.7,11),(x+side*.7,11),(x+side*.7,10.2)]
    spring=path(points,rear,bt['spring_thickness'],bt['spring_width'],1);assembly=assembly.union(spring)
    self.emit(p,f'flexure-{j+1}-{side}',spring,'button',group='Flat-backed button strip',motion='spring',button_index=j,anchor_z=15.4,moving_z=10.2)
   assembly=assembly.union(cap);self.emit(p,f'button-shuttle-{j+1}',cap,'button',group='Flat-backed button strip',motion='rigid',button_index=j)
  self.emit(p,'button-frame',frame,'button',group='Flat-backed button strip')
  self.emit(p,'button-flexure-strip',assembly,'button')
  self.emit(p,'button-strip-print',assembly.rotate((0,0,0),(1,0,0),-90).translate((0,0,rear)),'button')
  # Continuous stepped sealing gland follows the split above the button row.
  gland=ring(-2.9,-2.9,split-.2,w+5.8,h+5.8,.4,.8,2.7).cut(box(lo-1,-3.3,0,hi-lo+2,1.4,30))
  points=[(lo-1,split),(lo,split),(lo,15.5),(hi,15.5),(hi,split),(hi+1,split)]
  gland=gland.union(path(points,-2.1,.8,.4))
  # Clip the actual dispensed bead to supported shell material, with dry ends
  # before connector mouths. A continuous O-ring cannot bridge these openings.
  gland=gland.cut(usb_seal_stop).intersect(b.union(l))
  assert gland.cut(b.union(l)).val().Volume()<1e-5
  self.reports.setdefault(p,{})['sealant_segments']=len(gland.val().Solids())
  b=b.cut(gland);l=l.cut(gland);self.emit(p,'seam-sealant',gland,'seal',note='Interrupted dispensed bead in gland; no continuous O-ring; connector sealing is a separate operation')
  logo=embossed_logo(d['logo_width'],w/2,h/2,top-.7,.7);l=l.cut(logo)
  self.emit(p,'logo-white-inlay',logo,'logo_white')
  self.finish(p,b,l,top,[w+6.4,h+6.4,top-bottom])
 def max(self):
  p='max';d=SPEC[p];w,h,top=d['outside'];split=d['split'];wall=d['wall'];floor=d['floor']
  outer=box(0,0,0,w,h,top,5).edges('>Z or <Z').chamfer(.5)
  shell=outer.cut(box(wall,wall,floor,w-2*wall,h-2*wall,top-floor-wall,2))
  b=shell.intersect(box(-1,-1,-1,w+2,h+2,split+1));l=shell.intersect(box(-1,-1,split,w+2,h+2,top-split+1))
  l=l.union(ring(2.7,2.7,split,w-5.4,h-5.4,.8,1.3,2)).union(ring(3.1,3.1,split-1.8,w-6.2,h-6.2,2,.9,2))
  interface=json.loads((REFERENCE/'splanc_max/interface.json').read_text());power=interface['boards']['power'];lv=interface['boards']['lv']
  def pi(q):return q.rotate((0,0,0),(0,0,1),90).translate(tuple(d['pi_origin']))
  dx=d.get('service_extension_mm',0)
  mounts=[(7+dx+m['x'],7+m['y']) for m in power['mounts']]+[(d['pi_origin'][0]-m['y'],28+m['x']) for m in lv['mounts']]
  for x,y in mounts:b=b.union(cyl(x,y,floor,3.6,8-floor)).cut(cyl(x,y,1.4,1.25,8))
  # Case bosses bridge down from above the output opening at the middle screws.
  for j,(x,y) in enumerate(d['case_mounts'],1):
   start=23 if x==146+dx else floor
   b=b.union(cyl(x,y,start,3,split-start)).cut(cyl(x,y,split-12,1.25,15))
   l=l.cut(cyl(x,y,split-2.1,3.3,2.1)).cut(cyl(x,y,split-2,1.75,10)).cut(cyl(x,y,top-2,3,3))
   self.emit(p,f'case-screw-{j}',screw(x,y,top,3,2.7,2,14),'fastener')
  # Output banks: two planned continuous scallops, no obsolete individual windows.
  for y,north in [(-.1,False),(h+.1,True)]:b=b.cut(funnel(107+dx,y,12.3,189.2,13,7.2,190,21,north))
  from max_service import build_service
  b,l=build_service(self,b,l,d)
  # Roof cooling slots are split around a solid logo field by construction.
  for x in range(25,203,8):
   for y,length in [(35,17),(82,17)]:l=l.cut(box(x+dx,y,top-3.4,3,length,4,1))
  for x in range(235,281,6):l=l.cut(box(x+dx,40,top-3.4,2.4,55,4,1))
  for x in range(25,203,10):b=b.cut(box(x+dx,32,-1,3,70,4,1))
  for x in range(235,281,6):b=b.cut(box(x+dx,42,-1,2.4,44,4,1))
  logo=embossed_logo(d['logo_width'],w/2,h/2,top-.7,.7);l=l.cut(logo);self.emit(p,'logo-white-inlay',logo,'logo_white')
  self.emit(p,'lv-pcb-envelope',pi(populated(lv,(0,0,d['hat_z']-8))),'pcb')
  for j,m in enumerate(lv['mounts'],1):self.emit(p,f'hat-standoff-{j}',pi(cyl(m['x'],m['y'],1.6,2.8,d['hat_z']-9.6).cut(cyl(m['x'],m['y'],1.5,1.35,30))),'nickel')
  self.emit(p,'active-cooler-envelope',pi(box(8,7,1.6,63.5,42.5,13.7,2)),'nylon')
  bridge=interface['boards']['usb_bridge'];bh=bridge['outline']['height_mm'];bw=bridge['outline']['width_mm']
  self.emit(p,'usb-jumper-pcb-envelope',pi(box(98,29.1-bw/2,-3.4,1.6,bw,bh)),'pcb')
  for name,z,width,height in [('A',3.6,12,4.5),('C',d['hat_z']-6,8.4,2.8)]:self.emit(p,'usb-male-'+name+'-envelope',pi(box(83,29.1-width/2,z-height/2,15,width,height)),'nickel')
  gland=ring(1,1,split-.2,w-2,h-2,.4,.8,4)
  gland=gland.intersect(b.union(l))
  assert gland.cut(b.union(l)).val().Volume()<1e-5
  self.reports.setdefault(p,{})['sealant_segments']=len(gland.val().Solids())
  b=b.cut(gland);l=l.cut(gland);self.emit(p,'seam-sealant',gland,'seal',note='Dispensed bead in supported gland; vented enclosure is not waterproof')
  self.finish(p,b,l,top,d['outside'])
 def finish(self,p,b,l,top,dimensions):
  for n,q in [('base',b),('lid',l)]:
   assert q.val().isValid() and len(q.val().Solids())==1,(p,n,len(q.val().Solids()))
   self.emit(p,n,q,'shell_'+n)
  overlap=b.intersect(l).val().Volume();assert overlap<1e-5,(p,'shell overlap',overlap)
  self.emit(p,'lid-print',l.rotate((0,0,0),(1,0,0),180).translate((0,0,top)),'shell_lid')
  self.reports[p]={**self.reports.get(p,{}),'outside_mm':dimensions,'base_lid_overlap_mm3':overlap,'base_solids':1,'lid_solids':1,'source':'enclosure-spec.json; no imported enclosure solids'}
  print(p,self.reports[p],flush=True)
 def variant(self,source,target):
  # A shared-shell variant reuses this build's parametric parts, never old solids.
  original=list(self.items)
  for (product,name),q in list(self.shapes.items()):
   if product!=source:continue
   record=next((i for i in original if i['product']==source and i['name']==name),{})
   metadata={k:v for k,v in record.items() if k not in ('product','name','material','vertices','faces')}
   self.emit(target,name,q,record.get('material','nylon'),**metadata)
  self.items += [dict(i,product=target) for i in original if i['product']==source and (source,i['name']) not in self.shapes]
  self.reports[target]=dict(self.reports[source],qualification='Shared clean shell; weather-specific seals and ingress protection remain a study')
 def save(self):
  (self.out/'scene.json').write_text(json.dumps({'revision':SPEC['revision'],'dimensions':{p:r['outside_mm'] for p,r in self.reports.items()},'items':self.items}))
  (self.out/'validation.json').write_text(json.dumps(self.reports,indent=2))
  (self.out/'design.json').write_text(json.dumps({'revision':SPEC['revision'],'spec':SPEC,'reference_inputs':json.loads((REFERENCE/'manifest.json').read_text()),'qualification':'mechanical prototype; mating, supplier tolerances, fatigue, thermal and production tooling require qualification'},indent=2))

if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,default=Path('output/max-service-r11'));args=ap.parse_args();b=Build(args.out)
 for p in ('mini','splanc'):b.handheld(p)
 b.max();b.variant('mini','mini-weather');b.variant('splanc','splanc-weather');b.save()
