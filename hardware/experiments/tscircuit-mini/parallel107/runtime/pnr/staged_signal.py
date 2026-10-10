"""Ordinary routing after native paired placement, retaining exact fixed copper."""
import json,os,subprocess,time
from pathlib import Path


def run(board,rules,constraints,out,kicad_python,kicad_cli,iterations=12):
    import yaml
    from pnr.constraints import compile_constraints
    from pnr.graph import BoardGraph
    from pnr.route.detail.router import route_board
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    rules=Path(rules).resolve();board=Path(board).resolve()
    env=dict(os.environ,PYTHONPATH=str(Path(__file__).resolve().parent.parent))
    def invoke(args,name):
        with (out/name).open('w') as f:subprocess.run(args,env=env,stdout=f,stderr=subprocess.STDOUT,check=True)
    invoke([kicad_python,'-m','pnr.fixed_copper',str(board),'--export-dir',str(out)],'export.log')
    g=BoardGraph.from_json((out/'placed.json').read_text());policy=json.loads(rules.read_text())
    cc=compile_constraints(yaml.safe_load(Path(constraints).read_text()),g.refs,{c.address:c.ref for c in g.components},{f'{c.address}:{p.name}':p.net for c in g.components for p in c.pads})
    g.components=[c for c in g.components if c.ref not in {h['name'] for h in cc.mounting_holes}]
    from pnr.live import emit
    emit('signal_start',board=board,layout=json.loads(g.to_json()),data=dict(phase='signals',provisional=True))
    started=time.monotonic();result=route_board(g,cc,policy,max_iters=iterations,fixed_copper=json.loads((out/'fixed.json').read_text()))
    routes=out/'routes.json';routes.write_text(json.dumps(dict(tracks=result.tracks,vias=result.vias,unrouted=result.result.unrouted)))
    (out/'result.json').write_text(json.dumps(dict(seconds=time.monotonic()-started,unfinished_signal=sorted(set(result.result.unrouted)-result.deferred_nets),deferred=sorted(result.deferred_nets),failure_sites=result.failure_sites),indent=2))
    final=out/'candidate.kicad_pcb'
    invoke([kicad_python,'-m','pnr.fixed_copper',str(board),'--fixed',str(out/'fixed.json'),'--routes',str(routes),'--rules',str(rules),'--out',str(final)],'append.log')
    invoke([kicad_python,'-m','pnr.planes',str(final),'--rules',str(rules),'--refill-only'],'refill.log')
    from pnr.native_drc import run_drc
    run_drc(kicad_cli,board,out/'baseline.drc.json',env=env)
    run_drc(kicad_cli,final,out/'candidate.drc.json',env=env)
    cmd=[kicad_python,'-m','pnr.fixed_copper',str(board),'--validate',str(final),'--rules',str(rules),'--before-drc',str(out/'baseline.drc.json'),'--after-drc',str(out/'candidate.drc.json'),'--out',str(out/'checks.json')]
    references=board.parent/'paired-reference.json'
    if references.exists():cmd+=['--references',str(references)]
    invoke(cmd,'validate.log')
    return final
