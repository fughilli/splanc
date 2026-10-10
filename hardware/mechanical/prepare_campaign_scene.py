from pathlib import Path
import json,shutil,argparse
import cadquery as cq
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=Path('output/product-renders-campaign'));args=parser.parse_args()
R=args.output;R.mkdir(exist_ok=True);F=Path('output/product-renders-final');A=Path('output/product-renders-access')
s=json.loads((A/'scene.json').read_text());names=('mini','splanc','max','splanc-weather')
s['items']=[i for i in s['items'] if i['product'] in names and i['name'] not in ('base','lid')]
for p in names:
 out=R/p;out.mkdir(exist_ok=True)
 for file in (F/p).glob('*'):
  if file.is_file():shutil.copy2(file,out/file.name)
 for n in ('base','lid'):
  q=cq.importers.importStep(str(F/p/(n+'.step')));v,f=q.val().tessellate(.055,.12)
  s['items'].append(dict(name=n,product=p,material='shell_'+n,vertices=[[a.x,a.y,a.z] for a in v],faces=[list(t) for t in f]))
for p in ('mini-weather','max-weather'):
 out=R/p;out.mkdir(exist_ok=True)
 for file in (F/p).glob('*'):
  if file.is_file():shutil.copy2(file,out/file.name)
for file in F.glob('*validation.json'):shutil.copy2(file,R/file.name)
s['material_sources']=json.loads(Path('output/ambientcg/sources.json').read_text());(R/'scene.json').write_text(json.dumps(s))
print('Prepared campaign scene')
