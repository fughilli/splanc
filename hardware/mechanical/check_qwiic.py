"""Independent QWIIC body/cable fit screen against re-imported enclosure STEP."""
from pathlib import Path
import json,argparse,itertools
import cadquery as cq
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);R=p.parse_args().source
spec=json.loads((R/'design.json').read_text())['spec'];report={}
def box(x,y,z,w,d,h):return cq.Workplane('XY').box(w,d,h,centered=False).translate((x,y,z))
def vol(q):return q.val().Volume()
components=json.loads(Path('hardware/mechanical/advertising/board-details.json').read_text())['products']
for product in ('mini','splanc'):
 d=spec['handheld'][product];shift=spec['handheld']['assembly_z_shift_mm'];q=d['qwiic'];x,y,z=q['mouth_mm'];z+=shift
 def read(n):return cq.importers.importStep(str(R/product/(n+'.step')))
 shell=read('base').union(read('lid'));socket=read('QWIIC-JST-SH');bead=read('seam-sealant')
 assert socket.val().isValid();worst_body=0
 # A probe BETWEEN contacts must enter the mating cavity from the west.
 # The reverse orientation passes all external bbox tests but has a solid
 # rear wall here. A roof probe proves this is a real cavity, not empty space.
 cavity_probe=box(x+1,y-.15,z+.30,.8,.3,.2)
 roof_probe=box(x+1,y-.15,z+1.23,.8,.3,.2)
 cavity_overlap=vol(socket.intersect(cavity_probe));roof_material=vol(socket.intersect(roof_probe))
 assert cavity_overlap<1e-5,(product,'QWIIC mating face points inward',cavity_overlap)
 assert roof_material>.04,(product,'missing socket roof over mating cavity',roof_material)
 for dx,dy,dz in itertools.product((-.2,0,.2),repeat=3):
  v=vol(socket.translate((dx,dy,dz)).intersect(shell));worst_body=max(worst_body,v);assert v<1e-5,(product,'socket',dx,dy,dz,v)
 worst_cable=0;poses=0
 for withdrawal,dy,dz in itertools.product((0,1,3,8),(-.25,0,.25),(-.25,0,.25)):
  cable=box(x-12-withdrawal,y-3.7+dy,z-2.1+dz,12,7.4,4.2)
  v=vol(cable.intersect(shell));worst_cable=max(worst_cable,v);assert v<1e-5,(product,'cable',withdrawal,dy,dz,v);poses+=1
 # Independently expanded socket bounding box versus saved component bodies.
 bb=socket.val().BoundingBox();envelope=box(bb.xmin-.2,bb.ymin-.2,bb.zmin,bb.xlen+.4,bb.ylen+.4,bb.zlen+.2)
 for c in components[product]['components']:
  w,h,t=c['size'];cx,cy,cz=c['position'];component=box(-w/2,-h/2,0,w,h,t).rotate((0,0,0),(0,0,1),c['rotation']).translate((cx,cy,cz))
  v=vol(component.intersect(envelope));assert v<1e-5,(product,'component envelope',c['ref'],v)
 # Minimum inner opening (8 x 4.8) plus the 0.8mm dry-end setback;
 # the outward flare is wider only at the exterior face.
 mouth=box(x-12,y-4.8,z-3.2,13.5,9.6,6.4)
 assert vol(bead.intersect(mouth))<1e-5,(product,'unsupported seal across QWIIC')
 report[product]={'part':q['part'],'mouth_assembled_mm':[x,y,z],'mating_cavity_probe_overlap_mm3':cavity_overlap,'mating_roof_probe_material_mm3':roof_material,'socket_tolerance_poses':27,'socket_worst_overlap_mm3':worst_body,'cable_poses':poses,'cable_envelope_mm':[12,7.4,4.2],'cable_worst_overlap_mm3':worst_cable,'component_screen':'saved component envelopes plus 0.2mm socket allowance','pinout':q['pinout'],'electrical_status':q['status'],'qualification':'CAD/body/cable-envelope screen only; PCB footprint, routed I2C, supplier plug tolerances and ingress qualification remain open'}
 print(product,report[product],flush=True)
(R/'qwiic-fit-validation.json').write_text(json.dumps(report,indent=2)+'\n')
