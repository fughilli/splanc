"""Rigidly transform manufacturer CAD to the selected KiCad pin-1 frame.
No scaling. Original files and drawing remain available for inspection.
"""
import json,hashlib
from pathlib import Path
import cadquery as cq
root=Path(__file__).resolve().parent/'assets/max-connectors'
p=root/'degson-2edgrc-3-header.step'
q=cq.importers.importStep(str(p)).rotate((0,0,0),(1,0,0),180).translate((-19.18,2.1,-1.4))
out=root/'degson-2edgrc-3-header-normalized.step';cq.exporters.export(q,str(out))
b=q.val().BoundingBox();bounds=[b.xmin,b.xmax,b.ymin,b.ymax,b.zmin,b.zmax]
expected=[-3.54,13.7,-9.9,2.1,-3.1,8.6];assert all(abs(a-z)<.002 for a,z in zip(bounds,expected));assert q.val().isValid()
# Below the PCB only the three solder tails may remain. Bounding boxes alone
# cannot distinguish an upside-down model with the same total height.
section=q.val().intersect(cq.Workplane('XY').box(50,50,.02).translate((5,0,-2)).val()).Volume()/.02
assert 0 < section < 4, section
assets=[{'mpn':'2EDGRC-5.08-03P-14-100A(H)','manufacturer':'DEGSON','source_page':'https://www.degson.com.cn/content/details_552_619888.html?lang=degson','source_step':'https://www.degson.com.cn/index.php?a=downloadFile&id=5124408&name=%27ZmlsZTQ=%27','file':p.name,'normalized':out.name,'transform':{'rotation_x_deg':180,'translation_mm':[-19.18,2.1,-1.4]},'normalized_bounds_mm':bounds,'pcb_pin_centers_mm':[[0,0],[5.08,0],[10.16,0]],'pcb_drill_mm':1.5,'mouth_direction':[0,-1,0],'datum_note':'Pin numbers assigned left to right looking at outward mouth; no numbered terminals on manufacturer CAD.','source_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'normalized_sha256':hashlib.sha256(out.read_bytes()).hexdigest()}, {'mpn':'2EDGKDF-5.08-03P-14-00A(H)','manufacturer':'DEGSON','file':'degson-2edgkdf-3-plug.step','source_page':'https://www.degson.com/content/details_552_882880.html?lang=en','source_step':'https://www.degson.com/index.php?a=downloadFile&id=5119014&name=%27ZmlsZTQ=%27','status':'Actual mating-plug CAD retained; exterior renders show unplugged headers.','sha256':hashlib.sha256((root/'degson-2edgkdf-3-plug.step').read_bytes()).hexdigest()}]
(root.parent/'degson-connectors.json').write_text(json.dumps({'status':'selected cost-down connector pair; manufacturer CAD; physical fit qualification pending','units':'mm','assets':assets,'license':'Manufacturer reference CAD; original STEP headers preserved. No broader redistribution grant asserted.'},indent=2)+'\n')
print('Normalized actual DEGSON model:',bounds)
