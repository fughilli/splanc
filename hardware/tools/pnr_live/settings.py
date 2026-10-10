"""Persistent preferences and explicitly requested per-run restarts."""
import json,time,uuid
from pathlib import Path
from pnr.runtime_controls import validate,DEFAULTS

def atomic(path,record):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 tmp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp');tmp.write_text(json.dumps(record,indent=2));tmp.replace(path)
def seed(run_file,preferences):
 run_file=Path(run_file);preferences=Path(preferences)
 if run_file.exists():
  record=json.loads(run_file.read_text());validate(record['values'])
  if not preferences.exists():atomic(preferences,dict(values=record['values'],saved_at=time.time()))
  return record
 values=json.loads(preferences.read_text())['values'] if preferences.exists() else dict(DEFAULTS)
 record=dict(revision=1,values=validate(values),requested_at=time.time(),restart_epoch=0,apply_mode='boundary');atomic(run_file,record);return record

def save(run_file,preferences,values,expected,mode):
 if mode not in ('boundary','restart_round'):raise ValueError('Choose boundary or restart_round')
 old=seed(run_file,preferences)
 if expected!=old['revision']:raise ValueError('Controls changed; refresh and retry')
 record=dict(revision=old['revision']+1,values=validate(values),requested_at=time.time(),apply_mode=mode,restart_epoch=old.get('restart_epoch',0)+(mode=='restart_round'))
 # Save durable preferences before acknowledging the per-run request.
 atomic(preferences,dict(values=record['values'],saved_at=record['requested_at']))
 atomic(run_file,record);return record
