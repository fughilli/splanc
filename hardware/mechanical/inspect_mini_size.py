"""Read-only rectangular-envelope screen, never a DRC or autorouting acceptance."""
from pathlib import Path
import json,argparse,hashlib
import pcbnew as k
p=argparse.ArgumentParser();p.add_argument('board',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
b=k.LoadBoard(str(a.board));poly=k.SHAPE_POLY_SET();assert b.GetBoardPolygonOutlines(poly,False);bb=poly.BBox();origin=(bb.GetLeft()/1e6,bb.GetBottom()/1e6);w,h=bb.GetWidth()/1e6,bb.GetHeight()/1e6
rows=[]
def rect(bb):return [bb.GetLeft()/1e6-origin[0],origin[1]-bb.GetBottom()/1e6,bb.GetRight()/1e6-origin[0],origin[1]-bb.GetTop()/1e6]
for f in b.GetFootprints():
 boxes=[]
 for shape in f.GraphicalItems():
  if shape.GetLayer() in (k.F_CrtYd,k.B_CrtYd):boxes.append(rect(shape.GetBoundingBox()))
 for pad in f.Pads():boxes.append(rect(pad.GetBoundingBox()))
 if not boxes:continue
 r=[min(q[0] for q in boxes),min(q[1] for q in boxes),max(q[2] for q in boxes),max(q[3] for q in boxes)]
 rows.append({'ref':f.GetReference(),'bbox':r})
track_boxes=[rect(t.GetBoundingBox()) for t in b.GetTracks()]
minimum=[min(q['bbox'][i] for q in rows) if i<2 else max(q['bbox'][i] for q in rows) for i in range(4)]
trials=[]
for tw,th in [(68,53),(66,51),(64,48)]:
 bounds=[(w-tw)/2,(h-th)/2,(w+tw)/2,(h+th)/2]
 def crosses(q):return q[0]<bounds[0] or q[1]<bounds[1] or q[2]>bounds[2] or q[3]>bounds[3]
 trials.append({'centered_outline_mm':[tw,th],'area_reduction_percent':round(100*(1-tw*th/(w*h)),2),'footprints_to_recheck':[q['ref'] for q in rows if crosses(q['bbox'])],'crossing_track_or_via_boxes':sum(crosses(q) for q in track_boxes)})
report={'board':str(a.board.resolve()),'sha256':hashlib.sha256(a.board.read_bytes()).hexdigest(),'outline_mm':[w,h],'pad_courtyard_union_bbox_mm':minimum,'trials':trials,'qualification':'Read-only bounding boxes, including intentional connector overhang. Counts are relocation/review screening, not electrical clearance proof. Zone refill, RF keepouts, edge rules, mounting margins and native DRC required after any outline change. Board file not changed.'}
a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
