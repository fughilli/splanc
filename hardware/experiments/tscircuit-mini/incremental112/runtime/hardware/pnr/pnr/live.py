"""Optional process-safe local telemetry. No routing decisions depend on it."""
import hashlib,json,os,shutil,time,uuid
from pathlib import Path

def emit(kind, *, board=None, data=None, layout=None, candidate=None):
    root=os.environ.get('PNR_LIVE_DIR')
    if not root:return
    root=Path(root);(root/'events').mkdir(parents=True,exist_ok=True)
    event=dict(schema='pnr-live-event-v1',id=f'{time.time_ns()}-{uuid.uuid4().hex[:8]}',time=time.time(),kind=kind,candidate=candidate or os.environ.get('PNR_LIVE_CANDIDATE','controller'),iteration=os.environ.get('PNR_LIVE_ITERATION'),data=data or {})
    if layout is not None:event['layout']=layout
    if board and Path(board).exists():
        raw=Path(board).read_bytes();sha=hashlib.sha256(raw).hexdigest();folder=root/'boards';folder.mkdir(exist_ok=True);dest=folder/(sha+'.kicad_pcb')
        if not dest.exists():
            tmp=folder/(event['id']+'.tmp');tmp.write_bytes(raw);tmp.replace(dest)
        event.update(board=str(dest.resolve()),board_sha256=sha,source=str(Path(board).resolve()))
    dest=root/'events'/(event['id']+'.json');tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(event,separators=(',',':'),default=str));tmp.replace(dest)
