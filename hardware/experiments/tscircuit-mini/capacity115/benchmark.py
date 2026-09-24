"""Fixed-workload proxy calibration; reads saved boards, never routes/edits them."""
from pathlib import Path
import json,sys,hashlib
sys.path.insert(0,str(Path('hardware/pnr').resolve()))
from pnr.graph import BoardGraph
from pnr.place.capacity_proxy import score
base=Path('output/fresh-pnr-20260919/overnight113-20260923/relocation/round-01/alternatives/candidate-00')
graw=(base/'evaluated-placed.json').read_text();rules=json.loads((base/'evaluated-rules.json').read_text())
out=Path('output/capacity115');out.mkdir(exist_ok=True)
positions={'incumbent':(49,27),'legacy-best':(51,27),'under-radio':(17.25,34),'under-radio-grid':(17,33),'left-lower':(13,19),'lower-middle':(35,11),'upper-right':(55,43)}
results=[]
for name,xy in positions.items():
 g=BoardGraph.from_json(graw);g.component('TP1').pos=xy
 r=score(g,rules,passes=3);r.update(name=name,position=xy)
 (out/(name+'.json')).write_text(json.dumps(r,indent=2));results.append({k:v for k,v in r.items() if k not in ['heatmap','rounds']})
 print(name,{k:r[k] for k in ['score','unreachable_branches','overflow_units','saturation','seconds']},flush=True)
 (out/'summary.json').write_text(json.dumps(dict(results=results,graph_sha256=hashlib.sha256(graw.encode()).hexdigest(),rules_sha256=hashlib.sha256((base/'evaluated-rules.json').read_bytes()).hexdigest()),indent=2))
