"""Archive reviewed STEP parts, renders, pricing and provenance without runtime caches."""
from pathlib import Path
import hashlib,json,zipfile,argparse
parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path('output/product-renders-black'));parser.add_argument('--archive',type=Path,default=Path('hardware/mechanical/releases/splanc-black-inlay-assets-20260921.zip'));parser.add_argument('--scene-archive',type=Path);args=parser.parse_args()
root=args.root;target=args.archive
files={}
def add(path,folder):
 p=Path(path)
 if p.is_file():files[str(Path(folder)/p.name)]=p
products=[p for p in ('mini','splanc','max','mini-weather','splanc-weather','max-weather') if (root/p).is_dir()]
for product in products:
 for p in (root/product).glob('*.step'):add(p,'parts/'+product)
 add(root/product/'README.txt','parts/'+product)
for p in root.glob('*.png'):
 if p.stem in {'family',*[f'{x}-{y}' for x in products for y in ('hero','ports')]}:add(p,'renders')
for name in ('splanc-products.blend','scene.json','validation.json','access-validation.json','chamfer-validation.json','finish-validation.json','bank-validation.json','panel-trim-validation.json','boss-validation.json','mini-vent-validation.json','render-validation.json'):add(root/name,'scene')
for name in ('PRODUCT-RENDERS.md','CAMPAIGN-RENDERS.md','WEATHER-STUDY.md','assets/ambientcg-sources.json','assets/degson-connectors.json','assets/max-connectors.json'):add(Path('hardware/mechanical')/name,'review')
if (root/'clean-plastic-material.json').exists():
 for n in ('material.json','height.png','normal.png'):add(Path('output/clean-plastic')/n,'materials/clean-plastic')
for p in Path('hardware/mechanical/assets/max-connectors').glob('*'):add(p,'reference-models')
add('output/mechanical/sources/pi5/LICENSE.txt','reference-models/pi5')
for name in ('mini','max'):
 for pattern in ('busbar-*.step','button-*.step','lightpipe-*.step'):
  for p in Path('output/mechanical',name).glob(pattern):add(p,'parts/'+name)
for name in ('splanc','splanc_max'):
 for fn in ('interface.json','validation.json','TELEMETRY.md'):add(Path('hardware')/name/fn,'electronics/'+name)
for fn in ('launch-prices.json','assumptions.json','max-costdown-sourcing.json'):add(Path('hardware/pricing')/fn,'pricing')
for fn in ('bom.csv','summary.json'):add(Path('hardware/splanc_max/costing')/fn,'pricing/max')
add('docs/hardware/launch-pricing.md','pricing')
if args.scene_archive:
 scene_files={name:files.pop(name) for name in list(files) if name.endswith('.blend')}
 with zipfile.ZipFile(args.scene_archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
  for name,p in scene_files.items():z.write(p,name)
  z.writestr('SHA256.json',json.dumps({n:hashlib.sha256(p.read_bytes()).hexdigest() for n,p in scene_files.items()},indent=2)+'\n')
 print(args.scene_archive,args.scene_archive.stat().st_size,'bytes')
manifest={name:hashlib.sha256(p.read_bytes()).hexdigest() for name,p in sorted(files.items())}
target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for name,p in sorted(files.items()):z.write(p,name)
 z.writestr('SHA256.json',json.dumps(manifest,indent=2)+'\n')
print(target, target.stat().st_size, 'bytes',len(files),'files')
