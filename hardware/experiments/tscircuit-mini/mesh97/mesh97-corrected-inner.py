from pathlib import Path
import sys,json,yaml,time
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
from pnr.route.detail.router import route_board
from pnr.route.feedback import detail_congestion
from pnr.congestion_diagnostics import snapshot,write_snapshot
p=Path('output/fresh-pnr-20260919/mesh97-comparison')/sys.argv[1];g=BoardGraph.from_json((p/'placed.json').read_text());rules=json.loads(Path('output/fresh-pnr-20260919/fresh-28-diagnostics/rules.json').read_text());cc=compile_constraints(yaml.safe_load(Path('hardware/splanc_dev/mini-constraints.yaml').read_text()),g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{a.name}':a.net for c in g.components for a in c.pads});t=time.monotonic();print('routing',p,flush=True)
b=route_board(g,cc,rules,max_iters=12);missing=sum(max(1,b.result.nets[n].remaining_connections) for n in set(b.result.unrouted)-b.deferred_nets)
(p/'result.json').write_text(json.dumps(dict(estimated_missing_connections=missing,elapsed_seconds=time.monotonic()-t),indent=2));(p/'routes.json').write_text(json.dumps(dict(tracks=b.tracks,vias=b.vias,unrouted=b.result.unrouted,deferred=sorted(b.deferred_nets))))
write_snapshot(p,snapshot(g,rules,label=sys.argv[1],cell=detail_congestion(b,g,70,55,2.5)));print('result',missing,flush=True)
