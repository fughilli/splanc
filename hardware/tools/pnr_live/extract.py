"""Native KiCad geometry -> live viewer engine coordinates (mm, y-up)."""
import json,sys,math,pcbnew as k
from pnr.ingest import build_graph,_board_frame
b=k.LoadBoard(sys.argv[1]);frame,outline=_board_frame(b);xy=lambda p:list(frame.point(p.x,p.y));tracks=[];vias=[]
for t in b.GetTracks():
 if t.GetClass()=='PCB_VIA':vias.append(dict(net=t.GetNetname(),xy=xy(t.GetPosition()),diameter=t.GetWidth(k.F_Cu)/1e6));continue
 if t.GetClass()=='PCB_ARC':
  center=t.GetCenter();start=t.GetStart();angle=t.GetArcAngle().AsRadians();radius=math.hypot(start.x-center.x,start.y-center.y);theta=math.atan2(start.y-center.y,start.x-center.x);pts=[xy(k.VECTOR2I(int(center.x+radius*math.cos(theta+angle*i/32)),int(center.y+radius*math.sin(theta+angle*i/32)))) for i in range(33)]
 else:pts=[xy(t.GetStart()),xy(t.GetEnd())]
 for a,c in zip(pts,pts[1:]):tracks.append([t.GetNetname(),t.GetLayerName(),a,c,t.GetWidth()/1e6])
parts=[]
for f in b.GetFootprints():
 pads=[]
 for p in f.Pads():pads.append(dict(number=p.GetNumber(),net=p.GetNetname(),xy=xy(p.GetPosition()),size=[p.GetSize().x/1e6,p.GetSize().y/1e6],angle=p.GetOrientationDegrees(),shape='circle' if p.GetShape()==k.PAD_SHAPE_CIRCLE else 'rect',layers=[k.BOARD.GetStandardLayerName(l) for l in p.GetLayerSet().Seq() if k.IsCopperLayer(l)]))
 parts.append(dict(ref=f.GetReference(),xy=xy(f.GetPosition()),pads=pads))
zones=[]
for z in b.Zones():
 if z.GetIsRuleArea():continue
 for layer in z.GetLayerSet().Seq():
  if not k.IsCopperLayer(layer):continue
  try:
   poly=z.GetFilledPolysList(layer)
   for j in range(poly.OutlineCount()):
    line=poly.COutline(j);paths=[[xy(line.CPoint(i)) for i in range(line.PointCount())]]
    for h in range(poly.HoleCount(j)):
     hole=poly.CHole(j,h);paths.append([xy(hole.CPoint(i)) for i in range(hole.PointCount())])
    zones.append(dict(layer=k.BOARD.GetStandardLayerName(layer),net=z.GetNetname(),paths=paths))
  except Exception as e:raise RuntimeError('Cannot extract native plane polygons: '+str(e))
json.dump(dict(frame='mm-y-up',width=outline.width,height=outline.height,parts=parts,tracks=tracks,vias=vias,zones=zones),open(sys.argv[2],'w'))
