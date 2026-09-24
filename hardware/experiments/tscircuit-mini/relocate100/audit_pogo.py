"""Audit every legal 2 mm pogo candidate, beyond the normal light shortlist."""
from pathlib import Path
import json,yaml
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.relocate import propose
root=Path('output/fresh-pnr-20260919/relocate100');p=root/'relocation/round-01'
g=BoardGraph.from_json((p/'placed.json').read_text());raw=yaml.safe_load((root/'constraints.yaml').read_text());cc=compile_constraints(raw,g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads});rules=json.loads((p/'rules.json').read_text());routes=json.loads((p/'routes.json').read_text())
a=propose(g,cc,rules,routes['tracks'],routes['vias'],refs=[c.ref for c in g.components if c.address=='board.eol'],max_parts=1,shortlist=10000)
(root/'pogo-exhaustive-audit.json').write_text(json.dumps(a[2] if a else {},indent=2))
print(json.dumps(a[2]['candidates'],indent=2))
