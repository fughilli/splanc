"""Exact-part QWIIC socket and cable access, in the frozen PCB reference frame."""
from pathlib import Path
import gzip,tempfile
import cadquery as cq
HERE=Path(__file__).resolve().parent

def connector(spec):
 with tempfile.NamedTemporaryFile(suffix='.step') as f:
  f.write(gzip.decompress((HERE/'assets/qwiic/JST_SH_SM04B-SRSS-TB.step.gz').read_bytes()));f.flush()
  return cq.importers.importStep(f.name).rotate((0,0,0),(0,0,1),spec['rotation_deg']).translate(tuple(spec['origin_mm']))

def opening(spec,margin):
 # A rectangular drafted well clears the housing and a 7.4 x 4.2 mm
 # mating/handling envelope. No overmold is assumed to pass through a thin lip.
 x,y,z=spec['mouth_mm'];wi,hi=spec['opening_inner_mm'];wo,ho=spec['opening_outer_mm']
 def wire(t,w,h):return cq.Workplane(cq.Plane(origin=(x-t,y,z),xDir=(0,1,0),normal=(-1,0,0))).rect(w,h).val()
 wires=[wire(-1.5,wi,hi),wire(margin+x,wo,ho),wire(margin+15,wo,ho)]
 return cq.Workplane(obj=cq.Solid.makeLoft(wires,True))

def seal_stop(spec,margin):
 from copy import deepcopy
 d=deepcopy(spec)
 d['opening_inner_mm']=[v+1.6 for v in d['opening_inner_mm']]
 d['opening_outer_mm']=[v+1.6 for v in d['opening_outer_mm']]
 return opening(d,margin)
