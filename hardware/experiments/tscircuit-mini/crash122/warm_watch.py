"""Start one bounded private warm host when the native baseline is ready.

Cold fallback remains available before readiness, on policy changes/findings,
and after the host's64-request budget. No shared KiCad preferences are changed.
"""
import json,os,signal,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root/'source-freeze/hardware/pnr'))
from pnr.live import emit
os.environ['PNR_LIVE_DIR']=str(root/'live')
service=root/'drc-service'
try:
    while not (root/'process-exit.json').exists():
        paths=root/'build-paths.json'
        if paths.exists():
            diag=Path(json.loads(paths.read_text())['diagnostics'])
            board=diag/'native-loop/baseline.kicad_pcb'
            if board.exists() and board.with_suffix('.kicad_pro').exists() and (board.parent/'fp-lib-table').exists():
                command=[sys.executable,str(root/'source-freeze/hardware/pnr/pnr/drc_warm/launch_host.py'),str(service),'--board',str(board)]
                with (root/'warm-launch.log').open('w') as log:
                    result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=35)
                status={'started':time.time(),'exit_code':result.returncode,'ready':(service/'ready.json').exists(),'snapshot_budget':64,'after_budget':'cold CLI fallback'}
                (root/'warm-status.json').write_text(json.dumps(status,indent=2))
                emit('warm_drc_status',candidate='validation',data=status)
                break
        time.sleep(2)
    while not (root/'process-exit.json').exists():time.sleep(3)
finally:
    record=service/'process.json'
    if record.exists():
        data=json.loads(record.read_text());pid=data['pid']
        current=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True)
        if current.returncode==0 and current.stdout.strip()==' '.join(data['command']):
            os.kill(pid,signal.SIGTERM)
            (service/'session-closed.json').write_text(json.dumps(dict(pid=pid,closed=time.time())))
