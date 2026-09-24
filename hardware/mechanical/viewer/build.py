"""Build local, per-product mesh packs from reviewed CAD scene and switch STEP."""
from pathlib import Path
import sys,json,gzip,shutil,argparse
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import cadquery as cq
from generate_enclosures import box
R=Path('output/mechanical-viewer');R.mkdir(exist_ok=True)
ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=Path('output/compact-handheld-r9'));args=ap.parse_args();S=args.source
data=json.loads((S/'scene.json').read_text())
q=cq.importers.importStep('hardware/splanc_dev/elec/src/parts/E_Switch_TL3340AF160QG/SW-SMD_E-SWITCH_TL3340.step')
reports={}
for product in ('mini','splanc','max','splanc-weather'):
 items=[i for i in data['items'] if i['product']==product]
 if product in ('mini','splanc','splanc-weather'):
  poses=[('SW2',34,3.5),('SW1',42,3.5),('SW3',51,3.5),('SW4',59,3.5)] if product=='mini' else [(b['ref'],*b['position']) for b in json.load(open('hardware/splanc/interface.json'))['boards']['splanc']['buttons']]
  for button_index,(name,x,y) in enumerate(sorted(poses,key=lambda p:p[1])):
   # Raw STEP seating plane is Z=-1.65. Seat it on PCB top Z7.4.
   for idx,solid in enumerate(q.val().Solids()[:5]):
    dz=-1.6 if data.get('revision')=='compact-handheld-r9' else 0
    placed=solid.translate((x,y,9.05+dz))
    if idx==0 and any(i.get('motion')=='rigid' for i in data['items']):
     region=cq.Workplane('XZ',origin=(x,1.69,9.1+dz)).circle(1.02).extrude(-.66)
     actuator=placed.intersect(region.val());placed=placed.cut(region.val())
     if actuator.Volume()>0:
      v,f=actuator.tessellate(.025,.1)
      items.append(dict(name=name+' actuator',material='switch_body',vertices=[[a.x,a.y,a.z] for a in v],faces=f,group='Switch '+name,motion='actuator',button_index=button_index))
    v,f=placed.tessellate(.025,.1)
    items.append(dict(name=name+(' housing' if idx==0 else ' metal')+str(idx),material='switch_body' if idx==0 else 'nickel',vertices=[[a.x,a.y,a.z] for a in v],faces=f,group='Switch '+name,note='Reference STEP seated on PCB; seated using corrected source footprint Z offset. Switch internals are not a kinematic model.'))
 for i in items:
  i['vertices']=[[round(c,5) for c in v] for v in i['vertices']]
  i.setdefault('group',i['name'].rsplit('-',1)[0] if i['name'].rsplit('-',1)[-1].isdigit() and i['material'] not in ('fastener','seal') else i['name'])
 payload=json.dumps({'product':product,'revision':data.get('revision'),'items':items},separators=(',',':')).encode()
 (R/(product+'.json')).write_bytes(payload)
 (R/(product+'.json.gz')).write_bytes(gzip.compress(payload))
if (S/'validation.json').exists() and any(i.get('motion')=='rigid' for i in data['items']):
  reports={'revision':S.name,'validation':json.loads((S/'validation.json').read_text())}
  if (S/'user-view.json').exists():shutil.copy2(S/'user-view.json',R/'user-view.json')
print({k:v for k,v in reports.items() if k!='validation'})
(R/'inspection.json').write_text(json.dumps(reports,indent=2))
for p in Path('hardware/mechanical/viewer').iterdir():
 if p.suffix in ('.html','.js'):shutil.copy2(p,R/p.name)
shutil.copytree('hardware/mechanical/viewer/vendor',R/'vendor',dirs_exist_ok=True)
