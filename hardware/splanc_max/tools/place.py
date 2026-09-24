#!/usr/bin/env python3
"""Deterministic coarse non-overlapping placement; no routing or scoring claim."""
from pathlib import Path
import json,math
import pcbnew as k
R=Path(__file__).resolve().parents[1]
def box(f,h):
 b=f.GetBoundingBox(False,False);return (k.ToMM(b.GetX()),h-k.ToMM(b.GetBottom()),k.ToMM(b.GetRight()),h-k.ToMM(b.GetY()))
def overlap(a,b,g=.35):return a[0]<b[2]+g and b[0]<a[2]+g and a[1]<b[3]+g and b[1]<a[3]+g
def run():
 d=json.loads((R/'design.json').read_text());report={}
 for name,B in d['boards'].items():
  path=R/'boards'/f'splanc_max_{name}.kicad_pcb';b=k.LoadBoard(str(path));fs={f.GetReference():f for f in b.GetFootprints()};w,h=B['outline']['width_mm'],B['outline']['height_mm'];occupied=[];warnings=[]
  for ref,f in fs.items():
   if ref.startswith(('J','H')):occupied.append((ref,box(f,h)))
  # Body/land/courtyard envelope all retained; moving references and text irrelevant.
  movers=[c for c in B['components'] if not c['ref'].startswith('J')]
  movers.sort(key=lambda c: -(lambda q:(q[2]-q[0])*(q[3]-q[1]))(box(fs[c['ref']],h)))
  for c in movers:
   f=fs[c['ref']];target=c['position'];chosen=None
   candidates=[tuple(target)]+sorted(((x*.5,y*.5) for x in range(4,int(2*w)-3) for y in range(4,int(2*h)-3)),key=lambda p:(p[0]-target[0])**2+(p[1]-target[1])**2)
   for x,y in candidates:
    f.SetPosition(k.VECTOR2I(k.FromMM(x),k.FromMM(h-y)));bb=box(f,h)
    if bb[0]<.5 or bb[1]<.5 or bb[2]>w-.5 or bb[3]>h-.5:continue
    if any(overlap(bb,z) for _,z in occupied):continue
    chosen=[x,y];occupied.append((c['ref'],bb));break
   if chosen is None:raise RuntimeError('No legal rough placement for '+name+':'+c['ref'])
   c['position']=chosen
  for i,(a,aa) in enumerate(occupied):
   for z,zz in occupied[i+1:]:
    if overlap(aa,zz,g=0):warnings.append([a,z])
  k.SaveBoard(str(path),b);report[name]={'footprints':len(fs),'overlap_pairs':warnings,'width_mm':w,'height_mm':h}
  con=json.loads((R/f'{name}-constraints.json').read_text());con['rough_placement']={c['ref']:c['position'] for c in B['components']};(R/f'{name}-constraints.json').write_text(json.dumps(con,indent=2)+'\n')
 (R/'design.json').write_text(json.dumps(d,indent=2)+'\n');(R/'placement-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if __name__=='__main__':run()
