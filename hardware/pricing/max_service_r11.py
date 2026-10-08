"""Reconciled MAX r11 procurement budget; no unquoted volume discount assumed."""
import csv,json,math
from pathlib import Path
R=Path(__file__).resolve().parents[2]
O=R/'output/advertising-kit-20261008/pricing';O.mkdir(parents=True,exist_ok=True)
old=json.loads((R/'hardware/pricing/assumptions.json').read_text())
rows=[]
for line in csv.DictReader((R/'hardware/splanc_max/costing/bom.csv').open()):
    rows.append(dict(group=line['board'],part=line['part'],qty=float(line['quantity']),low=float(line['low_unit_usd']),mid=float(line['unit_usd']),high=float(line['high_unit_usd']),basis='Carried forward 2026-09-21: '+line['basis'],source=line['source'],note=line['note']))
# The M5 terminations remain internal busbar studs; retain their existing cost.
for r in rows:
    if r['part'].startswith('M5 lug'):r['part']='Internal M5 busbar studs, insulators and fasteners';r['note']='Retained internal terminations, no external lug ports. No removal credit.'
new=[
 ('Power','TRACO THL 40-2411WI',1,50,58.7923,65.55,'Published 100 tier carried to 1,000; lower scenario requires RFQ','https://www.digikey.com/en/products/detail/traco-power/THL-40-2411WI/27381260','Isolated 40 W module. 100-unit listing is not a secured 1,000-unit allocation.'),
 ('Power','XT150 red + black device contacts',2,1,1.5,2.5,'Engineering allowance; exact G2 pair RFQ pending','https://www.china-amass.net/xt150-f-2-product/','Two single-pole device contacts. Cable-side mating pair and external cable excluded.'),
 ('Power','8 AWG internal DC harness, ring lugs and insulation',1,3,4.8,7,'Engineering allowance','','Harness from DC carrier to retained internal busbar studs.'),
 ('Power','Control branch fuse, reverse blocking, OVP, trim and bulk',1,4,6.5,10,'Engineering allowance; detailed circuit pending','','Incremental control-supply branch. Retains old $3 main-bus protection reserve; not counted twice.'),
 ('Power','Internal 5 V fused harness and HAT solder termination',1,1,1.8,3,'Engineering allowance','','Two positive/two return conductors; no external Pi USB-C power inlet.'),
 ('Network','Microchip KSZ9896CTXI',1,11,12.7625,15.89,'Published 100 tier carried to 1,000; lower scenario requires RFQ','https://www.digikey.com/en/products/detail/microchip-technology/KSZ9896CTXI/7164762','Three PHY ports used; exact source part. New board not pin-complete.'),
 ('Network','Gigabit integrated-magnetics RJ45',3,2,3,5,'Engineering allowance; MPN pending','','Three jacks, not three simple unmagnetized sockets. Must match voltage-mode PHY.'),
 ('Network','3.3 V and 1.2 V regulation, inductors and power support',1,1.5,2.5,4,'Engineering allowance; MPNs pending','','Switch rails and sequencing.'),
 ('Network','Boot MCU, reset supervisor, programming interface',1,.7,1.3,2,'Engineering allowance; MPNs pending','','Local boot independent of Pi; firmware and test NRE excluded.'),
 ('Network','25 MHz crystal, decoupling, bias and configuration',1,1.2,1.8,3,'Engineering allowance','','Includes clock/passive completion reserve.'),
 ('Network','Ethernet ESD and shield coupling components',1,1.2,2,3.5,'Engineering allowance','','Twelve differential pairs and shield network; final part selection pending.'),
 ('Network','Neutrik NE8FDP panel feedthrough',2,10,11.02934,17.10,'Published 500 tier carried to 2,000; lower scenario requires RFQ','https://www.digikey.com/en/products/detail/neutrik-americas-inc/NE8FDP/29371355','Exact silver NE8FDP, not NE8FDP-B/TOP. Manufacturer includes mounting screws. Catalog metadata conflicts: manufacturer drawing controls geometry.'),
 ('Network','Internal CAT5e patch leads, including Pi right angle',3,1.3,2,3.5,'Engineering allowance; harness RFQ pending','','Two panel leads and one Pi lead. External network cables excluded.'),
]
for group,part,qty,lo,mid,hi,basis,url,note in new:rows.append(dict(group=group,part=part,qty=qty,low=lo,mid=mid,high=hi,basis=basis,source=url,note=note))
baseline=[sum(r['qty']*r[k] for r in rows[:-len(new)]) for k in ['low','mid','high']]
components=[sum(r['qty']*r[k] for r in rows) for k in ['low','mid','high']]
products=[]
for name,p in old['products'].items():
    lines=[dict(label=x['item'],cost=x['low_mid_high']) for x in p['cost_lines']]
    if name=='MAX':
        lines=[dict(label='Components and internal hardware',cost=components),dict(label='Component overage (3%)',cost=[x*.03 for x in components]),dict(label='Existing PCB/assembly/test',cost=[18.35,27.7,41.9]),dict(label='Power tongue PCB area increment',cost=[.5,1,2]),dict(label='NET3 4-layer 80 x 60 PCB',cost=[1.8,3,4.5]),dict(label='NET3 assembly, boot and link test',cost=[3,5,8]),dict(label='New harness integration and load test',cost=[2,4,7]),dict(label='Shells, tray, carrier, fasteners and assembly',cost=[8,12,17]),dict(label='Tooling amortized over 1,000',cost=[16,28,42]),dict(label='Packaging',cost=[2.5,3.5,5.5])]
    cost=[sum(l['cost'][i] for l in lines) for i in range(3)]
    target=p['target_margin'];exact=cost[1]/(1-target)
    price=math.ceil((exact-9)/10)*10+9 if name=='MAX' else p['launch_price']
    products.append(dict(name=name,lines=lines,cost=cost,price=price,target=target,margin=1-cost[1]/price,exact_target_price=exact,scope='No Raspberry Pi, cooler, storage, external supply or cables' if name=='MAX' else p['scope'],freshness='r11 additions checked 2026-10-08; retained baseline 2026-09-21' if name=='MAX' else 'Carried forward 2026-09-21; not a fresh supplier quote'))
