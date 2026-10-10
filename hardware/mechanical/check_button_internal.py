"""Internal button clearance regression: rigid poses and conservative spring sweep."""
from pathlib import Path
import cadquery as cq,json,itertools,argparse,math
from generate_enclosures import box
R=Path('output/button-flexure-r2');results={}
ap=argparse.ArgumentParser();ap.add_argument('--products',nargs='+',default=['mini','splanc','mini-weather','splanc-weather']);args=ap.parse_args()
for product in args.products:
 p=R/product;small=product.startswith('mini');xs=[34,42,51,59] if small else [32,44,82,89]
 shell=cq.importers.importStep(str(p/'base.step')).union(cq.importers.importStep(str(p/'lid.step')))
 # Inward stop end faces are intentional; omit only their lips for +0.1mm stop tolerance.
 for x in xs:
  for sign in (-1,1):
   lip=x+1.7 if sign>0 else x-3.35
   shell=shell.cut(box(lip-.01,.99,7.99,1.67,.32,2.22))
 pcb=box(-.2,-.2,5.6,70.4 if small else 100.4,55.4 if small else 80.4,2.)
 switches=cq.importers.importStep('hardware/splanc_dev/elec/src/parts/E_Switch_TL3340AF160QG/SW-SMD_E-SWITCH_TL3340.step')
 obstacles=pcb
 for x in xs:obstacles=obstacles.union(switches.translate((x,3.5,9.05)))
 worst_shell=worst_electronics=0.;count=0
 for i,x in enumerate(xs,1):
  q=cq.importers.importStep(str(p/f'button-shuttle-{i}.step'))
  for travel,dx,dz in itertools.product((0,.8,1.7),(-.2,.2),(-.2,.2)):
   pose=q.translate((dx,travel,dz));vs=pose.intersect(shell).val().Volume();ve=pose.intersect(obstacles).val().Volume()
   worst_shell=max(worst_shell,vs);worst_electronics=max(worst_electronics,ve);count+=1
   assert max(vs,ve)<1e-5,(product,i,travel,dx,dz,vs,ve)
 # Entire spring translation hull overbounds the illustrated flexure deformation.
 spring_worst=0
 for i,x in enumerate(xs,1):
  for side in (-1,1):
   q=cq.importers.importStep(str(p/f'flexure-{i}-{side}.step'));bb=q.val().BoundingBox()
   envelope=box(bb.xmin-.2,bb.ymin-.1,bb.zmin-.2,bb.xlen+.4,bb.ylen+1.9,bb.zlen+.4)
   vol=envelope.intersect(shell).val().Volume()+envelope.intersect(obstacles).val().Volume();spring_worst=max(spring_worst,vol)
   assert vol<1e-5,(product,'spring envelope',i,side,vol)
 tip_radius=.4*math.sqrt(2.05/(2.05-1.5))
 assert 9.1-tip_radius-.2>7.6
 results[product]=dict(tip_pcb_margin_mm=9.1-tip_radius-.2-7.6,rigid_poses=count,unintended_shell_overlap_mm3=worst_shell,electronics_overlap_mm3=worst_electronics,spring_envelope_overlap_mm3=spring_worst,exterior='only original 5mm button faces; no bezel/fasteners',qualification='allocated dimensions; force/fatigue/production tolerance unqualified')
 print(product,results[product],flush=True)
(R/'swept-validation.json').write_text(json.dumps(results,indent=2))
