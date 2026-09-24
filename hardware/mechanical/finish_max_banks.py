"""Replace thin terminal-window ribs with clean shared recesses and 0.5mm rims."""
from pathlib import Path
import json
import cadquery as cq
from generate_enclosures import box
from chamfer_utils import planar_chamfer
F=Path('output/product-renders-final')
def funnel(x,y,z,w,h,depth,W,H,direction=1):return cq.Workplane('XZ',origin=(x,y,z)).rect(W,H).workplane(offset=-direction*depth).rect(w,h).loft()
report={}
for p in ('max','max-weather'):
 q=cq.importers.importStep(str(F/p/'base.step'))
 # Restore the old thin lips before cutting one continuous bank mouth.
 for y in (0,131.2):q=q.union(box(11.8,y,0,190.4,2.8,2.1))
 for y,d in ((-.01,1),(134.01,-1)):q=q.cut(funnel(107,y,12.3,189.2,13,7.2,190,21,d))
 # Merge the three small Pi-side access funnels into one clean recess.
 q=q.cut(funnel(250.2,-.01,12,41,6,8.2,47,12))
 # Re-import removes boolean history/tolerance noise before edge operations.
 cq.exporters.export(q,str(F/p/'base.step'));q=cq.importers.importStep(str(F/p/'base.step'))
 candidates=[]
 for e in q.val().Edges():
  c=e.Center();bb=e.BoundingBox()
  if abs((e.positionAt(1)-e.positionAt(0)).Length-e.Length())>.001:continue
  if (abs(c.y)<.03 or abs(c.y-134)<.03) and (c.z<.01 or 1.1<c.z<30):candidates.append([c.x,c.y,c.z])
  elif abs(c.x-335)<.03 and 1.1<c.z<36:candidates.append([c.x,c.y,c.z])
 fixed=[];skipped=[]
 for center in candidates:
  out=planar_chamfer(q,center)
  if out is None:skipped.append(center)
  else:q=out;fixed.append(center)
 assert q.val().isValid() and len(q.val().Solids())==1
 cq.exporters.export(q,str(F/p/'base.step'));report[p]={'rim_chamfer_mm':.5,'fixed_edges':fixed,'unresolved_or_already_modified':skipped,'bank_mouth_mm':[190,21],'minimum_unbeveled_lower_lip_mm':1.8}
 print(p,'chamfers',len(fixed),'unresolved',len(skipped),flush=True)
(F/'bank-validation.json').write_text(json.dumps(report,indent=2)+'\n')
