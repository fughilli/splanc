"""Fixed workload cold CLI vs headless native API / persistent BOARD timings."""
import argparse, json, os, re, resource, subprocess, sys, time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('board');p.add_argument('out');p.add_argument('--repeat',type=int,default=5);a=p.parse_args()
out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
t=time.perf_counter();import wx; app=wx.App(False); import pcbnew as k
rows=[dict(mode='import',wall=time.perf_counter()-t)]
b=None
for mode in ('reload','reuse'):
 for i in range(a.repeat):
  t=time.perf_counter();cpu=time.process_time()
  if b is None or mode=='reload':b=k.LoadBoard(str(Path(a.board).resolve()))
  load=time.perf_counter()-t;start=time.perf_counter();report=out/f'{mode}-{i}.rpt'
  ok=k.WriteDRCReport(b,str(report.resolve()),k.EDA_UNITS_MM,False)
  text=report.read_text() if ok else ''
  counts=re.findall(r'\*\* Found (\d+) (.*?) \*\*',text)
  row=dict(mode=mode,iteration=i,load=load,drc_report=time.perf_counter()-start,wall=time.perf_counter()-t,cpu=time.process_time()-cpu,ok=ok,counts=counts,rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
  rows.append(row);print(json.dumps(row),flush=True)
(out/'api.json').write_text(json.dumps(dict(version=k.GetBuildVersion(),rows=rows),indent=2))
