"""Exact old/new validation equivalence and repeat timing on saved native board."""
import importlib.util,json,time
import pcbnew as k
from pnr.pad_entry import inspect
spec=importlib.util.spec_from_file_location('original_entry','hardware/pnr/pnr/pad_entry.py');original=importlib.util.module_from_spec(spec);spec.loader.exec_module(original)
rules=json.load(open('output/fresh-pnr-20260919/full104/relocation/round-01/alternatives/candidate-00/evaluated-rules.json'))
def normalized(rows):return [(p.m_Uuid.AsString(),layer,[t.m_Uuid.AsString() for t in touching],width,good) for p,layer,touching,width,good in rows]
results=[]
for path in ['output/fresh-pnr-20260919/full104/relocation/round-01/diagnostic.kicad_pcb','output/geometry105/board-fault-indexed.kicad_pcb']:
 b=k.LoadBoard(path);b.BuildConnectivity();timings={};reports={}
 for name,fn in [('original',original.inspect),('indexed',inspect)]:
  start=time.perf_counter();reports[name]=normalized(fn(b,rules));timings[name]=time.perf_counter()-start
 assert reports['original']==reports['indexed'],'validation semantics changed'
 results.append(dict(board=path,timings=timings,records=len(reports['indexed']),exact_match=True))
print(json.dumps(results,indent=2));open('output/geometry105/validation-benchmark.json','w').write(json.dumps(results,indent=2))
