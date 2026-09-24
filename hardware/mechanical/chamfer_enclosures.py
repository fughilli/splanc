"""Apply 0.5mm cosmetic exterior chamfers, preserving inlay and seal mating edges.
Record any kernel-rejected edge explicitly; retain prior outputs unchanged.
"""
import json,copy,shutil
from pathlib import Path
import cadquery as cq
S=Path('output/product-renders-access');R=Path('output/product-renders-final');R.mkdir(exist_ok=True)
s=json.loads((S/'scene.json').read_text());report={}
def candidate(e,p,part,b,logo):
 bb=e.BoundingBox();c=e.Center();eps=.015;top={'mini':20,'splanc':25,'max':53}[p];split={'mini':9,'splanc':10,'max':47}[p]
 # Inlay edges must stay coincident with their second-shot white solid.
 if logo and bb.xmin>logo.xmin-.02 and bb.xmax<logo.xmax+.02 and bb.ymin>logo.ymin-.02 and bb.ymax<logo.ymax+.02 and bb.zmin>top-.8:return False
 # Preserve flat gasket compression faces and internal tongue/groove lips.
 if abs(bb.zmax-bb.zmin)<eps and abs(c.z-split)<.6:return False
 if e.Length()<1.05:return False
 if abs(bb.zmin-top)<eps or abs(bb.zmax)<eps:return True
 if any(abs(getattr(bb,a)-getattr(bb,d))<eps and abs(getattr(bb,a)-v)<eps for a,d,v in [('xmin','xmax',b.xmin),('xmin','xmax',b.xmax),('ymin','ymax',b.ymin),('ymin','ymax',b.ymax)]):return True
 if p=='mini':return (bb.zmin>=13.9 and bb.xmin>=54 and bb.ymin>=10 and bb.ymax<=41) or (bb.xmin>=5.9 and bb.xmax<=22.1 and bb.ymax<=1.1 and bb.zmin>=4)
 if p=='splanc':return (bb.zmin>=13.9 and bb.xmin>=30 and bb.xmax<=90 and bb.ymax<=30) or (bb.xmin>=9.9 and bb.xmax<=26.1 and bb.ymax<=1.1 and bb.zmin>=4)
 return (bb.zmin>=.8 and bb.zmax<=30 and ((bb.xmin>=12 and bb.xmax<=210 and (bb.ymax<=7.3 or bb.ymin>=126.7)) or (bb.xmin>=308 and bb.ymin>=5 and bb.ymax<=75) or (bb.xmin>=225 and bb.xmax<=277 and bb.ymax<=8.3)))
def apply(q,edges):
 if not edges:return q,[],[]
 try:
  out=q.newObject(edges).chamfer(.5)
  if not out.val().isValid() or len(out.val().Solids())!=1:raise ValueError('invalid solid')
  return out,edges,[]
 except Exception:
  if len(edges)==1:return q,[],edges
  n=len(edges)//2;q,a,b=apply(q,edges[:n]);q,c,d=apply(q,edges[n:]);return q,a+c,b+d
for p in ('mini','splanc','max','mini-weather','splanc-weather','max-weather'):
 folder=R/p;folder.mkdir(exist_ok=True);base=p.replace('-weather','')
 for f in (S/p).glob('*'):
  if f.is_file():shutil.copy2(f,folder/f.name)
 logo=cq.importers.importStep(str(S/base/'logo-white-inlay.step')).val().BoundingBox()
 for part in ('base','lid'):
  q=cq.importers.importStep(str(S/p/(part+'.step')));bounds=q.val().BoundingBox()
  edges=[e for e in q.val().Edges() if candidate(e,base,part,bounds,logo)]
  print(p,part,len(edges),'candidate edges',flush=True)
  out,done,failed=apply(q,edges)
  cq.exporters.export(out,str(folder/(part+'.step')));v,f=out.val().tessellate(.055,.12)
  s['items']=[i for i in s['items'] if not(i['product']==p and i['name']==part)]
  s['items'].append(dict(name=part,product=p,material='shell_'+part,vertices=[[v.x,v.y,v.z] for v in v],faces=[list(t) for t in f]))
  report[p+'/'+part]={'requested_chamfer_mm':.5,'candidate_edges':len(edges),'applied_edges':len(done),'rejected_edges':[{'center':[e.Center().x,e.Center().y,e.Center().z],'length':e.Length()} for e in failed],'valid':out.val().isValid()}
  print('applied',len(done),'rejected',len(failed),flush=True)
(R/'scene.json').write_text(json.dumps(s));(R/'chamfer-validation.json').write_text(json.dumps(report,indent=2)+'\n')
for f in ('validation.json','access-validation.json'):
 if (S/f).exists():shutil.copy2(S/f,R/f)
