"""Observe a fresh build; export native diagnostics/PDFs without editing build outputs."""
from pathlib import Path
import argparse,hashlib,json,os,shutil,subprocess,sys,time,traceback
ap=argparse.ArgumentParser();ap.add_argument('root',type=Path);a=ap.parse_args();root=a.root.resolve()
repo=Path(json.loads((root/'command.json').read_text())['cwd'])
freeze=root/'source-freeze';sys.path.insert(0,str(freeze/'hardware/pnr'))
os.environ['PNR_LIVE_DIR']=str(root/'live');os.environ['PNR_LIVE_CANDIDATE']='fresh119/source'
from pnr.live import emit
ki='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3'
cli='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
doc='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
pop='/Users/kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/bin/pdftoppm'
env=dict(os.environ,PYTHONPATH=str(freeze/'hardware/pnr'));env.pop('PNR_PROFILE_DIR',None)
review=root/'reviews';review.mkdir(exist_ok=True)
pdf=repo/'output/pdf/mini-fresh119-20260924';pdf.mkdir(exist_ok=True)
seen=set();failed=set();queued=set()
anno=freeze/'hardware/splanc_dev/elec/src/splanc_mini.ato'
fab=freeze/'hardware/splanc_dev/mini-plane-access-fab.json'
footprints=sorted((freeze/'hardware/splanc_dev/elec/src/parts').rglob('*.kicad_mod'))

def call(command,folder,name):
    with (folder/(name+'.log')).open('w') as log:
        subprocess.run(list(map(str,command)),env=env,cwd=repo,stdout=log,stderr=subprocess.STDOUT,check=True)

def rules_for(diag):
    dest=review/'source-rules.json'
    if dest.exists():return dest
    import yaml
    from pnr.graph import BoardGraph
    from pnr.constraints import compile_constraints,compile_routing_rules
    from pnr.electrical import annotations,resolve_currents,compile_policy,resolve_pair_chains
    from pnr.plane_intent import read_annotations,resolve
    g=BoardGraph.from_json((diag/'graph.json').read_text())
    cc=compile_constraints(yaml.safe_load((freeze/'hardware/splanc_dev/mini-constraints.yaml').read_text()),g.refs,{c.address:c.ref for c in g.components if c.address},{f'{c.address}:{p.name}':p.net for c in g.components if c.address for p in c.pads if p.name})
    rules=compile_routing_rules(cc,[n.name for n in g.nets])
    rules=compile_policy(rules,resolve_currents(annotations([anno]),g.components),json.loads((freeze/'hardware/splanc_dev/mini-routing-electrical-fab.json').read_text()))
    rules=resolve_pair_chains(rules,[anno],g.components)
    rules['plane_access_intents']=resolve(read_annotations([anno]),g.components)
    rules['plane_access_fab']=json.loads(fab.read_text())
    dest.write_text(json.dumps(rules,indent=2));return dest

def export(key,board,folder,scope):
    report=folder/'diagnostic.drc.json'
    call([cli,'pcb','drc',board,'--format','json','--output',report],folder,'drc')
    d=json.loads(report.read_text());counts=dict(opens=len(d['unconnected_items']),violations=len(d['violations']))
    sha=hashlib.sha256(board.read_bytes()).hexdigest()
    info=dict(name=key,scope=scope,sha256=sha,board=str(board),**counts,review_status='pending')
    (folder/'checkpoint.json').write_text(json.dumps(info,indent=2))
    emit('phase_complete',candidate='fresh119/'+key,board=board,data=info)
    call([doc,repo/'hardware/tools/export_mini_review.py',board,'--out-dir',pdf/key,'--pdftoppm',pop],folder,'pdf')
    call([ki,repo/'hardware/tools/scan_via_proximity.py',board,'--radius-mm','5','--out-dir',folder/'via-scan'],folder,'vias')
    call([doc,repo/'hardware/tools/review_mini_contacts.py',pdf/key,'layers'],folder,'layer-contacts')
    call([doc,repo/'hardware/tools/review_mini_contacts.py',folder/'via-scan','vias'],folder,'via-contacts')
    print('EXPORTED',key,counts,'image review pending',flush=True)

try:
    while True:
        paths=root/'build-paths.json'
        if not paths.exists():time.sleep(2);continue
        diag=Path(json.loads(paths.read_text())['diagnostics'])
        for placed in sorted(diag.glob('initial-pool/start-*/placed.json')):
            key=placed.parent.name
            if key in queued:continue
            try:layout=json.loads(placed.read_text())
            except (ValueError,OSError):continue
            emit('candidate_queued',candidate='fresh119/source/initial-'+key,layout=layout,data=dict(phase='legal initial placement; awaiting screening',provisional=True))
            queued.add(key)
        tasks=[]
        for result in sorted(diag.glob('initial-pool/start-*/routing-result.json')):
            tasks.append(('initial-'+result.parent.name,'grid',result.parent))
        for result in sorted(diag.glob('round-*/result.json')):
            tasks.append(('source-'+result.parent.name,'grid',result.parent))
        native=diag/'native-loop'
        for name in ['early-pairs','early-power','early-plane','early-power-refine','staged-signal']:
            stage=native/name
            ready=stage/('result.json' if name in ('early-pairs','staged-signal') else 'progress.json')
            if not ready.exists():continue
            try:data=json.loads(ready.read_text())
            except ValueError:continue
            if name not in ('early-pairs','staged-signal') and data.get('termination')=='running':continue
            b=stage/'candidate.kicad_pcb' if name in ('early-pairs','staged-signal') else stage/'best/candidate.kicad_pcb'
            if b.exists():tasks.append(('phase-'+name,'native',b))
        finished=(root/'termination.json').exists()
        if finished:
            final=root/'build-artifacts/splanc_mini.fab.board.kicad_pcb'
            if final.exists():tasks.append(('final-experimental','native',final))
        for key,kind,source in tasks:
            if key in seen or key in failed:continue
            folder=review/key;folder.mkdir(exist_ok=False)
            try:
                board=folder/'diagnostic.kicad_pcb'
                if kind=='grid':
                    rules=rules_for(diag)
                    call([ki,'-m','pnr.writeback',diag/'source.kicad_pcb',source/'placed.json','--rules',rules,'--routes',source/'routes.json','--out',board],folder,'writeback')
                    call([ki,'-m','pnr.plane_access',board,'--out',board,'--fab-model',fab,'--report',folder/'plane-access.json','--annotation-source',anno],folder,'arrays')
                    call([ki,'-m','pnr.planes',board,'--rules',rules],folder,'planes')
                    scope='Provisional signal-stage diagnostic plus source arrays/plane fanout; full electrical routing incomplete'
                else:
                    for ext in ['.kicad_pcb','.kicad_pro']:shutil.copy2(source.with_suffix(ext),board.with_suffix(ext))
                    scope='Actual saved native phase; experimental, not promoted'
                call([ki,'-m','pnr.library_table','--out',folder/'fp-lib-table',*footprints],folder,'libraries')
                export(key,board,folder,scope);seen.add(key)
            except Exception as ex:
                failed.add(key);(folder/'export-error.json').write_text(json.dumps(dict(error=repr(ex),traceback=traceback.format_exc()),indent=2));print('EXPORT FAILED',key,repr(ex),flush=True)
        (root/'review-status.json').write_text(json.dumps(dict(exported=sorted(seen),failed=sorted(failed),visual_review='pending until actual images inspected'),indent=2))
        if finished:break
        time.sleep(3)
finally:
    (root/'watcher-exit.json').write_text(json.dumps(dict(time=time.time(),exported=sorted(seen),failed=sorted(failed)),indent=2))
