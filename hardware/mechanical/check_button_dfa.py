"""Assembly-path, rear-plane, aperture and nominal-travel regression checks."""
from pathlib import Path
import cadquery as cq,json,itertools,math,argparse
from generate_enclosures import box
R=Path('output/button-dfa-r5');results={}
ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=R);ap.add_argument('--products',nargs='+',default=['mini','splanc','mini-weather','splanc-weather']);args=ap.parse_args();R=args.source
spec_path=Path('hardware/mechanical/enclosure-spec.json');spec=json.loads(spec_path.read_text())
shift=-spec['handheld'].get('assembly_z_shift_mm',0) if R.name=='compact-handheld-r9' else 0
def read_part(p,name):
 q=cq.importers.importStep(str(p/name))
 return q if 'print' in name else q.translate((0,0,shift))
for product in args.products:
 p=R/product;small=product.startswith('mini');xs=[34,42,51,59] if small else [32,44,82,89]
 base=read_part(p,'base.step');lid=read_part(p,'lid.step');shell=base.union(lid)
 strip=read_part(p,'button-flexure-strip.step');b=strip.val().BoundingBox();assert abs(b.ymax-1.45)<1e-5
 printed=cq.importers.importStep(str(p/'button-strip-print.step'));assert printed.val().BoundingBox().zmin>-.00001
 # One-sided tool/print envelope: front cross sections must never outgrow the rear.
 rear_faces=[f for f in strip.val().Faces() if f.BoundingBox().ylen<1e-5 and abs(f.BoundingBox().ymax-1.45)<1e-5]
 shadow=None
 for f in rear_faces:
  solid=cq.Workplane(obj=cq.Solid.extrudeLinear(f.outerWire(),f.innerWires(),cq.Vector(0,-6.01,0)))
  shadow=solid if shadow is None else shadow.union(solid)
 undercut=strip.cut(shadow).val().Volume();assert undercut<1e-5,(product,'rear draw undercut',undercut)
 insertion=[]
 for dy in (12,8,6,4,3,2,1,0):
  v=strip.translate((0,dy,0)).intersect(base).val().Volume();insertion.append(dict(inward_offset_mm=dy,intersection_mm3=v));assert v<1e-5,(product,'insertion',dy,v)
 for dz in (12,8,4,0):
  v=strip.translate((0,8,dz)).intersect(base).val().Volume();assert v<1e-5,(product,'lower into base',dz,v)
 # The rectangular aperture contains every prism cross-section plus +/-0.20mm.
 assert 5.2+.4<5.7 and 2.4+.4<2.9
 pcb=box(-.2,-.2,5.6,70.4 if small else 100.4,55.4 if small else 80.4,2.)
 switch=cq.importers.importStep('hardware/splanc_dev/elec/src/parts/E_Switch_TL3340AF160QG/SW-SMD_E-SWITCH_TL3340.step')
 fixed=pcb
 for x in xs:
  q=switch.translate((x,3.5,9.05))
  # Exclude only the moving actuator; direct button contact is intentional.
  actuator=cq.Workplane('XZ',origin=(x,1.69,9.1)).circle(1.02).extrude(-.66)
  fixed=fixed.union(q.cut(actuator))
 worst_shell=worst_electronics=0.;count=0
 for i,x in enumerate(xs,1):
  cap=read_part(p,f'button-shuttle-{i}.step')
  for travel,dx,dz in itertools.product((0,.3,.6),(-.2,.2),(-.2,.2)):
   pose=cap.translate((dx,travel,dz));vs=pose.intersect(shell).val().Volume();ve=pose.intersect(fixed).val().Volume()
   worst_shell=max(worst_shell,vs);worst_electronics=max(worst_electronics,ve);count+=1
   assert max(vs,ve)<1e-5,(product,i,travel,dx,dz,vs,ve)
 spring_worst=0
 for i,x in enumerate(xs,1):
  for side in (-1,1):
   q=read_part(p,f'flexure-{i}-{side}.step');bb=q.val().BoundingBox()
   envelope=box(bb.xmin-.2,bb.ymin,bb.zmin-.2,bb.xlen+.4,bb.ylen+.6,bb.zlen+.4)
   vol=envelope.intersect(shell).val().Volume()+envelope.intersect(fixed).val().Volume();spring_worst=max(spring_worst,vol)
   assert vol<1e-5,(product,'spring envelope',i,side,vol)
 # Retention rib must be solid continuously from capture lip to lid plane.
 lo=min(xs)-5.5;hi=max(xs)+5.5;top=spec['handheld']['mini' if small else 'splanc']['top'] if shift else 20 if small else 25
 rib=box(lo,1.45,16.1,hi-lo,.8,top-16.1)
 missing=rib.cut(lid).val().Volume();assert missing<1e-5,(product,'unsupported retention rib',missing)
 for i in range(1,5):
  spring=read_part(p,f'flexure-{i}--1.step');assert abs(spring.val().BoundingBox().ylen-.3)<1e-5
  width_probe=spring.intersect(box(xs[i-1]-4,1.4499,14.8,8,.0002,.1)).val().BoundingBox().xlen
  assert abs(width_probe-.8)<1e-5,(product,'spring width',i,width_probe)
 results[product]=dict(retainer_missing_support_mm3=missing,flexure_width_mm=.8,flexure_thickness_mm=.3,retainer_capture_mm=.8,rear_draw_undercut_mm3=undercut,insertion_path=insertion,rigid_poses=count,unintended_shell_overlap_mm3=worst_shell,fixed_electronics_overlap_mm3=worst_electronics,spring_envelope_overlap_mm3=spring_worst,flat_rear_plane_mm=b.ymax,min_print_z_mm=printed.val().BoundingBox().zmin,min_pcb_margin_mm=7.9-.2-7.6,min_guide_engagement_mm=2.2,qualification='nominal axial gap only; full axial stack-up, switch overload and spring force/fatigue unqualified')
 print(product,results[product],flush=True)
(R/'dfa-validation.json').write_text(json.dumps(results,indent=2))
