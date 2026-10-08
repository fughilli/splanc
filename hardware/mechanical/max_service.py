"""MAX service-end packaging; manufacturer couplers plus marked prototype envelopes."""
from pathlib import Path
import cadquery as cq
import gzip,tempfile,json

def build_service(B,base,lid,d):
 from build_clean_enclosures import box,cyl
 p='max';checks={};parts={}
 def emit(name,shape,material='nylon',**metadata):
  B.emit(p,name,shape,material,**metadata);parts[name]=shape;return shape
 def xcyl(x,y,z,r,length):return cq.Workplane('YZ',origin=(x,y,z)).circle(r).extrude(length)
 # Actual NE8FDP model: original +Z faces outward, invert for west wall.
 # Rotate the coupler so rear plug exits at its upper side, above the PCB.
 with tempfile.NamedTemporaryFile(suffix='.step') as f:
  f.write(gzip.decompress((Path(__file__).parent/'assets/max-service-r11/ne8fdp.step.gz').read_bytes()));f.flush();connector=cq.importers.importStep(f.name)
 for j,(y,z) in enumerate(d['panel_ethernet_centers'],1):
  pose=connector.rotate((0,0,0),(1,0,0),-90).rotate((0,0,0),(0,0,1),90).translate((0,y,z))
  base=base.cut(xcyl(-1,y,z,12.25,6))
  # The supplied flange sandwich is 2.55 mm; thin the local wall to 2.4 mm.
  recess=box(2.4,y-13.5,z-16,4,27,32.5)
  base=base.cut(recess);lid=lid.cut(recess)
  for dy,dz in [(-9.5,-12),(9.5,12)]:
   base=base.cut(xcyl(-1,y+dy,z+dz,1.65,8))
  for k,(dy,dz) in enumerate([(-9.5,-12),(9.5,12)],1):
   screw=xcyl(-1.8,y+dy,z+dz,2.6,1.8).union(xcyl(0,y+dy,z+dz,1.5,8))
   screw=screw.cut(xcyl(-1.81,y+dy,z+dz,1.15,.8))
   emit(f'ethernet-mount-screw-{j}-{k}',screw,'fastener',group='Ethernet panel sockets')
  emit(f'ethernet-panel-{j}',pose,'nickel',group='Ethernet panel sockets',note='Manufacturer NE8FDP STEP, rotated 180 degrees about port axis for upper rear jack')
  # Rear connector plug envelopes are deliberately not presented as approved cable CAD.
  emit(f'ethernet-rear-plug-{j}-envelope',box(39.2,y-7,24,25,14,12,1),'nylon',group='Network harness envelopes',note='Procurement envelope; validate chosen CAT5e right-angle patch lead')
 # Flat carrier can be inserted from inside; separate cap traps two keyed single-pole housings.
 y,z=d['dc_center'];carrier=box(.0,y-17,z-8,3.5,34,16,1)
 cap=box(16,y-16,z-7,2,32,15,1)
 for delta,material in [(-6,'dc_red'),(6,'nylon')]:
  cy=y+delta
  # 10x11x28.5 shell envelope from AMASS drawing, no vendor 3D available.
  housing=box(-9,cy-5,z-5.5,28.5,10,11,1).cut(xcyl(-9.1,cy,z,3.65,13))
  emit('XT150-'+('positive' if delta<0 else 'return')+'-envelope',housing,material,group='DC input',note='Drawing-derived XT150 envelope; not manufacturer CAD; keyed carrier tolerance pending sample')
  emit('XT150-contact-'+str(delta),xcyl(-5,cy,z,3,18).cut(xcyl(-5.1,cy,z,2,10)),'gold',group='DC input')
  aperture=box(-1,cy-5.35,z-5.85,22,10.7,11.7,.8)
  carrier=carrier.cut(aperture);cap=cap.cut(aperture)
 # An offset key rib in the external plug surround prevents a reversed two-pole plug.
 carrier=carrier.union(box(-4,y-17,z-8,7.5,2,16)).union(box(-4,y+15,z-8,7.5,2,16))
 for dy in (-14,14):
  base=base.cut(xcyl(-1,y+dy,z,1.25,6));carrier=carrier.cut(xcyl(-5,y+dy,z,1.7,25));cap=cap.cut(xcyl(-5,y+dy,z,1.25,25))
 base=base.cut(box(-1,y-12,z-6.5,5,24,13,1))
 # Shoulder rebate seats the carrier against the outside wall, not inside solid plastic.
 rebate=box(-.1,y-17.3,z-8.3,4,34.6,16.6)
 base=base.cut(rebate);lid=lid.cut(rebate)
 emit('dc-carrier',carrier,'nylon',group='DC input')
 emit('dc-carrier-clamp',cap,'nylon',group='DC input')
 # Central tongue extends the preserved 200x120 power section. No PCB below coupler backshells.
 tongue=emit('power-service-tongue',box(7,39,8,38.05,50,1.6),'pcb',group='Power board')
 emit('isolated-5V-SMPS',box(11.3,54.3,9.6,25.4,25.4,11.5),'nickel',group='Power board',note='THL40-2411WI manufacturer body dimensions; module pins omitted')
 # Retain bolted busbar connections internally; no exterior lug holes.
 for j,by in enumerate((52,82),1):
  emit(f'internal-bus-stud-{j}',cyl(52,by,11,4.5,2).union(cyl(52,by,13,2.5,5)),'copper',group='DC harness')
 # Switch daughterboard above the power circuit, with a removable insulating tray.
 x,y,z=d['network_origin'];w,h,t=d['network_size'];board=box(x,y,z,w,h,t)
 for xx,yy in [(4,4),(w-4,4),(4,h-4),(w-4,h-4)]:board=board.cut(cyl(x+xx,y+yy,z-.1,1.6,2))
 emit('network-pcb-envelope',board,'pcb',group='NET3 switch board',note='80x60 four-layer board specification; not routed or pin-complete')
 # Tray underside is above the busbars and component envelope, supported at ends.
 tray=box(x-2,y-2,21,w+4,h+4,1)
 for xx,yy in [(4,4),(w-4,4),(4,h-4),(w-4,h-4)]:
  tray=tray.union(cyl(x+xx,y+yy,22,2.8,1.5)).cut(cyl(x+xx,y+yy,20.9,1.15,5))
 emit('network-insulating-tray',tray,'nylon',group='NET3 switch board')
 # Mount the tray on the four existing power-board holes; do not drill new holes through live circuitry.
 for yy in (22,112):
  tray=tray.union(box(48,yy-2,20,194,4,2))
  tray=tray.union(box(x-2,min(yy,y-2),20,4,abs(y-2-yy)+4,2))
  for xx in (50,240):
   post=cyl(xx,yy,9.6,2.8,10.4).cut(cyl(xx,yy,9.5,1.4,12))
   emit(f'network-tray-spacer-{xx}-{yy}',post,'nylon',group='NET3 switch board')
 # Replace the earlier tray record with the final connected support geometry.
 B.items=[i for i in B.items if not (i['product']==p and i['name']=='network-insulating-tray')]
 emit('network-insulating-tray',tray,'nylon',group='NET3 switch board')
 for j,yy in enumerate((y+10,y+30,y+50),1):
  emit(f'network-RJ45-{j}-envelope',box(x,yy-8,z+t,22,16,13.5,.5),'nickel',group='NET3 switch board',note='Integrated-magnetics jack envelope; exact MPN pending')
 emit('network-switch-KSZ9896-envelope',box(x+36,y+22,z+t,16,16,1.6),'nylon',group='NET3 switch board')
 for j,(xx,yy,w0,h0) in enumerate([(x+62,y+8,8,8),(x+62,y+19,8,8),(x+60,y+38,12,10)]):emit(f'network-regulator-controller-{j}-envelope',box(xx,yy,z+t,w0,h0,3),'nylon',group='NET3 switch board')
 # Pi right-angle Ethernet lead is entirely internal, faces west along the north wall.
 dx=d['service_extension_mm']
 emit('Pi-ethernet-right-angle-plug-envelope',box(267+dx,115.9,10.5,16,12.5,12,1),'nylon',group='Network harness envelopes',note='Maximum 12.5 mm extension from Pi jack face; sample fit and latch access required')
 # Paths are soft clearance reservations, not exact bend-radius-qualified cable solids.
 def cable(name,points,r=2.5,mat='nylon'):
  solids=[]
  for a,b in zip(points,points[1:]):
   av=cq.Vector(*a);bv=cq.Vector(*b);solids.append(cq.Solid.makeCylinder(r,(bv-av).Length,av,bv-av))
  for a in points:solids.append(cq.Solid.makeSphere(r,cq.Vector(*a)))
  emit(name,cq.Workplane(obj=cq.Compound.makeCompound(solids)),mat,group='Network harness envelopes',note='Cable centerline reservation; physical bend-radius and latch-removal qualification pending')
 cable('upstream-patch-envelope',[(64,25,30),(83,25,30),(94,47,30),(111,47,30)])
 cable('downstream-patch-envelope',[(64,106,30),(85,106,30),(94,67,30),(111,67,30)])
 cable('Pi-patch-envelope',[(275+dx,125,17),(250,123,19),(215,112,31),(202,104,31),(100,104,31),(96,87,31),(111,87,31)])
 cable('DC-positive-harness-envelope',[(20,60.5,29),(40,60.5,29),(52,52,17)],r=3,mat='dc_red')
 cable('DC-return-harness-envelope',[(20,72.5,29),(40,72.5,29),(52,82,17)],r=3)
 cable('control-5V-harness-envelope',[(44,67,14),(80,67,18),(90,31,18),(238,31,18),(250,95,33),(279,102,33)],r=2)
 # Return all solids for independent saved-STEP collision auditing.
 B.service_parts=parts
 return base,lid
