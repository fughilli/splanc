"""Perimeter-first lid repair and exact Pi port clearances for final CAD study."""
from pathlib import Path
import cadquery as cq,json,argparse
from generate_enclosures import box,ring
from chamfer_utils import planar_chamfer
A=Path('output/product-renders-access');F=Path('output/product-renders-final');parser=argparse.ArgumentParser();parser.add_argument('--products',nargs='+',default=['splanc','max']);selected=parser.parse_args().products;report=json.loads((F/'finish-validation.json').read_text()) if (F/'finish-validation.json').exists() else {}
def outer_top(q,top):
 b=q.val().BoundingBox();edges=[]
 for e in q.val().Edges():
  bb=e.BoundingBox();v=e.Center()
  if abs(bb.zmin-top)<.001 and min(abs(v.x-b.xmin),abs(v.x-b.xmax),abs(v.y-b.ymin),abs(v.y-b.ymax))<3.1:edges.append(e)
 return q.newObject(edges).chamfer(.5),len(edges)

for p,top in [('splanc',25),('max',53)]:
 if p not in selected:continue
 q=cq.importers.importStep(str(A/p/'lid.step'));q,count=outer_top(q,top)
 # Remaining visible top openings are handled in small spatial groups, using
 # fresh edge topology after every successful operation. Preserve inlay edges.
 logo=cq.importers.importStep(str(A/p/'logo-white-inlay.step')).val().BoundingBox();done=0;failed=[]
 original=[e for e in q.val().Edges() if abs(e.BoundingBox().zmin-top)<.001 and e.Length()>1.05]
 b=q.val().BoundingBox()
 for e in original:
  c=e.Center();bb=e.BoundingBox()
  if min(abs(c.x-b.xmin),abs(c.x-b.xmax),abs(c.y-b.ymin),abs(c.y-b.ymax))<3.7:continue
  if bb.xmin>logo.xmin-.02 and bb.xmax<logo.xmax+.02 and bb.ymin>logo.ymin-.02 and bb.ymax<logo.ymax+.02:continue
  matches=[f for f in q.val().Edges() if (f.Center()-c).Length<.02 and abs(f.Length()-e.Length())<.03]
  if not matches:continue
  try:
   result=q.newObject([matches[0]]).chamfer(.5)
   if not result.val().isValid():raise ValueError('invalid')
   q=result;done+=1
  except Exception:failed.append([c.x,c.y,c.z])
 manual=[]
 if p=='splanc':
  remaining=[]
  for center in failed:
   fixed=planar_chamfer(q,center)
   if fixed is None:remaining.append(center)
   else:q=fixed;manual.append(center)
  failed=remaining
 assert q.val().isValid() and len(q.val().Solids())==1
 cq.exporters.export(q,str(F/p/'lid.step'))
 q=cq.importers.importStep(str(F/p/'lid.step'))
 # Weather treatment differs only by subtractive seal grooves and vent blanks.
 g=ring(-3.1,-3.1,9.75,106.2,86.2,.5,1.1,2.8) if p=='splanc' else ring(.15,.15,46.75,334.7,133.7,.5,1.1,4.8)
 w=q.cut(g)
 if p=='max':w=w.union(box(14,28,49.3,191,82,.9)).union(box(232,16,49.3,64,44,.9))
 assert w.val().isValid() and len(w.val().Solids())==1
 cq.exporters.export(w,str(F/(p+'-weather')/'lid.step'))
 report[p]={'outer_top_edges_chamfered':count,'additional_top_edges_chamfered':done,'remaining_local_edge_conflicts':failed,'planar_chamfer_fallbacks':manual}
 print(p,report[p],flush=True)
 (F/'finish-validation.json').write_text(json.dumps(report,indent=2)+'\n')
# Clear Pi shells against actual body envelopes, including below-board tabs.
pi=cq.importers.importStep('output/product-renders/pi5-visible-ports.step').val();groups=[[],[],[]]
for solid in pi.Solids():
 b=solid.BoundingBox()
 if b.xmin>60 and b.xmax>84:
  cy=(b.ymin+b.ymax)/2;i=min(range(3),key=lambda i:abs(cy-[10.2,29,47][i]));groups[i].append(solid)
cutters=[]
for group in groups:
 b=cq.Compound.makeCompound(group).BoundingBox()
 cutters.append(cq.Workplane('XY').box(b.xlen+.6,b.ylen+.6,b.zlen+.6,centered=False).translate((225+b.xmin-.3,8+b.ymin-.3,8+b.zmin-.3)))
for p in ('max','max-weather') if 'max' in selected else ():
 q=cq.importers.importStep(str(F/p/'base.step'))
 for c in cutters:q=q.cut(c)
 q=q.cut(box(308,7.7,7.7,3.0,56.6,2.0))
 assert q.val().isValid() and len(q.val().Solids())==1
 overlap=q.intersect(cq.Workplane('XY').newObject([pi.translate((225,8,8))])).val().Volume()
 assert overlap<.01,overlap
 cq.exporters.export(q,str(F/p/'base.step'));report[p+'/Pi_overlap_mm3']=overlap
(F/'finish-validation.json').write_text(json.dumps(report,indent=2)+'\n')
