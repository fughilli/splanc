#!/usr/bin/env python3
"""Copy independently compiled atopile boards into non-overlapping rough placements."""
from pathlib import Path
import json,hashlib
import pcbnew as k
R=Path(__file__).resolve().parents[1]
fixed={'board.usbc':(18,3.5,0),'board.led0.conn':(94,25,0),'board.led1.conn':(94,36,0),'board.btn_reset':(32,3.5,0),'board.btn_boot':(44,3.5,0),'board.btn_user1':(82,3.5,0),'board.btn_user2':(89,3.5,0),'board.power_led':(27,10,0),'board.status_led':(33,10,0),'board.mic':(90,55,0),'board.esp.wireless':(17,64,180),'board.esp.uwb':(77,66.5,180),'gps.gnss':(48,57,0),'gps.antenna':(49,68,0),'board.esp.c6_debug':(35,57,0)}
def bb(f):
 q=f.GetBoundingBox(False,False);return tuple(k.ToMM(x) for x in [q.GetX(),q.GetY(),q.GetRight(),q.GetBottom()])
def clash(a,z,g=.35):return a[0]<z[2]+g and z[0]<a[2]+g and a[1]<z[3]+g and z[1]<a[3]+g
allmodels={};reports={};out=R/'boards';out.mkdir(exist_ok=True)
(out/'fp-lib-table').write_text((R/'elec/layout/gps/fp-lib-table').read_text().replace('${KIPRJMOD}/../../src','${KIPRJMOD}/../elec/src'))
for variant in ['base','gps']:
 src=R/'elec/layout'/variant/(variant+'.kicad_pcb');board=k.LoadBoard(str(src));board.SetCopperLayerCount(4)
 fps={f.GetFieldText('atopile_address'):f for f in board.GetFootprints()};occupied=[]
 for a,f in fps.items():
  f.Value().SetVisible(False);f.Reference().SetLayer(k.F_Fab)
 for a,(x,y,rot) in fixed.items():
  if a in fps:
   f=fps[a];f.SetOrientationDegrees(rot);f.SetPosition(k.VECTOR2I(k.FromMM(x),k.FromMM(y)));occupied.append((a,bb(f)))
 for i,(x,y) in enumerate([(4,4),(96,4),(4,76),(96,76)]):
  f=k.FOOTPRINT(board);f.SetReference('H'+str(i+1));f.Reference().SetLayer(k.F_Fab);p=k.PAD(f);p.SetAttribute(k.PAD_ATTRIB_NPTH);p.SetShape(k.PAD_SHAPE_CIRCLE);p.SetSize(k.VECTOR2I(k.FromMM(2.7),k.FromMM(2.7)));p.SetDrillSize(p.GetSize());p.SetLayerSet(k.LSET.AllCuMask());f.Add(p);board.Add(f);f.SetPosition(k.VECTOR2I(k.FromMM(x),k.FromMM(y)));occupied.append((f.GetReference(),(x-2,y-2,x+2,y+2)))
 # No unrelated component is allowed in the RF antenna clearance strips.
 obstacles=[(5,72,30,80),(62,74,90,80)]
 movers=[(a,f) for a,f in fps.items() if a not in fixed];movers.sort(key=lambda af:-(lambda b:(b[2]-b[0])*(b[3]-b[1]))(bb(af[1])))
 for index,(a,f) in enumerate(movers):
  if a.startswith('board.esp'):target=(46,36)
  elif a.startswith('board.converter') or a.startswith('board.pd'):target=(20,25)
  elif a.startswith('board.led0'):target=(82,25)
  elif a.startswith('board.led1'):target=(82,39)
  elif a.startswith('gps.'):target=(47,55)
  else:target=(70,45)
  candidates=sorted(((x*.5,y*.5) for x in range(4,197) for y in range(4,157)),key=lambda p:(p[0]-target[0])**2+(p[1]-target[1])**2)
  chosen=None
  for x,y in candidates:
   f.SetPosition(k.VECTOR2I(k.FromMM(x),k.FromMM(y)));q=bb(f)
   if q[0]<.5 or q[1]<.5 or q[2]>99.5 or q[3]>79.5:continue
   if any(clash(q,z) for _,z in occupied) or any(clash(q,z) for z in obstacles):continue
   chosen=(x,y);occupied.append((a,q));break
  if chosen is None:raise RuntimeError('No space for '+variant+':'+a)
 for a,z in [((0,0),(100,0)),((100,0),(100,80)),((100,80),(0,80)),((0,80),(0,0))]:
  sh=k.PCB_SHAPE();sh.SetShape(k.SHAPE_T_SEGMENT);sh.SetLayer(k.Edge_Cuts);sh.SetStart(k.VECTOR2I(*[k.FromMM(v) for v in a]));sh.SetEnd(k.VECTOR2I(*[k.FromMM(v) for v in z]));sh.SetWidth(k.FromMM(.05));board.Add(sh)
 components=[]
 for a,f in fps.items():
  p=f.GetPosition();components.append({'ref':f.GetReference(),'address':a,'part':f.GetValue(),'position':[k.ToMM(p.x),k.ToMM(p.y)],'rotation':f.GetOrientationDegrees(),'footprint':str(f.GetFPID().GetLibItemName()),'nets':{p.GetNumber():p.GetNetname() for p in f.Pads() if p.GetNumber()}})
 overlaps=[(a,z) for i,(a,aa) in enumerate(occupied) for z,zz in occupied[i+1:] if clash(aa,zz,0)]
 dst=out/f'splanc_{variant}.kicad_pcb';k.SaveBoard(str(dst),board)
 if not (out/f'splanc_{variant}.kicad_pro').exists():(out/f'splanc_{variant}.kicad_pro').write_text(json.dumps({'board':{'design_settings':{'rules':{'min_clearance':.15,'min_copper_edge_clearance':.25,'min_hole_clearance':.2,'min_through_hole_diameter':.2}}},'net_settings':{'classes':[{'name':'Default','clearance':.15,'track_width':.25,'via_diameter':.6,'via_drill':.3}]},'meta':{'version':1}},indent=2)+'\n')
 reports[variant]={'components':len(fps),'footprints':len(fps)+4,'overlap_pairs':overlaps,'source_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'routed':False}
 allmodels[variant]={'outline':{'width_mm':100,'height_mm':80,'thickness_mm':1.6},'components':components}
(R/'design.json').write_text(json.dumps({'boards':allmodels},indent=2)+'\n');(R/'placement-report.json').write_text(json.dumps(reports,indent=2)+'\n')
print(json.dumps(reports,indent=2))
