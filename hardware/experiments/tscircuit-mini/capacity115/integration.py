from pathlib import Path
import json,sys,random,yaml
sys.path.insert(0,str(Path('hardware/pnr').resolve()))
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.capacity_proxy import diverse_options
from pnr.place.batch_relocate import joint_configurations
base=Path('output/fresh-pnr-20260919/overnight113-20260923');seed=base/'relocation/round-01/alternatives/candidate-00'
g=BoardGraph.from_json((seed/'evaluated-placed.json').read_text());rules=json.loads((seed/'evaluated-rules.json').read_text());cc=compile_constraints(yaml.safe_load((base/'constraints.yaml').read_text()),g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
a=json.loads((base/'relocation/round-02/placement-decision.json').read_text());p=next(p for p in a['probes'] if p['ref']=='TP1');original=next(c for c in p['candidates'] if c['position']==[49,27]);options=diverse_options(p['candidates'],original,4,70,55,g,'TP1')
choices,audit=joint_configurations(g,cc,{'TP1':options},rules=rules,samples=2,rng=random.Random(115),proxy_budget=4)
Path('output/capacity115/integration.json').write_text(json.dumps(dict(options=options,audit=audit),indent=2));print('options',options);print('chosen',[(c['moves'],c['cost']) for c in choices])
assert any(o['position']==[17,33] for o in options)
assert choices[0]['moves'][0]['position']==[17,33]
