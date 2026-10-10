"""Check an exported populated PCB STEP against shell parts (KiCad top Z=0)."""
import argparse,json
from pathlib import Path
import cadquery as cq
p=argparse.ArgumentParser();p.add_argument('board',type=Path);p.add_argument('shell_dir',type=Path);p.add_argument('--top-z',type=float,required=True);a=p.parse_args()
b=cq.importers.importStep(str(a.board)).translate((0,0,a.top_z));r={'reference':str(a.board),'board_top_z':a.top_z,'limitations':'Only models present in the native STEP export; cable plugs and missing models excluded','overlap_mm3':{}}
for part in ('base','lid'):
 s=cq.importers.importStep(str(a.shell_dir/(part+'.step')));v=s.intersect(b).val().Volume();r['overlap_mm3'][part]=v
(a.shell_dir/'actual-board-fit.json').write_text(json.dumps(r,indent=2)+'\n');print(r)
assert all(v<.01 for v in r['overlap_mm3'].values())
