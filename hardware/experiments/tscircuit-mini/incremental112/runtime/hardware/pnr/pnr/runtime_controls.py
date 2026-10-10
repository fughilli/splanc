"""Validated, atomic live experiment controls; geometry rules are never editable."""
import json,os,time
from pathlib import Path
DEFAULTS=dict(route_workers=2,candidate_workers=2,samples=4,k=4,n=4)
LIMITS=dict(route_workers=(1,8),candidate_workers=(1,4),samples=(1,16),k=(2,12),n=(2,8))
def validate(values):
    if set(values)!=set(DEFAULTS):raise ValueError('Expected controls: '+', '.join(DEFAULTS))
    for key,(low,high) in LIMITS.items():
        if type(values[key]) is not int or not low<=values[key]<=high:raise ValueError(f'{key} must be an integer from {low} to {high}')
    if values['route_workers']*values['candidate_workers']>16:raise ValueError('Maximum16 combined route workers')
    return dict(values)
def read(path=None):
    path=path or os.environ.get('PNR_CONTROL_FILE')
    if not path or not Path(path).exists():return dict(revision=0,values=dict(DEFAULTS))
    record=json.loads(Path(path).read_text());validate(record['values']);return record

def write(path,values,expected=None):
    old=read(path)
    if expected is not None and expected!=old['revision']:raise ValueError('Controls changed; refresh and retry')
    record=dict(revision=old['revision']+1,values=validate(values),requested_at=time.time())
    p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);temp=p.with_suffix('.tmp');temp.write_text(json.dumps(record,indent=2));temp.replace(p);return record
_last=None
def route_workers(boundary):
    global _last
    record=read();requested=record['values']['route_workers'] if os.environ.get('PNR_CONTROL_FILE') else int(os.environ.get('PNR_SINGLE_TRACK_WORKERS','1'))
    active_candidates=max(1,int(os.environ.get('PNR_CANDIDATE_WORKERS','1')))
    workers=max(1,min(8,requested,16//active_candidates))
    identity=(record['revision'],workers,boundary)
    if identity!=_last:
        from pnr.live import emit
        emit('worker_config_applied',data=dict(native_batch_modes=['signal','power','plane'],route_workers=workers,requested_revision=record['revision'],boundary=boundary,candidate_workers_at_round_start=active_candidates))
        _last=identity
    return workers
