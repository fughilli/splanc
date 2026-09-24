"""Immutable, hash-bound snapshots of actual routing phases."""
import hashlib
import json
import shutil
from pathlib import Path


def capture(root, name, board, rules, cli, *, metadata=None):
    from pnr.native_drc import run_drc
    root=Path(root);folder=root/name;folder.mkdir(parents=True,exist_ok=False)
    board=Path(board);target=folder/'diagnostic.kicad_pcb'
    shutil.copy2(board,target)
    shutil.copy2(board.with_suffix('.kicad_pro'),target.with_suffix('.kicad_pro'))
    if (board.parent/'fp-lib-table').exists():shutil.copy2(board.parent/'fp-lib-table',folder/'fp-lib-table')
    shutil.copy2(rules,folder/'rules.json')
    report=run_drc(cli,target,folder/'diagnostic.drc.json')
    item=dict(name=name,board=str(target.resolve()),sha256=hashlib.sha256(target.read_bytes()).hexdigest(),opens=len(report['unconnected_items']),violations=len(report['violations']),metadata=metadata or {})
    (folder/'phase.json').write_text(json.dumps(item,indent=2)+'\n')
    from pnr.live import emit
    emit('phase_complete',board=target,data=item)
    return item
