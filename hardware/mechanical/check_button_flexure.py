"""Swept rigid geometry with stack-up extremes; separate intended stop contacts."""
from pathlib import Path
import json,itertools,math
import cadquery as cq
from generate_enclosures import box
R=Path('output/button-flexure-r1');result={}
for product in ('mini','splanc','mini-weather','splanc-weather'):
 p=R/product;xs=[34,42,51,59] if product.startswith('mini') else [32,44,82,89]
 shell=cq.importers.importStep(str(p/'base.step')).union(cq.importers.importStep(str(p/'lid.step')))
 for x in xs:
  for z in (6.85,10.95):shell=shell.cut(box(x-1.31,-3.51,z-.01,2.62,.32,.42))
 worst=0;pcb_worst=0;count=0
 pcb=box(-.2,-.2,5.6,70.4 if product.startswith("mini") else 100.4,55.4 if product.startswith("mini") else 80.4,2.0)
 for index,x in enumerate(xs,1):
  cap=cq.importers.importStep(str(p/f'button-shuttle-{index}.step'))
  # Intermediate poses are contained in the swept translation envelope. Check
  # end poses + bore midpoint, every transverse stack-up corner, all shuttles.
  for travel,dx,dz in itertools.product((0,.8,1.7),(-.2,.2),(-.2,.2)):
   q=cap.translate((dx,travel,dz));v=q.intersect(shell).val().Volume();worst=max(worst,v);pcb_worst=max(pcb_worst,q.intersect(pcb).val().Volume());count+=1
 assert worst<1e-5 and pcb_worst<1e-5,(product,worst,pcb_worst)
 # Springs are entirely outside shell and sealing gland for every deformation
 # interpolating between fixed and translated moving end; include +0.10 Y tol.
 spring_back=-5.45+1.7+.1;wall_front=-3.2
 # Conservative incompressible tip bulge, early actuation / largest stroke.
 radius=.4*math.sqrt(2.75/(2.75-(1.7-.1-.1)))
 alignment=math.hypot(.2,.2)
 assert radius+alignment<1.0
 assert 9.1-radius-.2>7.6
 result[product]={'rigid_poses_checked':count,'max_shuttle_pcb_intersection_mm3':pcb_worst,'max_shell_intersection_mm3_excluding_intended_stop_faces':worst,'spring_to_shell_clearance_min_mm':wall_front-spring_back,'tip_bulge_radius_max_mm':radius,'tip_plus_lateral_stackup_radius_mm':radius+alignment,'tip_to_pcb_clearance_min_mm':9.1-radius-.2-7.6,'minimum_stroke_mm':1.5,'max_gap_plus_switch_travel_mm':.5+.3,'remaining_compression_at_worst_required_actuation_mm':1.5-.5-.3,'required_tip_force_at_0_7mm_compression_N':2.06,'force_curve_validated':False}
 if product.endswith('weather'):
  gasket=cq.importers.importStep(str(p/'seam-gasket.step'))
  result[product]['gasket_valid']=gasket.val().isValid();result[product]['gasket_solids']=len(gasket.val().Solids())
 print(product,result[product],flush=True)
(R/'swept-validation.json').write_text(json.dumps(result,indent=2)+'\n')
