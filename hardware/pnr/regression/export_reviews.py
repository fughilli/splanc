"""Export completed seed-0 cases; exports do not constitute visual review."""
import argparse,json,subprocess,sys,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('run',type=Path);p.add_argument('--out',type=Path,required=True);p.add_argument('--resume',action='store_true');p.add_argument('--document-python',required=True);p.add_argument('--pdftoppm',required=True);a=p.parse_args()
repo=Path(__file__).resolve().parents[3];a.out.mkdir(parents=True,exist_ok=a.resume)
summary=json.loads((a.run/'summary.json').read_text())
for r in summary['results']:
 if r['seed']!=0:continue
 root=Path(r['directory']);board=root/'routed.kicad_pcb'
 if not board.exists():continue
 target=a.out/r['case']
 if target.exists():
  import hashlib
  assert a.resume and json.loads((target/'manifest.json').read_text())['sha256']==hashlib.sha256(board.read_bytes()).hexdigest()
  continue
 with (a.out/(r['case']+'.log')).open('w') as log:
  subprocess.run([a.document_python,str(repo/'hardware/tools/export_mini_review.py'),str(board),'--out-dir',str(target),'--pdftoppm',a.pdftoppm],check=True,stdout=log,stderr=subprocess.STDOUT,timeout=180)
 (target/'regression-result.json').write_text(json.dumps(r,indent=2))
 print('EXPORTED '+r['case'],flush=True)
