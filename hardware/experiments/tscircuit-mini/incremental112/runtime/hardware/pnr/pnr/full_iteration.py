"""Evaluate one placement through every native electrical phase before scoring.

Run with the non-KiCad PnR runtime. Native phases use isolated KiCad subprocesses.
Intermediate signal metrics never become the acceptance or plateau objective.
"""
import argparse,json,os,shutil,subprocess
from pathlib import Path
from pnr.phase_capture import capture


def objective(drc,entries,electrical):
    """Lexicographic guard vector. Missing qualification stays explicit."""
    return [len(drc['violations']),len(entries['blocked']),
            len(electrical.get('reference_failures') or []),
            electrical['subwidth_track_count'],
            sum(not p.get('length_match_qualified',False) for p in electrical['pairs']),
            len(drc['unconnected_items'])]


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('round',type=Path);ap.add_argument('--constraints',required=True,type=Path)
    ap.add_argument('--electrical-fab',default='hardware/splanc_dev/mini-routing-electrical-fab.json')
    ap.add_argument('--plane-fab',default='hardware/splanc_dev/mini-plane-access-fab.json')
    ap.add_argument('--annotation-source',action='append',default=[])
    ap.add_argument('--seconds',type=int,default=600)
    ap.add_argument('--geometric-relax',action='store_true')
    ap.add_argument('--incremental',action='store_true')
    ap.add_argument('--python',default='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3')
    ap.add_argument('--cli',default='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
    a=ap.parse_args();p=a.round.resolve();phases=p/'phases';work=p/'electrical';work.mkdir(exist_ok=False)
    env=dict(os.environ,PYTHONPATH=str(Path(__file__).resolve().parent.parent))
    sources=a.annotation_source or ['hardware/splanc_dev/elec/src/splanc_mini.ato']
    annotations=[v for source in sources for v in ['--annotation-source',str(Path(source).resolve())]]
    rules=p/'rules.json';board=work/'board.kicad_pcb'
    from pnr.live import emit
    def run(args,name):
        emit('phase_start',data=dict(phase=name))
        with (work/(name+'.log')).open('w') as log:
            subprocess.run([a.python,'-m','pnr.profile','--label',name,'--module',*map(str,args)],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    # The production order reserves pair/power corridors before ordinary signals.
    # Rebuild from the candidate placement, not a previously filled signal board.
    if a.incremental:
        capture(phases,'00a-routed-seed',p/'source.kicad_pcb',rules,a.cli)
        run(['pnr.incremental_place',p/'source.kicad_pcb',p/'placed.json','--out',board,'--rules',rules,'--report',work/'invalidation.json'],'incremental-placement')
    else:
        run(['pnr.writeback',p/'source.kicad_pcb',p/'placed.json','--out',board,'--rules',rules],'placement')
    table=p/'fp-lib-table'
    if not table.exists():table=Path('output/fresh-pnr-20260919/source-footprint-probe/fp-lib-table')
    shutil.copy2(table,work/'fp-lib-table')
    capture(phases,'00b-local-invalidation' if a.incremental else '00-placement',board,rules,a.cli,metadata=json.loads((work/'invalidation.json').read_text()) if a.incremental else {})
    if not a.incremental:
        run(['pnr.plane_access',board,'--out',board,'--fab-model',a.plane_fab,'--report',work/'plane-access.json',*annotations],'plane-access')
    run(['pnr.planes',board,'--rules',rules,*(['--refill-only'] if a.incremental else [])],'planes')
    capture(phases,'01-plane-access-fill',board,rules,a.cli)
    from pnr.native_loop import main as native
    final=native([str(board),'--rules',str(rules),'--constraints',str(a.constraints.resolve()),'--out-dir',str(work/'native-loop'),'--kicad-python',a.python,'--kicad-cli',a.cli,'--electrical-fab',a.electrical_fab,'--early-pairs','--route-only','--cycles','12','--route-attempts','40','--placement-attempts','2','--search-seconds','90','--seconds',str(a.seconds),'--phase-dir',str(phases),*annotations])
    rules=work/'native-loop/policy/prepare.json'
    run(['pnr.via_coalesce',final,'--out',board,'--rules',rules,'--report',work/'coalesce.json','--work-dir',work/'coalesce','--kicad-cli',a.cli,*annotations],'coalesce')
    capture(phases,'08-coalescing',board,rules,a.cli)
    if a.geometric_relax:
        run(['pnr.geometry_optimize',board,'--rules',rules,'--out-dir',work/'geometry-relax'],'geometry-relax')
        shutil.copy2(work/'geometry-relax/best.kicad_pcb',board)
        shutil.copy2(work/'geometry-relax/best.kicad_pro',board.with_suffix('.kicad_pro'))
        capture(phases,'08b-geometry-relax',board,rules,a.cli)
    # Diagnostic mode records blocked entries rather than aborting before final
    # audits. A blocked entry remains a failed guard in the acceptance vector.
    run(['pnr.pad_entry',board,'--out',board,'--rules',rules,'--report',work/'pad-entry.json'],'pad-entry')
    run(['pnr.planes',board,'--rules',rules,'--refill-only'],'refill')
    run(['pnr.electrical_audit',board,'--rules',rules,'--out',work/'audit.json'],'audit')
    if a.incremental:
        run(['pnr.native_loop',p/'source.kicad_pcb','--worker','inspect','--rules',rules,'--report',work/'seed-inventory.json',*annotations],'seed-inventory')
        run(['pnr.native_loop',board,'--worker','check','--rules',rules,'--spec',work/'seed-inventory.json','--report',work/'incremental-check.json'],'incremental-check')
    last=capture(phases,'09-final-audit',board,rules,a.cli)
    run(['pnr.native_loop',board,'--worker','inspect','--rules',rules,'--report',work/'feedback.json',*annotations],'feedback')
    entries=json.loads((work/'pad-entry.json').read_text());audit=json.loads((work/'audit.json').read_text());drc=json.loads((phases/'09-final-audit/diagnostic.drc.json').read_text())
    inventory=json.loads((work/'feedback.json').read_text())
    from pnr.feedback_boundary import placement_graph
    restored=placement_graph(inventory,json.loads((p/'placed.json').read_text()),json.loads(rules.read_text()))
    (p/'evaluated-placed.json').write_text(json.dumps(restored))
    (p/'evaluated-routes.json').write_text(json.dumps(inventory['routing_geometry']))
    shutil.copy2(rules,p/'evaluated-rules.json')
    feedback=dict(scope='all electrical modes after final refill',targets=inventory['targets'],native_opens=last['opens'],component_scores={})
    for target in inventory['targets']:
        for endpoint in ('source','target'):
            ref=target[endpoint].rsplit('.',1)[0];feedback['component_scores'][ref]=feedback['component_scores'].get(ref,0)+1
    native_progress=json.loads((work/'native-loop/progress.json').read_text())
    feedback['routing_failure_scores']=native_progress.get('component_scores',{})
    for ref,score in feedback['routing_failure_scores'].items():
        if isinstance(score,(int,float)):feedback['component_scores'][ref]=feedback['component_scores'].get(ref,0)+score
    (p/'feedback.json').write_text(json.dumps(feedback,indent=2))
    result=dict(all_phases_completed=True,score_scope='post-electrical-final-refill',objective=objective(drc,entries,audit),qualified=audit['qualified'],electrical_audit=audit,pad_entry=entries,final=last,feedback=str((p/'feedback.json').resolve()))
    if a.incremental:
        checks=json.loads((work/'incremental-check.json').read_text());result['incremental_checks']=checks
        result['guard_valid']=checks['preserved'] and not checks['lost_pad_entries'] and not checks['reference_failures'] and not checks.get('new_bad_entries')
    (p/'evaluation.json').write_text(json.dumps(result,indent=2)+'\n')
    emit('candidate_complete',board=board,data=result)
    print(json.dumps(dict(objective=result['objective'],qualified=result['qualified'])))

if __name__=='__main__':main()
