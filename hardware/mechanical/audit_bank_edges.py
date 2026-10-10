"""Classify stale candidate edges after the shared-bank chamfer pass."""
from pathlib import Path
import json,math
import cadquery as cq
R=Path('output/product-renders-final');j=json.loads((R/'bank-validation.json').read_text())
for p,row in j.items():
 q=cq.importers.importStep(str(R/p/'base.step')).val();edges=q.Edges();faces=q.Faces();records=[]
 for point in row['unresolved_or_already_modified']:
  es=[e for e in edges if (e.Center()-cq.Vector(*point)).Length<.04]
  rec={'point':point}
  if not es:rec['classification']='edge superseded by adjacent cut'
  else:
   e=es[0];fs=[f for f in faces if any(a.isSame(e) for a in f.Edges())]
   if len(fs)!=2:rec['classification']='topology review'
   else:
    dot=max(-1,min(1,fs[0].normalAt(e.positionAt(.5)).dot(fs[1].normalAt(e.positionAt(.5)))))
    rec['angle_degrees']=math.degrees(math.acos(dot));rec['classification']='tangent surface boundary' if dot>.999 else 'local transition remains for CAD review'
  records.append(rec)
 row['candidate_audit']=records
 print(p,{x:sum(r['classification']==x for r in records) for x in set(r['classification'] for r in records)},flush=True)
(R/'bank-validation.json').write_text(json.dumps(j,indent=2)+'\n')
