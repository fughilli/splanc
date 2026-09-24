from pathlib import Path
import json,sys
sys.path.insert(0,str(Path('hardware/pnr').resolve()))
from pnr.graph import BoardGraph
from pnr.place.capacity_proxy import score,rank_candidates,cheap_score
from pnr.constraints import compile_constraints
from pnr.place.metrics import hard_violations
import yaml
base=Path('output/fresh-pnr-20260919/overnight113-20260923');seed=base/'relocation/round-01/alternatives/candidate-00';raw=(seed/'evaluated-placed.json').read_text();rules=json.loads((seed/'evaluated-rules.json').read_text())
results=[]
for pitch in [1.5,2.5,3.]:
 for name,xy in [('incumbent',(49,27)),('under-radio',(17.25,34))]:
  g=BoardGraph.from_json(raw);g.component('TP1').pos=xy;r=score(g,rules,pitch=pitch,passes=3)
  item=dict(name=name,pitch=pitch,**{k:v for k,v in r.items() if k not in ['heatmap','rounds']});results.append(item)
  print(name,pitch,{k:r[k] for k in ['score','unreachable_branches','overflow_units','seconds']},flush=True)
Path('output/capacity115/sensitivity.json').write_text(json.dumps(results,indent=2))
g=BoardGraph.from_json(raw);cc=compile_constraints(yaml.safe_load((base/'constraints.yaml').read_text()),g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
a=json.loads((base/'relocation/round-02/placement-decision.json').read_text());probe=next(p for p in a['probes'] if p['ref']=='TP1');candidates=[]
for option in probe['candidates']:
 graph=BoardGraph.from_json(raw);graph.component('TP1').pos=tuple(option['position'])
 if any(hard_violations(graph,cc).values()):continue
 candidates.append(dict(graph=graph,cost=option['cost'],moves=[dict(ref='TP1',position=option['position'])]))
ranked,audit=rank_candidates(candidates,rules,budget=12)
Path('output/capacity115/hierarchical-replay.json').write_text(json.dumps(audit,indent=2))
print('HIERARCHY',[(r['moves'][0]['position'],round(r['cost'],2)) for r in ranked],flush=True)
