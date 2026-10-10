"""Construct exact 0.5mm wedges/cones where the OCC chamfer builder rejects corners."""
import json
from pathlib import Path
import cadquery as cq
from generate_enclosures import box,ring
from chamfer_utils import planar_chamfer
F=Path('output/product-renders-final');report=json.loads((F/'finish-validation.json').read_text())
for p in ('splanc','max'):
 q=cq.importers.importStep(str(F/p/'lid.step'));left=[];fixed=[]
 for center in report[p]['remaining_local_edge_conflicts']:
  es=[e for e in q.val().Edges() if (e.Center()-cq.Vector(*center)).Length<.04]
  if not es:continue
  e=es[0];out=None
  if abs((e.positionAt(1)-e.positionAt(0)).Length-e.Length())<.001:out=planar_chamfer(q,center)
  elif e.geomType()=='CIRCLE':
   r=e.radius();x,y,z=center;cutter=cq.Solid.makeCone(r,r+.5,.5,cq.Vector(x,y,z-.5),cq.Vector(0,0,1));candidate=q.cut(cutter)
   if candidate.val().isValid() and len(candidate.val().Solids())==1:out=candidate
  if out is None:left.append(center)
  else:q=out;fixed.append(center)
 cq.exporters.export(q,str(F/p/'lid.step'));q=cq.importers.importStep(str(F/p/'lid.step'))
 g=ring(-3.1,-3.1,9.75,106.2,86.2,.5,1.1,2.8) if p=='splanc' else ring(.15,.15,46.75,334.7,133.7,.5,1.1,4.8)
 w=q.cut(g)
 if p=='max':w=w.union(box(14,28,49.3,191,82,.9)).union(box(232,16,49.3,64,44,.9))
 assert w.val().isValid() and len(w.val().Solids())==1
 cq.exporters.export(w,str(F/(p+'-weather')/'lid.step'))
 report[p]['geometric_fallbacks']=fixed;report[p]['remaining_local_edge_conflicts']=left
 print(p,'fixed',len(fixed),'remaining',left,flush=True)
(F/'finish-validation.json').write_text(json.dumps(report,indent=2)+'\n')
