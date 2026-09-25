"""Start an isolated initialized KiCad host; never install into user configuration."""
import argparse,json,os,shutil,subprocess,sys,time,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--board',type=Path,required=True);a=p.parse_args();root=a.root.resolve();root.mkdir(parents=True,exist_ok=False)
for d in ('requests','replies','reports','boards'):(root/d).mkdir()
config=root/'config'/'10.0';config.mkdir(parents=True)
source=Path.home()/'Library/Preferences/kicad/10.0'
for name in ('kicad_common.json','kicad.json','pcbnew.json','fp-lib-table','sym-lib-table','design-block-lib-table'):
 if (source/name).exists():shutil.copyfile(source/name,config/name)
prefs=config/'pcbnew.json';v=json.loads(prefs.read_text());v['system']['first_run_shown']=True;prefs.write_text(json.dumps(v));
plugins=config/'scripting/plugins';plugins.mkdir(parents=True)
runtime=root/'runtime';runtime.mkdir()
for name in ('host.py','model.py','report.py','dependencies.py'):shutil.copyfile(Path(__file__).resolve().with_name(name),runtime/name)
module=runtime/'host.py'
(plugins/'splanc_drc120.py').write_text('import os,runpy,wx\nif os.environ.get("SPLANC_DRC120_ROOT"):\n    _module=runpy.run_path('+repr(str(module))+')\n    wx.CallLater(1000,_module["start"],os.environ["SPLANC_DRC120_ROOT"])\n')
model=root/'model';model.mkdir();seed=a.board.resolve();board=model/seed.name
for suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru'):
 if seed.with_suffix(suffix).exists():shutil.copyfile(seed.with_suffix(suffix),board.with_suffix(suffix))
if (seed.parent/'fp-lib-table').exists():(model/'fp-lib-table').write_text((seed.parent/'fp-lib-table').read_text().replace('${KIPRJMOD}',str(seed.parent)))
# Use the project table as this private host's global table only when it
# covers every library actually referenced by the seed; avoids loading thousands
# of irrelevant stock footprints without dropping any seed library checks.
if (model/'fp-lib-table').exists():
 table=(model/'fp-lib-table').read_text();used={id.split(':',1)[0] for id in re.findall(r'\(footprint\s+"([^"]+)"',board.read_text()) if ':' in id};available=set(re.findall(r'\(name\s+"([^"]+)"',table))
 if used<=available:shutil.copyfile(model/'fp-lib-table',config/'fp-lib-table')
env=dict(os.environ,KICAD_CONFIG_HOME=str(root/'config'),SPLANC_DRC120_ROOT=str(root))
exe='/Applications/KiCad/KiCad.app/Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew'
with (root/'host.log').open('w') as log:proc=subprocess.Popen([exe,str(board)],stdout=log,stderr=log,env=env,start_new_session=True)
(root/'process.json').write_text(json.dumps(dict(pid=proc.pid,started=time.time(),command=[exe,str(board)],config=str(config),module=str(module)),indent=2))
for _ in range(100):
 if (root/'ready.json').exists():print((root/'ready.json').read_text());break
 if (root/'startup-error.json').exists():
  proc.terminate();raise RuntimeError((root/'startup-error.json').read_text())
 if proc.poll() is not None:raise RuntimeError('KiCad host exited: '+str(proc.returncode))
 time.sleep(.1)
else:
 proc.terminate()
 raise TimeoutError('Native warm host readiness deadline expired; inspect host.log')
