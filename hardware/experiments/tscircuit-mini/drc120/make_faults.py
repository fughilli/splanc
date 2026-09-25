"""Native negative controls only; never router outputs or accepted candidates."""
import argparse,shutil,json,subprocess,sys
from pathlib import Path
import pcbnew as k
p=argparse.ArgumentParser();p.add_argument('board',type=Path);p.add_argument('output',type=Path);p.add_argument('--case');a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
if a.case is None:
 for case in ('baseline','open','width','short','via','placement','clearance'):
  subprocess.run([sys.executable,__file__,str(a.board),str(a.output),'--case',case],check=True)
 raise SystemExit(0)
b=k.LoadBoard(str(a.board.resolve()));base=a.output/'baseline.kicad_pcb';k.SaveBoard(str(base),b,True)
for suffix in ('.kicad_pro','.kicad_dru'):
 if a.board.with_suffix(suffix).exists():shutil.copyfile(a.board.with_suffix(suffix),base.with_suffix(suffix))
if (a.board.parent/'fp-lib-table').exists():(a.output/'fp-lib-table').write_text((a.board.parent/'fp-lib-table').read_text().replace('${KIPRJMOD}',str(a.board.parent.resolve())))
manifest={};keepalive=[b]
for name in (a.case,):
 keepalive.append(b)
 tracks=[t for t in b.GetTracks() if t.GetClass()=='PCB_TRACK'];t=max(tracks,key=lambda t:(t.GetEnd()-t.GetStart()).EuclideanNorm())
 note={}
 if name=='open':note={'removed':t.m_Uuid.AsString()};b.Remove(t)
 elif name=='width':note={'changed':t.m_Uuid.AsString()};t.SetWidth(k.FromMM(.01))
 elif name=='short':
  pads=[p for f in b.GetFootprints() for p in f.Pads() if p.GetNetCode()>0 and p.IsOnLayer(k.F_Cu)]
  pairs=[(p,q) for p in pads for q in pads if p.GetNetCode()!=q.GetNetCode()]
  p,q=min(pairs,key=lambda pair:(pair[0].GetPosition()-pair[1].GetPosition()).EuclideanNorm())
  s=k.PCB_TRACK(b);s.SetStart(p.GetPosition());s.SetEnd(q.GetPosition());s.SetLayer(k.F_Cu);s.SetWidth(k.FromMM(.25));s.SetNetCode(p.GetNetCode());b.Add(s);note={'added':s.m_Uuid.AsString()}
 elif name=='clearance':
  codes=sorted({p.GetNetCode() for f in b.GetFootprints() for p in f.Pads() if p.GetNetCode()>0});box=b.GetBoardEdgesBoundingBox();x=box.GetLeft()+k.FromMM(3);y=box.GetTop()+k.FromMM(3)
  for n in range(2):
   t=k.PCB_TRACK(b);t.SetStart(k.VECTOR2I(x,y+k.FromMM(n*.35)));t.SetEnd(k.VECTOR2I(x+k.FromMM(2),y+k.FromMM(n*.35)));t.SetLayer(k.F_Cu);t.SetWidth(k.FromMM(.25));t.SetNetCode(codes[n]);b.Add(t)
 elif name=='via':
  v=k.PCB_VIA(b);v.SetPosition(t.GetStart());v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetWidth(k.FromMM(.3));v.SetDrill(k.FromMM(.4));v.SetNetCode(t.GetNetCode());b.Add(v);note={'added':v.m_Uuid.AsString()}
 elif name=='placement':
  f=next(f for f in b.GetFootprints() if f.GetReference() not in ('J1','H1'));f.Move(k.VECTOR2I(k.FromMM(1),0));note={'moved':f.GetReference()}
 out=a.output/(name+'.kicad_pcb');k.SaveBoard(str(out),b,True)
 for suffix in ('.kicad_pro','.kicad_dru'):
  if base.with_suffix(suffix).exists() and out!=base:shutil.copyfile(base.with_suffix(suffix),out.with_suffix(suffix))
 manifest[name]=note
(a.output/(a.case+'.fault.json')).write_text(json.dumps(manifest,indent=2))
