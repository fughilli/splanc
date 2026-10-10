"""Extrude the actual repository SVG contours, preserving letter counters."""
from pathlib import Path
import math
import cadquery as cq
from svgpathtools import Document
from shapely.geometry import Polygon
from shapely.ops import unary_union

def embossed_logo(width,cx,cy,z,height=.45):
 paths=Document(str(Path(__file__).resolve().parents[2]/'web/public/icons/splanc.svg')).paths()
 bounds=[p.bbox() for p in paths];xmin=min(b[0] for b in bounds);xmax=max(b[1] for b in bounds);ymin=min(b[2] for b in bounds);ymax=max(b[3] for b in bounds);scale=width/(xmax-xmin)
 allparts=[]
 for path in paths:
  poly=None
  for sub in path.continuous_subpaths():
   pts=[]
   for segment in sub:
    n=max(2,math.ceil(segment.length()*scale/.18))
    for i in range(n):
     v=segment.point(i/n);pts.append((cx+(v.real-(xmin+xmax)/2)*scale,cy-(v.imag-(ymin+ymax)/2)*scale))
   p=Polygon(pts).buffer(0);poly=p if poly is None else poly.symmetric_difference(p)
  allparts.append(poly)
 geo=unary_union(allparts).simplify(.003,preserve_topology=True);solids=[]
 for p in (list(geo.geoms) if hasattr(geo,'geoms') else [geo]):
  if p.area<.0001:continue
  def wire(coords):
   pts=[]
   for x,y in list(coords)[:-1]:
    if not pts or (cq.Vector(x,y,z)-pts[-1]).Length>1e-5:pts.append(cq.Vector(x,y,z))
   return cq.Wire.makePolygon(pts,close=True)
  outer=wire(p.exterior.coords);holes=[wire(h.coords) for h in p.interiors if Polygon(h).area>.0001]
  solids.append(cq.Solid.extrudeLinear(outer,holes,cq.Vector(0,0,height)))
 return cq.Workplane('XY').newObject([cq.Compound.makeCompound(solids)])
