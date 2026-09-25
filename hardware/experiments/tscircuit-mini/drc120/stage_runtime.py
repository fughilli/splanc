"""Stage this opt-in adapter in an isolated existing PnR tree, never the live tree."""
import argparse,hashlib,json,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('runtime',type=Path);a=p.parse_args();root=a.runtime.resolve();here=Path(__file__).resolve().parent;repo=here.parents[3]
if root==repo or root in (repo/'hardware',repo/'hardware/pnr'):raise SystemExit('Refusing the live repository')
pkg=root/'hardware/pnr/pnr';pkg.mkdir(parents=True,exist_ok=True)
source=repo/'hardware/pnr/pnr/native_drc.py';cold=source.read_text()
if 'def _run_cold(' in cold:cold=cold[:cold.index('\ndef run_drc(')]+ '\nrun_drc = _run_cold\n'
(pkg/'native_drc_cli.py').write_text(cold)
backend=pkg/'drc_warm';backend.mkdir(exist_ok=False);(backend/'__init__.py').write_text('')
for name in ('client.py','launch_host.py','host.py','model.py','report.py','dependencies.py','session.py'):shutil.copyfile(here/name,backend/name)
(pkg/'native_drc.py').write_text('"""Opt-in persistent native DRC; CLI fallback and final gates retained."""\nfrom .drc_warm.client import run_drc\n')
manifest={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in [pkg/'native_drc.py',pkg/'native_drc_cli.py',*backend.glob('*.py')]}
(root/'drc120-manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps(manifest,indent=2))
