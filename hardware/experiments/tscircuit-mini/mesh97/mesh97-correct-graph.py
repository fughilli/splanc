from pathlib import Path
import json,pcbnew
from pnr.ingest import build_graph
from pnr.graph import BoardGraph
root=Path('output/fresh-pnr-20260919/mesh97-comparison')
for src,dst in [('elastic/round-01','corrected-baseline/round-01'),('elastic/round-02','corrected-mesh/round-02')]:
 p=root/src;out=root/dst;out.mkdir(parents=True,exist_ok=True)
 g=BoardGraph.from_json((p/'placed.json').read_text());native=build_graph(pcbnew.LoadBoard(str(p/'diagnostic.kicad_pcb')));changes=[]
 for c in g.components:
  actual=native.component(c.ref)
  assert len(c.pads)==len(actual.pads),(c.ref,len(c.pads),len(actual.pads))
  for pad,new in zip(c.pads,actual.pads):
   assert pad.name==new.name
   if max(abs(a-b) for a,b in zip(pad.size,new.size))>1e-6:changes.append([c.ref,pad.name,pad.size,new.size])
   pad.size=new.size
 (out/'placed.json').write_text(g.to_json());(out/'pad-geometry-changes.json').write_text(json.dumps(changes,indent=2));print(dst,len(changes))
