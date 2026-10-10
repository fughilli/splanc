#!/usr/bin/env python3
"""Export comparable cycle heatmaps, with explicit historical-proxy provenance.

Run under the PnR Python runtime. A saved exact congestion.json takes precedence.
Historical runs lack failure_sites: do not reconstruct or label a proxy as measured.
"""
import argparse
import json
from pathlib import Path
from pnr.graph import BoardGraph
from pnr.congestion_diagnostics import snapshot, write_snapshot, native_endpoints


def export(root, out):
    root,out=Path(root),Path(out);out.mkdir(parents=True,exist_ok=True)
    rules=json.loads((root/'rules.json').read_text());records=[];previous=None
    def emit(graph, rules, folder, label, unresolved, metadata, exact=None, inventory=None):
        nonlocal previous
        poses={c.ref:list(c.pos) for c in graph.components}
        metadata['moved_since_previous_snapshot']={} if previous is None else {r:dict(before=previous[r],after=p) for r,p in poses.items() if r in previous and p!=previous[r]}
        previous=poses
        data=json.loads(exact.read_text()) if exact and exact.exists() else snapshot(graph,rules,label=label,unresolved=unresolved,metadata=metadata)
        data['metadata'].update(metadata)
        if inventory is not None:native_endpoints(data,inventory)
        write_snapshot(out/folder,data)
        records.append(dict(folder=folder,label=label,score=data['channels']['shortage_score'],**metadata))
    for folder in sorted(root.glob('round-*')):
        g=BoardGraph.from_json((folder/'placed.json').read_text());routes=json.loads((folder/'routes.json').read_text());result=json.loads((folder/'result.json').read_text())
        emit(g,rules,folder.name,'Source P/R '+folder.name,routes['unrouted'],dict(**result,
             summary=f"missing signals {result['estimated_missing_connections']}; damping {result['inflation_damping']}"),folder/'congestion.json')
    native=root/'native-loop';p=json.loads((native/'progress.json').read_text());policy=json.loads((native/'policy/prepare.json').read_text());previous=None
    for entry in p['rounds']:
        cycle=entry['cycle'];folder=native/f'cycle-{cycle:02d}'
        start=json.loads((folder/'reference.json').read_text())
        # Next cycle's reference is exactly the committed end state. Last uses final inspection
        # if recorded; otherwise use after-route and explicitly mark missing end state.
        next_ref=native/f'cycle-{cycle+1:02d}/reference.json'
        end_path=folder/'end-inventory/inspect.json'
        if not end_path.exists():end_path=next_ref if next_ref.exists() else folder/'after-route/inspect.json'
        for state,inv in [('before',start),('after',json.loads(end_path.read_text()))]:
            exact=folder/f'congestion-{state}/congestion.json'
            emit(BoardGraph.from_json(json.dumps(inv['graph'])),policy,f'native-{cycle:02d}-{state}',f'Native P/R cycle {cycle}: {state}',{t['net'] for t in inv['targets']},dict(**entry,summary=f"opens {entry.get(state,'pending')}; retained moves {entry['placement_accepted']}",inventory_source=str(folder/'reference.json' if state=='before' else end_path)),exact,inv)
    (out/'index.json').write_text(json.dumps(records,indent=2)+'\n')
    body=''.join(f'<h2>{r["label"]}</h2><img style="width:100%;max-width:1100px" src="{r["folder"]}/congestion.svg">' for r in records)
    (out/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>PnR congestion by cycle</title><h1>PnR congestion by cycle</h1><p>Historical unresolved-net density is a proxy, not saved router feedback. Identical scales across cycles. See JSON for moves and scores.</p>'+body)
    print(json.dumps(records,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('diagnostics');p.add_argument('--out',required=True);a=p.parse_args();export(a.diagnostics,a.out)
