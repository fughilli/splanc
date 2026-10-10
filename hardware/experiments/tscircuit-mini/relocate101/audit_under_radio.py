from pathlib import Path
import json,yaml,math
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.place.metrics import translation_checker
from pnr.place.geometry import pin_positions
from pnr.place.relocate import _fields,_near
root=Path('output/fresh-pnr-20260919/relocate101');p=root/'relocation/round-01'
g=BoardGraph.from_json((p/'placed.json').read_text());raw=yaml.safe_load((root/'constraints.yaml').read_text());cc=compile_constraints(raw,g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads});rules=json.loads((p/'rules.json').read_text());routes=json.loads((p/'routes.json').read_text());comp=next(c for c in g.components if c.address=='board.eol');original=comp.pos;legal=translation_checker(g,cc);fields=_fields(g,comp,rules,routes['tracks'],routes['vias'],.8)
records=[]
for pos in [(45,13.5),(49,27),(17,33),(17,35),(23,33),(11,33),(17,40)]:
 comp.pos=pos;ok=legal(comp);comp.pos=original
 cost=0.;light=0.
 for pad,(_,xy) in zip(comp.pads,pin_positions(comp)):
  point=(xy[0]+pos[0]-original[0],xy[1]+pos[1]-original[1])
  peers=[q for c in g.components if c.ref!=comp.ref for other,(_,q) in zip(c.pads,pin_positions(c)) if other.net==pad.net]
  if peers:light+=min(abs(point[0]-q[0])+abs(point[1]-q[1]) for q in peers)
  if pad.net not in fields:continue
  grid,blocked,dist=fields[pad.net];side=0 if comp.side=='top' else len(grid.layers)-1
  value=min([float(dist[la,j,i])+d for d,la,j,i in _near(grid,blocked,point,side)],default=float('inf'))
  cost+=value if math.isfinite(value) else 10000
 records.append(dict(position=pos,legal=ok,cost=cost+.1*light))
(root/'under-radio-audit.json').write_text(json.dumps(records,indent=2));print(json.dumps(records,indent=2))
