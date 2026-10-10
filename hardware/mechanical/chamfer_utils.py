"""Construct a constant-distance chamfer wedge on a straight convex edge."""
import cadquery as cq

def planar_chamfer(q,center):
 edges=[e for e in q.val().Edges() if abs((e.positionAt(1)-e.positionAt(0)).Length-e.Length())<.001 and (e.Center()-cq.Vector(*center)).Length<.04]
 if not edges:return None
 e=edges[0];mid=e.positionAt(.5);t=e.tangentAt(.5).normalized()
 faces=[f for f in q.val().Faces() if any(a.isSame(e) for a in f.Edges())]
 if len(faces)!=2:return None
 dirs=[]
 for f in faces:
  n=f.normalAt(mid);d=t.cross(n).normalized()
  valid=[v for v in (d,-d) if q.val().isInside(mid+v*.1-n*.005,1e-6)]
  if len(valid)!=1:return None
  dirs.append(valid[0])
 start=e.positionAt(0)-t*.01
 wire=cq.Wire.makePolygon([start,start+dirs[0]*.5,start+dirs[1]*.5],close=True)
 cutter=cq.Solid.extrudeLinear(wire,[],t*(e.Length()+.02));out=q.cut(cutter)
 return out if out.val().isValid() and len(out.val().Solids())==1 else None
