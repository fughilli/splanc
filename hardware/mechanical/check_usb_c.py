"""Verify real shell fit, web thickness, cable insertion and interrupted sealants.
Mating envelopes are deliberately explicit prototype assumptions, not USB certification.
"""
from pathlib import Path
import argparse,json,itertools,math
import cadquery as cq
ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=Path('output/usb-conformal-r10'));R=ap.parse_args().source
spec=json.loads((R/'design.json').read_text())['spec'];d=spec['usb_c'];report={}
def v(q):return q.val().Volume()
def read(p,n):return cq.importers.importStep(str(R/p/(n+'.step')))
def plane(origin,normal,u,t,du=0,dv=0):return cq.Plane(origin=tuple(origin[i]+normal[i]*t+u[i]*du+(dv if i==2 else 0) for i in range(3)),xDir=u,normal=normal)
def capsule(origin,normal,u,t,length,w,h,du=0,dv=0):return cq.Workplane(plane(origin,normal,u,t,du,dv)).slot2D(w,h).extrude(length)
def rect(origin,normal,u,t,length,w,h,r,du=0,dv=0):
 wire=cq.Workplane(plane(origin,normal,u,t,du,dv)).rect(w,h).val();wire=wire.fillet2D(r,wire.Vertices())
 return cq.Workplane(obj=cq.Solid.extrudeLinear(wire,[],cq.Vector(*(n*length for n in normal))))
for p in ('mini','splanc','max'):
 if p=='max' and spec['max'].get('exposed_pi_ports')==[]:continue
 b,l=read(p,'base'),read(p,'lid');shell=b.union(l);bead=read(p,'seam-sealant')
 if p=='max':origin=(286.2,39.2,11.016);normal=(1,0,0);u=(0,1,0)
 else:origin=(spec['handheld'][p]['usb_x'],-1.45,9.13+spec['handheld']['assembly_z_shift_mm']);normal=(0,-1,0);u=(1,0,0)
 # Test the socket-shaped clearance itself at the 0.8mm web, independently of cutter code.
 back=d['web_back_mm'];front=back+d['web_thickness_mm'];sw=d['shell_width_mm'];sh=d['shell_height_mm'];worst_shell=0
 for du,dv in itertools.product((-.2,0,.2),repeat=2):
  # Circular radial tolerance, not .2+.2 diagonal beyond the nominal .30 gap.
  q=capsule(origin,normal,u,back-.02,.86,sw,sh,du,dv);overlap=v(q.intersect(shell));worst_shell=max(worst_shell,overlap);assert overlap<1e-4,(p,'socket allowance',du,dv,overlap)
 # A 16x8 rounded overmold can reach the socket plane, then withdraw straight.
 # Metallic plug tongue enters through the socket; only case interference is checked.
 worst=0;count=0
 for t,du,dv in itertools.product((0,.1,1,3,7,15),(-.25,0,.25),(-.25,0,.25)):
  mold=rect(origin,normal,u,t,18,16,8,1.5,du,dv)
  tongue=capsule(origin,normal,u,t-6.5,6.5,8.3,2.55,du,dv)
  overlap=v(mold.union(tongue).intersect(shell));worst=max(worst,overlap);count+=1
  assert overlap<1e-4,(p,'cable insertion',t,du,dv,overlap)
 # Positive material samples distinguish a genuinely thin surround from an oversized void.
 web=[]
 for du,dv in ((sw/2+.8,0),(-sw/2-.8,0),(0,sh/2+.8),(0,-sh/2-.8)):
  probe=cq.Workplane(plane(origin,normal,u,back-.25,du,dv)).rect(.08,.08).extrude(d['web_thickness_mm']+.5)
  material=probe.intersect(shell);assert v(material)>.004,(p,'missing web',du,dv)
  bb=material.val().BoundingBox();thickness=bb.xlen if p=='max' else bb.ylen;web.append(thickness)
  assert abs(thickness-.8)<1e-4,(p,'web thickness',thickness)
 # No sealant floating through any portion of the USB opening or cable well.
 mouth=rect(origin,normal,u,back-1,12,20,12,2)
 assert v(bead.intersect(mouth))<1e-5,(p,'floating seal at USB')
 assert v(bead.intersect(shell))<1e-5,(p,'sealant gland overlap')
 for part in bead.solids().vals():
  segment=cq.Workplane(obj=part)
  contact=max(v(segment.translate((0,0,dz)).intersect(shell)) for dz in (-.3,.3))
  assert contact>.001,(p,'unsupported sealant segment')
 report[p]={'shell_clearance_mm':.30,'shell_9_tolerance_poses_worst_intersection_mm3':worst_shell,'web_measured_mm':web,'cable_poses':count,'cable_worst_case_intersection_mm3':worst,'cable_mold_mm':[16,8,18],'sealant_segments':len(bead.solids().vals()),'sealant_at_usb_mm3':v(bead.intersect(mouth)),'qualification':'Nominal reference fit and explicit cable envelope only; not all cable overmolds, material, sealant adhesion or ingress qualification.'}
 print(p,report[p],flush=True)
(R/'usb-fit-validation.json').write_text(json.dumps(report,indent=2)+'\n')
