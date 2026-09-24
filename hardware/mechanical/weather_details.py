"""Complete visual sealing collars and service-cover details for weather study.
Nominal molded seals, not supplier-qualified ingress-rated components.
"""
import json
from pathlib import Path
import cadquery as cq
from generate_enclosures import box,cylinder,ring
R=Path('output/product-renders-access');s=json.loads((R/'scene.json').read_text())
jst=cq.importers.importStep('hardware/splanc_dev/elec/src/parts/JST_B3B_PH_K_S_LF__SN/CONN-TH_B3B-PH-K-S.step')
mini=json.loads(Path('output/mechanical/mini-board.json').read_text());sp=json.loads(Path('hardware/splanc/interface.json').read_text())['boards']['splanc']
def emit(name,q,product):
 v,f=q.val().tessellate(.055,.12)
 s['items']=[i for i in s['items'] if not(i['product']==product and i['name']==name)]
 s['items'].append(dict(name=name,product=product,material='seal',vertices=[[p.x,p.y,p.z] for p in v],faces=[list(t) for t in f]))
 cq.exporters.export(q,str(R/product/(name+'.step')))
for product in ('mini','splanc'):
 weather=product+'-weather';small=product=='mini';ports=[(64,20),(64,31)] if small else [tuple(c['position']) for c in sp['connectors'] if c['kind']=='jst_ph3_vertical']
 for n,(x,y) in enumerate(ports):
  model=jst.rotate((0,0,0),(0,0,1),90 if small else 0).translate((x,y,7.4))
  body_top=model.val().BoundingBox().zmax;bottom=body_top-.8
  section=model.intersect(box(x-12,y-12,bottom,24,24,.6));b=section.val().BoundingBox()
  outer=box(x-4.6,y-4.9,bottom,9.2,9.8,14.15-bottom,.4)
  # Rectangular housing envelope, rather than individual walls, preserves contact cavity.
  collar=outer.cut(box(b.xmin-.05,b.ymin-.05,bottom-.1,b.xlen+.1,b.ylen+.1,14.4-bottom))
  emit('LED-connector-seal-'+str(n+1),collar,weather)
 ux=14 if small else 18
 collar=cq.Workplane('XZ',origin=(ux,.2,9.2)).rect(11.2,6.8).rect(9,3.5).extrude(.8)
 emit('USB-perimeter-seal',collar,weather)
 if small:
  buttonrefs=[p['ref'] for p in json.loads(Path('hardware/mechanical/mini-ports.json').read_text())['ports'] if p['ref'].startswith('SW')]
  buttons=[c['position'][0] for c in mini['components'] if c['ref'] in buttonrefs]
  pogo=next(c for c in mini['components'] if c['ref']=='TP1');x,y=pogo['position']
  # Pogo access is board-level EoL only; assembled housing has a closed floor.
 else:buttons=[b['position'][0] for b in sp['buttons']]
 for n,x in enumerate(buttons):
  boot=cq.Workplane('XZ',origin=(x,-3.5,9.1)).rect(5.8,5.8).rect(3.1,3.1).extrude(.45)
  emit('button-bonded-boot-'+str(n+1),boot,weather)
# Pi service-interface collars, provisional envelopes to be supplier matched.
for n,(y,w,h) in enumerate(((18.2,19,17),(37.1,17,18),(55,17,18))):
 q=cq.Workplane('YZ',origin=(310,y,9+h/2)).rect(w+.5,h+.5).rect(w-1.2,h-1.2).extrude(1.8)
 emit('Pi-east-collar-'+str(n+1),q,'max-weather')
for n,(x,w) in enumerate(((236.2,12),(250.8,9),(264.2,9))):
 q=cq.Workplane('XZ',origin=(x,7.5,12)).rect(w+1,7.2).rect(w-1,4.8).extrude(.8)
 emit('Pi-south-collar-'+str(n+1),q,'max-weather')
for y in (52,82):
 q=cq.Workplane('YZ',origin=(.1,y,17.25)).rect(13.2,13.2).circle(3.6).extrude(1.2)
 emit('lug-seal-'+str(y),q,'max-weather')
(R/'scene.json').write_text(json.dumps(s));print('Weather details updated')
