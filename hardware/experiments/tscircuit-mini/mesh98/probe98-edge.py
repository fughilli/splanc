from pathlib import Path
import json,yaml
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.geometry import resolve_fixed_poses,courtyard_rect
from pnr.place.elastic import project_collectively
p=Path('output/fresh-pnr-20260919/fresh-29-round-02');g=BoardGraph.from_json((p/'placed.json').read_text());cc=compile_constraints(yaml.safe_load(Path('hardware/splanc_dev/mini-constraints.yaml').read_text()),g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
f=resolve_fixed_poses(g,cc);f.update({c.ref:tuple(c.pos) for c in g.components if c.locked});o=project_collectively(g,cc,f)
assert courtyard_rect(o.component('Q1')).top<55
moves={c.ref:[g.component(c.ref).pos,c.pos] for c in o.components if c.pos!=g.component(c.ref).pos};print(moves)
out=Path('output/fresh-pnr-20260919/mesh98-edge-diagnostic');out.mkdir();(out/'placed.json').write_text(o.to_json());(out/'moves.json').write_text(json.dumps(moves,indent=2))
import shutil
for n in ['source.kicad_pcb','source.kicad_pro','routes.json','rules.json']:shutil.copyfile(p/n,out/n)
