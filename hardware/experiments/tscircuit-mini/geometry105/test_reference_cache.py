import json,random,math,time
import pcbnew as k
from pnr.native_electrical import pair_reference_validator
b=k.LoadBoard('output/fresh-pnr-20260919/full104/relocation/round-01/alternatives/candidate-00/phases/01-plane-access-fill/diagnostic.kicad_pcb');r=json.load(open('output/fresh-pnr-20260919/full104/relocation/round-01/alternatives/candidate-00/electrical/native-loop/early-pairs/rules.json'));pair=r['diff_pairs'][0];base=pair_reference_validator(b,pair,r);rng=random.Random(5);count=0;results=[]
for shift in [0,.2,.5,1.]:
 vias=[(pair['p'],(44.75,78.14-shift)),(pair['n'],(43.25,78.14-shift))];slow=pair_reference_validator(b,pair,r,vias);fast=pair_reference_validator(b,pair,r,vias,base_center=base.center)
 for i in range(600):
  a=(rng.uniform(40,48),rng.uniform(75,81)) if i<300 else (rng.uniform(30,100),rng.uniform(30,85));ang=rng.uniform(0,math.tau);length=rng.uniform(.05,4);z=(a[0]+length*math.cos(ang),a[1]+length*math.sin(ang));width=rng.choice([.2,.35,.5])
  assert slow.center(a,z,width)==fast.center(a,z,width),(a,z,width);count+=1
print('PASS exact reference containment parity',count,'near/far aperture segments')
