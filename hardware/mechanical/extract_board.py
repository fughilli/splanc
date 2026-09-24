"""Extract actual KiCad outline, mounts and component poses for enclosure input.
Run with KiCad's pcbnew Python. No board edits.
"""
import argparse,json,hashlib
from pathlib import Path
import pcbnew as k
p=argparse.ArgumentParser();p.add_argument('board',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
b=k.LoadBoard(str(a.board));poly=k.SHAPE_POLY_SET();assert b.GetBoardPolygonOutlines(poly,False);bb=poly.BBox();x0,y0=bb.GetLeft()/1e6,bb.GetBottom()/1e6
parts=[];mounts=[]
for f in b.GetFootprints():
 pt=f.GetPosition();address=next((z.GetText() for z in f.GetFields() if z.GetName()=='atopile_address'),'')
 item=dict(ref=f.GetReference(),value=f.GetValue(),address=address,position=[pt.x/1e6-x0,y0-pt.y/1e6],rotation=f.GetOrientationDegrees(),side='bottom' if f.IsFlipped() else 'top',pads=[])
 for q in f.Pads():
  qp=q.GetPosition();pad=dict(number=q.GetNumber(),position=[qp.x/1e6-x0,y0-qp.y/1e6],size=[q.GetSize().x/1e6,q.GetSize().y/1e6],drill_mm=q.GetDrillSize().x/1e6);item['pads'].append(pad)
  if f.GetReference().startswith('MH') and q.GetAttribute()==k.PAD_ATTRIB_NPTH:mounts.append(dict(x=pad['position'][0],y=pad['position'][1],diameter_mm=pad['drill_mm']))
 parts.append(item)
r=dict(schema=1,board=str(a.board.resolve()),sha256=hashlib.sha256(a.board.read_bytes()).hexdigest(),frame='PCB lower-left, X right, Y towards rear, Z from PCB bottom',outline=dict(width_mm=bb.GetWidth()/1e6,height_mm=bb.GetHeight()/1e6,thickness_mm=b.GetDesignSettings().GetBoardThickness()/1e6),native_origin=[x0,y0],mounts=mounts,components=parts)
a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(r,indent=2))
