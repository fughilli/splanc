"""Regression: moved connector geometry, nominal motion and rotated Pi fit."""
from pathlib import Path
import cadquery as cq,json,argparse
ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=Path('output/family-layout-r7'));R=ap.parse_args().source;reports={}
def box(x,y,z,w,d,h):return cq.Workplane('XY').box(w,d,h,centered=False).translate((x,y,z))
def trans(q):return q.translate((-225,-8,0)).rotate((0,0,0),(0,0,1),90).translate((285,28,0))
for prod in ('splanc','splanc-weather','max'):
 b=cq.importers.importStep(str(R/prod/'base.step'));l=cq.importers.importStep(str(R/prod/'lid.step'));shell=b.union(l)
 assert b.val().isValid() and l.val().isValid() and len(b.val().Solids())==len(l.val().Solids())==1
 checks={'shell_overlap':b.intersect(l).val().Volume()}
 if prod=='max':
  for f in (R/prod).glob('*.step'):
   if f.stem.startswith(('active-cooler','usb-jumper','usb-male')):checks[f.stem]=cq.importers.importStep(str(f)).intersect(shell).val().Volume()
  for i,q in enumerate(cq.importers.importStep('output/product-renders/pi5-visible-ports.step').val().Solids()):
   checks['pi-'+str(i)]=trans(cq.Workplane(obj=q).translate((225,8,8))).intersect(shell).val().Volume()
  hat=cq.importers.importStep(str(R/prod/'lv-pcb-envelope.step')) if (R/prod/'lv-pcb-envelope.step').exists() else trans(cq.importers.importStep('output/mechanical/max/lv-pcb-envelope.step'))
  checks['hat']=hat.intersect(shell).val().Volume()
  assert abs(b.val().BoundingBox().xlen-292)<1e-4
  if R.name.endswith('r7'):
   checks['ethernet-finger-tunnel']=box(266,114.3,-.5,17.5,20,13).intersect(shell).val().Volume()
   for x in (238,255.9):assert box(x-3,132,12,6,1,5).cut(b).val().Volume()<1e-5
   assert abs(l.val().BoundingBox().zmax-43)<1e-5
   for f in (R/prod).glob('hat-standoff*.step'):
    assert abs(cq.importers.importStep(str(f)).val().BoundingBox().zlen-18.4)<1e-5
   # HAT underside clearance to tallest Pi housing and cooler, with 1mm allowance.
   for name in ('Pi-housings','cooler'):
    obstruction=trans(cq.importers.importStep('output/product-renders/pi5-visible-ports.step').translate((225,8,8))) if name=='Pi-housings' else cq.importers.importStep(str(R/prod/'active-cooler-envelope.step'))
    checks['hat-'+name+'-1mm-envelope']=hat.translate((0,0,-1)).intersect(obstruction).val().Volume()
  logo=cq.importers.importStep(str(R/prod/'logo-white-inlay.step'));checks['inlay-missing-support']=logo.translate((0,0,-.7)).cut(l).val().Volume()
  # Posts still support the Pi at Z=8; clearance pockets must not lower them.
  for x,y in [(281.5,31.5),(281.5,89.5),(232.5,31.5),(232.5,89.5)]:
   probe=cq.Workplane('XY',origin=(x+2,y,7.98)).circle(.1).extrude(.01)
   assert probe.cut(b).val().Volume()<1e-7,('missing mount support',x,y)
 else:
  jst=cq.importers.importStep('hardware/splanc_dev/elec/src/parts/JST_B3B_PH_K_S_LF__SN/CONN-TH_B3B-PH-K-S.step')
  for x,y in [(94,25),(94,36)]:
   q=jst.rotate((0,0,0),(0,0,1),90).translate((x,y,7.4));checks[f'connector-{y}']=q.intersect(shell).val().Volume()
   # Upward plug insertion corridor above the connector must remain open.
   corridor=box(x-4.3,y-4.6,13.5,8.6,9.2,20);checks[f'plug-access-{y}']=corridor.intersect(shell).val().Volume()
 for k,v in checks.items():assert v<1e-4,(prod,k,v)
 reports[prod]=checks;print(prod,'PASS',max(checks.values()),flush=True)
(R/'fit-validation.json').write_text(json.dumps(reports,indent=2))
