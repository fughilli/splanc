"""Actual KiCad additive fusion and crossing-conflict rejection fixture."""
from pathlib import Path
import pcbnew as k,subprocess,json,os,sys,shutil
root=Path('output/parallel107/merge-fixture');root.mkdir(parents=True,exist_ok=True)
cli='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
b=k.BOARD();nets={}
for name in ['A','B']:
 n=k.NETINFO_ITEM(b,name);b.Add(n);nets[name]=n
for ref,net,points in [('J1','A',[(5,10),(15,10)]),('J2','B',[(10,5),(10,15)])]:
 f=k.FOOTPRINT(b);f.SetReference(ref);f.SetValue('fixture');b.Add(f)
 for index,(x,y) in enumerate(points):
  p=k.PAD(f);p.SetNumber(str(index+1));p.SetAttribute(k.PAD_ATTRIB_PTH);p.SetShape(k.PAD_SHAPE_CIRCLE);p.SetSize(k.VECTOR2I(1200000,1200000));p.SetDrillSize(k.VECTOR2I(600000,600000));p.SetLayerSet(k.LSET.AllCuMask());p.SetPosition(k.VECTOR2I(int(x*1e6),int(y*1e6)));p.SetNetCode(nets[net].GetNetCode());f.Add(p)
for a,z in [((1,1),(19,1)),((19,1),(19,19)),((19,19),(1,19)),((1,19),(1,1))]:
 t=k.PCB_SHAPE();t.SetShape(k.SHAPE_T_SEGMENT);t.SetStart(k.VECTOR2I(*(int(v*1e6) for v in a)));t.SetEnd(k.VECTOR2I(*(int(v*1e6) for v in z)));t.SetLayer(k.Edge_Cuts);t.SetWidth(50000);b.Add(t)
base=root/'base.kicad_pcb';k.SaveBoard(str(base),b);base.with_suffix('.kicad_pro').write_text('{}')
def proposal(name,net,a,z,layer):
 b=k.LoadBoard(str(base));t=k.PCB_TRACK(b);t.SetStart(k.VECTOR2I(*(int(v*1e6) for v in a)));t.SetEnd(k.VECTOR2I(*(int(v*1e6) for v in z)));t.SetLayer(layer);t.SetWidth(250000);t.SetNetCode(b.FindNet(net).GetNetCode());b.Add(t);t.thisown=False
 p=root/(name+'.kicad_pcb');k.SaveBoard(str(p),b);shutil.copy2(base.with_suffix('.kicad_pro'),p.with_suffix('.kicad_pro'));return p
pa=proposal('a','A',(5,10),(15,10),k.F_Cu);pb=proposal('b','B',(10,5),(10,15),k.B_Cu);pc=proposal('conflict','B',(10,5),(10,15),k.F_Cu)
def merge(p,current,name):
 out=root/(name+'.kicad_pcb');subprocess.run([sys.executable,'-m','pnr.merge_additive',str(base),str(p),str(current),str(out)],check=True);return out
first=merge(pa,base,'first');fused=merge(pb,first,'fused');conflict=merge(pc,first,'crossing')
def drc(p):
 out=p.with_suffix('.drc.json');subprocess.run([cli,'pcb','drc',str(p),'--format','json','--output',str(out)],check=True,stdout=subprocess.DEVNULL);return json.loads(out.read_text())
d0,da,db,dc=map(drc,[base,first,fused,conflict]);count=lambda d:len(d['unconnected_items'])
assert [count(d) for d in [d0,da,db]]==[2,1,0], [count(d) for d in [d0,da,db]]
assert not db['violations'],db['violations']
assert dc['violations'],'native DRC must reject crossing'
report=dict(base_opens=count(d0),first_opens=count(da),fused_opens=count(db),fused_violations=len(db['violations']),conflict_violations=[v['type'] for v in dc['violations']]);(root/'result.json').write_text(json.dumps(report,indent=2));print('PASS native fusion and crossing rejection',report)
