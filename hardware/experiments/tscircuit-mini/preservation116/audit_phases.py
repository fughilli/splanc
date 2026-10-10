import sys,json
from pathlib import Path
sys.path.insert(0,str(Path('hardware/pnr').resolve()))
import pcbnew as k
from pnr.via_coalesce import partition
root=Path('output/fresh-pnr-20260919/pogo114-20260924/candidate')
before=json.loads((root/'electrical/seed-inventory.json').read_text())['partition']
result=[]
for folder in sorted((root/'phases').iterdir()):
 p=folder/'diagnostic.kicad_pcb'
 if not p.exists():continue
 b=k.LoadBoard(str(p));b.BuildConnectivity();groups=list(map(set,partition(b)));labels={p.m_Uuid.AsString():f.GetReference()+'.'+p.GetNumber()+' '+p.GetNetname() for f in b.GetFootprints() for p in f.Pads()}
 lost=[g for g in before if not any(set(g)<=h for h in groups)]
 r=dict(phase=folder.name,lost_groups=[[labels.get(i,i) for i in g] for g in lost],fragments=[[[labels.get(i,i) for i in h&set(g)] for h in groups if h&set(g)] for g in lost]);result.append(r)
print(json.dumps([dict(phase=r["phase"],lost_group_count=len(r["lost_groups"])) for r in result],indent=2))
Path('output/preservation116/stage-connectivity.json').write_text(json.dumps(result,indent=2))
