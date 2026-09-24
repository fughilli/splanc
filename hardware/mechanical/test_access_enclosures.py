"""STEP round-trip and real connector interference checks for access revision."""
import json,argparse
from pathlib import Path
import cadquery as cq
parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path('output/product-renders-access'));R=parser.parse_args().root;result={}
jst=cq.importers.importStep('hardware/splanc_dev/elec/src/parts/JST_B3B_PH_K_S_LF__SN/CONN-TH_B3B-PH-K-S.step')
header=cq.importers.importStep('hardware/mechanical/assets/max-connectors/degson-2edgrc-3-header-normalized.step')
for product in ('mini','splanc','max'):
 for suffix in ('','-weather'):
  folder=R/(product+suffix)
  if not folder.exists():continue
  shapes={n:cq.importers.importStep(str(folder/(n+'.step'))) for n in ('base','lid')}
  r={'solids':{n:len(q.val().Solids()) for n,q in shapes.items()},'valid':all(q.val().isValid() for q in shapes.values()),'overlap_mm3':shapes['base'].intersect(shapes['lid']).val().Volume()}
  assert r['valid'] and all(v==1 for v in r['solids'].values()) and r['overlap_mm3']<.01,(product,suffix,r)
  result[product+suffix]=r
 if product=='mini':models=[jst.rotate((0,0,0),(0,0,1),90).translate((64,y,7.4)) for y in (20,31)]
 elif product=='splanc':models=[jst.translate((x,12,7.4)) for x in (50,70)]
 else:
  cs=json.loads(Path('hardware/splanc_max/design.json').read_text())['boards']['power']['components'];models=[header.rotate((0,0,0),(0,0,1),c['rotation']).translate((7+c['position'][0],7+c['position'][1],9.6)) for c in cs if c['part']=='OUT']
 # Use standard shells for connector interference; weather collars are provisional.
 base=cq.importers.importStep(str(R/product/'base.step'));lid=cq.importers.importStep(str(R/product/'lid.step'))
 overlaps=[sum(q.intersect(m).val().Volume() for q in (base,lid)) for m in models]
 result[product]['connector_overlap_mm3']=overlaps
 assert max(overlaps,default=0)<.05,(product,overlaps)
(R/'access-validation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
