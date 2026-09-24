"""Supervise a fresh Bazel Mini build without mutating its inputs or checkpoints."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, sys, time, traceback

ap = argparse.ArgumentParser()
ap.add_argument('root', type=Path)
a = ap.parse_args()
root = a.root.resolve()
cfg = json.loads((root / 'command.json').read_text())
repo = Path(cfg['cwd'])
sys.path.insert(0, str(root / 'source-freeze/hardware/pnr'))
from pnr.live import emit
os.environ.update(cfg['env'])

def save(name, data):
    tmp = root / (name + '.tmp')
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(root / name)

def verify():
    expected = json.loads((root / 'source-freeze/hashes.json').read_text())
    changed = {}
    for label, base in [('live_source', repo), ('frozen_source', root / 'source-freeze')]:
        changed[label] = [n for n, h in expected.items()
                         if not (base/n).is_file() or hashlib.sha256((base/n).read_bytes()).hexdigest() != h]
    return changed

code = None
try:
    before = verify()
    save('pre-launch-verification.json', before)
    if any(before.values()):
        raise RuntimeError('Source changed after freeze; refusing build')
    preflight = json.loads((root/'native-preflight/summary.json').read_text())
    if not preflight.get('passed') or not preflight.get('complete'):
        raise RuntimeError('Native placement preflight did not pass')
    output_path = subprocess.check_output(cfg['bazel_prefix'] + ['info', 'output_path'], cwd=repo, text=True).strip()
    output = Path(output_path) / 'darwin_arm64-fastbuild/bin/hardware/splanc_dev'
    save('build-paths.json', dict(output=str(output), diagnostics=str(output/'splanc_mini.fab.board.diagnostics')))
    emit('candidate_start', candidate='fresh119/source', data=dict(phase='atopile source compilation', starts=8, finalists=3))
    with (root/'build.log').open('w') as log:
        p = subprocess.Popen(cfg['command'], cwd=repo, env=dict(os.environ), stdout=log, stderr=subprocess.STDOUT)
        identity = subprocess.check_output(['ps','-p',str(p.pid),'-o','pid=,lstart=,command='], text=True).strip()
        save('controller-process.json', dict(pid=p.pid, supervisor=os.getpid(), identity=identity, started=time.time(), command=cfg['command']))
        hold = subprocess.Popen(['caffeinate','-i','-w',str(p.pid)])
        code = p.wait()
        hold.wait()
    save('process-exit.json', dict(exit_code=code, finished=time.time()))
    archived = root/'build-artifacts'
    archived.mkdir()
    for src in output.glob('splanc_mini.fab.board*'):
        dest = archived/src.name
        if src.is_dir():
            shutil.copytree(src,dest,symlinks=False)
        elif src.is_file():
            shutil.copy2(src,dest)
    native_progress = archived/'splanc_mini.fab.board.diagnostics/native-loop/progress.json'
    native = json.loads(native_progress.read_text()) if native_progress.exists() else None
    reason = 'build_gates_passed' if code == 0 else 'build_failed_or_gate_rejected'
    record = dict(reason=reason, plateau_observed=False, exit_code=code, finished=time.time(),
                  native_termination=native.get('termination') if native else None,
                  native_opens=native.get('opens') if native else None,
                  scope='Fresh source build; source/native finite budgets are not full-electrical placement plateau',
                  artifacts=str(archived))
    save('termination.json',record)
    emit('run_complete',candidate='fresh119/source',data=record)
except BaseException as ex:
    save('process-exit.json',dict(exit_code=code,supervisor_error=repr(ex),finished=time.time()))
    save('termination.json',dict(reason='supervisor_failure',plateau_observed=False,error=repr(ex),traceback=traceback.format_exc()))
    emit('candidate_failed',candidate='fresh119/source',data=dict(error=repr(ex)))
    raise
finally:
    save('source-verification.json',verify())