data=dict(date='2026-10-08',currency='USD',quantity=1000,component_reserve=.03,illustrative_fee=.08,products=products,max_bom=rows,max_old_components=baseline,max_components=components,max_component_delta=[components[i]-baseline[i] for i in range(3)],notes=[
 'Three product enclosures; Splanc GNSS is a stuffing option sharing the Splanc renders.',
 'Planning prices, not supplier quotes or confirmed campaign prices. NET3 schematic and supply protection are incomplete.',
 'Central MAX carries applicable published tiers with no invented 1,000-unit discount; low/high scenarios are engineering sensitivities, not confidence intervals.',
 'Mini and Splanc sourcing carried forward. Current mould geometry, two-shot logo, flexures and gasket details need DFM and mould quotations; shell/tool allowances are not quotes.',
 'BOM includes internal ribbon/USB bridge, DC and network harnesses, both panel Ethernet sockets, 20 LED mating plugs and switch electronics. Pi/cooler/storage, external PSU, cable-side XT150 pair and external cables excluded.',
 'Includes 3% component overage, PCB assembly/test, shell, first-batch tooling allocation and packaging. Excludes freight/duty, taxes, fulfillment, channel fees, returns, certification and engineering NRE.',
 'At 1,000 products, quantity is 2,000 panel Ethernet sockets and 3,000 network magnetics jacks; RFQ/allocation required.',
 'Previous MAX $299 price is superseded for this r11 configuration. Existing LED logic regulator, internal USB data bridge and busbars remain, so no removal credit was taken.' ])
(O/'pricing-model.json').write_text(json.dumps(data,indent=2))
with (O/'max-r11-bom.csv').open('w') as f:
    w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
with (O/'launch-prices.csv').open('w') as f:
    w=csv.writer(f);w.writerow(['Product','Planning launch USD','Central first-batch cost USD','Gross margin','Low cost USD','High cost USD','Basis'])
    for p in products:w.writerow([p['name'],p['price'],round(p['cost'][1],2),p['margin'],round(p['cost'][0],2),round(p['cost'][2],2),p['freshness']])
print(json.dumps({p['name']:{k:p[k] for k in ['cost','price','margin']} for p in products},indent=2))
