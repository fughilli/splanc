"""Create embossed STEP lids and tessellated real-CAD assets for Blender.
Keeps original mechanical review snapshots immutable.
"""
import json,math,hashlib,shutil
from pathlib import Path
import cadquery as cq
from logo import embossed_logo
from cad_colors import colored_faces
from generate_enclosures import box,cylinder,ring
OUT=Path('output/product-renders-black');OUT.mkdir(exist_ok=True,parents=True)
LIB=Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels')
items=[];sources=[];model_cache={}
def mesh(name,shape,material,product,color=None):
 s=shape.val() if isinstance(shape,cq.Workplane) else shape
 verts,faces=s.tessellate(.07,.15)
 if not verts:return
 items.append(dict(name=name,product=product,material=material,color=color,vertices=[[v.x,v.y,v.z] for v in verts],faces=[list(f) for f in faces]))
def step(path,name,product,material,shift=(0,0,0),rotation=0,split=False):
 path=Path(path);key=(str(path),material)
 if key not in model_cache:
  print('Tessellating',path.name,flush=True)
  sources.append(dict(name=name,path=str(path),sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
  start=len(items)
  if split or material in ('white_nylon','terminal','cad'):
   grouped={}
   for face,col in colored_faces(path):
    if path.name=='degson-2edgrc-3-header-normalized.step':
     bb=face.BoundingBox()
     pin=any(bb.xmin>=x-.501 and bb.xmax<=x+.501 for x in (0,5.08,10.16))
     metal=pin and (bb.zmax<=.001 or (bb.zmin>=3.299 and bb.zmax<=4.301))
     col=(.65,.65,.65) if metal else (.02,.3,.08)
    k=tuple(round(c,4) for c in col) if col else None;grouped.setdefault(k,[]).append(face)
   for i,(col,faces) in enumerate(grouped.items()):
    m=material
    if col:
     r,g,b=col
     if max(col)<.15:m='nylon'
     elif g>r*1.3 and g>b*1.3:m='terminal' if material=='terminal' else 'pcb'
     elif r>g*1.15 and g>b*1.4:m='gold'
     elif material=='white_nylon' and min(col)>.5:m='white_nylon'
     else:m='nickel'
    mesh(name+f'-{i}',cq.Compound.makeCompound(faces),m,product,col)
  else:mesh(name,cq.importers.importStep(str(path)),material,product)
  model_cache[key]=items[start:];del items[start:]
 c=math.cos(math.radians(rotation));t=math.sin(math.radians(rotation));dx,dy,dz=shift
 for i,part in enumerate(model_cache[key]):
  items.append(dict(part,name=name+f'-{i}',product=product,vertices=[[c*x-t*y+dx,t*x+c*y+dy,z+dz] for x,y,z in part['vertices']]))
 return None

def inlay(lid,width,cx,cy,top,product,out):
 # Separate second-shot solid in a 0.7mm pocket, flush with the lid surface.
 logo=embossed_logo(width,cx,cy,top-.7,.7)
 pocket=embossed_logo(width,cx,cy,top-.7,.8)
 lid=lid.cut(pocket)
 cq.exporters.export(logo,str(out/'logo-white-inlay.step'))
 mesh('logo-white-inlay',logo,'logo_white',product)
 return lid

def mini_parts():
 product='mini';root=Path('output/mechanical/mini');out=OUT/product;out.mkdir(exist_ok=True)
 for name in ('base','lid'):
  q=cq.importers.importStep(str(root/(name+'.step')))
  if name=='lid':q=inlay(q,38,35,27.5,20,product,out)
  assert len(q.val().Solids())==1
  cq.exporters.export(q,str(out/(name+'.step')));mesh(name,q,'shell_'+name,product)
 for p in root.glob('button-*.step'):step(p,p.stem,product,'button')
 for p in root.glob('lightpipe-*.step'):step(p,p.stem,product,'lightpipe')
 mesh('pcb',box(0,0,5.8,70,55,1.6),'pcb',product)
 step(LIB/'Connector_USB.3dshapes/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.step','USB4105',product,'connector',(14,2.225,7.4),split=True)
 jst='hardware/splanc_dev/elec/src/parts/JST_B3B_PH_K_S_LF__SN/CONN-TH_B3B-PH-K-S.step'
 for y in (20,31):step(jst,'JST-'+str(y),product,'white_nylon',(64,y,7.4),90)
 return [76.4,61.4,20]

def splanc_parts():
 product='splanc';out=OUT/product;out.mkdir(exist_ok=True);j=json.load(open('hardware/splanc/interface.json'));spec=j['boards']['splanc']
 # Mechanical frame matches native interface; 100x80 board and mounting contract.
 w,h=spec['outline']['width_mm'],spec['outline']['height_mm'];x=y=-3.2;W=w+6.4;H=h+6.4;split=10;top=25;floor=2.2;pz=5.8
 base=box(x,y,0,W,H,split,3).cut(box(-1,-1,floor,w+2,h+2,split,1))
 lid=box(x,y,split,W,H,top-split,3).cut(box(-1,-1,split-.1,w+2,h+2,top-2.2-split+.1,1))
 lid=lid.union(ring(-.75,-.75,split-1.4,w+1.5,h+1.5,1.5,.6,1)).union(ring(-1.1,-1.1,split,w+2.2,h+2.2,.8,.95,1))
 for mount in spec['mounts']:
  a,b=mount['x'],mount['y']
  base=base.union(cylinder(a,b,floor,3,pz-floor)).cut(cylinder(a,b,1.5,1.05,pz))
  lid=lid.union(cylinder(a,b,7.5,3,top-7.5)).cut(cylinder(a,b,7,1.4,top)).cut(cylinder(a,b,top-1.8,2.5,2))
 usb=next(c for c in spec['connectors'] if c['kind']=='usb_c');ux=usb['position'][0]
 cut=box(ux-5.5,-5,6,11,9,6.5);base=base.cut(cut);lid=lid.cut(cut)
 jsts=[c for c in spec['connectors'] if c['kind']=='jst_ph3_vertical']
 for c in jsts:
  a,b=c['position'];lid=lid.cut(box(a-4.4,b-4.7,top-3,8.8,9.4,5))
 mx,my=spec['microphone']['position'];base=base.cut(cylinder(mx,my,-1,.9,4))
 for button in spec['buttons']:
  a,b=button['position'];z=9.1
  cut=box(a-1.9,-4.2,z-1.9,3.8,8,3.8);base=base.cut(cut);lid=lid.cut(cut)
  cap=box(a-1.5,-3.45,z-1.5,3,5.15,3,.3).union(box(a-2.5,-4.55,z-2.5,5,1.1,5,.5)).union(box(a-2.3,-.6,z-2.3,4.6,.7,4.6,.4))
  cq.exporters.export(cap,str(out/('button-'+button['ref'].split('.')[-1]+'.step')));mesh(button['ref'],cap,'button',product)
 for indicator in spec['indicators']:
  a,b=indicator['position'];lid=lid.cut(cylinder(a,b,top-3,1.1,5));pipe=cylinder(a,b,9,.9,top-9)
  mesh('lightpipe-'+str(a),pipe,'lightpipe',product);cq.exporters.export(pipe,str(out/('lightpipe-'+str(a)+'.step')))
 # Bottom microphone aperture; vents remain away from UWB/C6 antennas.
 lid=inlay(lid,w*.48,w/2,h/2,top,product,out)
 for name,q in [('base',base),('lid',lid)]:
  assert q.val().isValid() and len(q.val().Solids())==1
  cq.exporters.export(q,str(out/(name+'.step')));mesh(name,q,'shell_'+name,product)
 mesh('pcb',box(0,0,pz,w,h,1.6),'pcb',product)
 step(LIB/'Connector_USB.3dshapes/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.step','USB4105',product,'connector',(ux,2.225,7.4),split=True)
 for c in jsts:step('hardware/splanc_dev/elec/src/parts/JST_B3B_PH_K_S_LF__SN/CONN-TH_B3B-PH-K-S.step',c['ref'],product,'white_nylon',(*c['position'],7.4),90)
 return [W,H,top]

def max_parts():
 product='max';out=OUT/product;out.mkdir(exist_ok=True);root=Path('output/mechanical/max')
 j=json.load(open('hardware/splanc_max/interface.json'));w=j['boards']['power']['outline']['width_mm'];W=w+135;H=134;top=53;lx=w+25
 for name in ('base','lid'):
  q=cq.importers.importStep(str(root/(name+'.step')))
  if name=='lid':
   # Close only the central logo field; preserve cooling slots around it.
   q=inlay(q.union(box(W/2-43,H/2-15,50.2,86,30,2.8)),78,W/2,H/2,top,product,out)
  assert q.val().isValid() and len(q.val().Solids())==1
  cq.exporters.export(q,str(out/(name+'.step')));mesh(name,q,'shell_'+name,product)
 for name in ('power-pcb-envelope','lv-pcb-envelope'):
  step(root/(name+'.step'),name,product,'pcb')
 # Extract visible port solids from the official Pi geometry, retaining true dimensions.
 pi_path=Path('output/mechanical/sources/pi5/rpi-5b_no_graphics.step')
 pi_cache=Path('output/product-renders/pi5-visible-ports.step')
 if not pi_cache.exists():
  print('Extracting official Pi port solids',flush=True)
  shapes=[]
  for q in cq.importers.importStep(str(pi_path)).val().Solids():
   bb=q.BoundingBox()
   if bb.xmax>84 or bb.ymin<0 or bb.xmax<3:shapes.append(q)
  cq.exporters.export(cq.Compound.makeCompound(shapes),str(pi_cache))
 sources.append(dict(name='Raspberry Pi 5 official reference',path=str(pi_path),sha256=hashlib.sha256(pi_path.read_bytes()).hexdigest()))
 print('Tessellating Pi visible ports',flush=True)
 for i,q in enumerate(cq.importers.importStep(str(pi_cache)).val().Solids()):
  bb=q.BoundingBox();fill=q.Volume()/max(.001,bb.xlen*bb.ylen*bb.zlen)
  mat='pcb' if bb.xlen>80 and bb.ylen>50 else 'nickel' if fill<.4 else 'nylon'
  if q.Volume()<2:mat='gold'
  mesh('Pi-port-'+str(i),q.translate((lx,8,8)),mat,product)
 header='hardware/mechanical/assets/max-connectors/degson-2edgrc-3-header-normalized.step'
 components={c['ref']:c for c in json.load(open('hardware/splanc_max/design.json'))['boards']['power']['components']}
 for connector in (c for c in j['boards']['power']['connectors'] if c['kind']=='led_output3'):
  c=components[connector['ref']];x,y=c['position']
  step(header,'DEGSON-'+connector['ref'],product,'terminal',(7+x,7+y,9.6),c['rotation'])
 for p in root.glob('busbar-*.step'):step(p,p.stem,product,'copper')
 for yy in (52,82):
  lug_tab=box(3,yy-6,11,27,12,2).cut(cylinder(7,yy,10,2.65,4))
  mesh('busbar-lug-tab-'+str(yy),lug_tab,'copper',product);cq.exporters.export(lug_tab,str(out/('busbar-lug-tab-'+str(yy)+'.step')))
 # Real catalog M5 lug at each side access opening; revision discrepancy logged.
 for yy in (52,82):step('hardware/mechanical/assets/max-connectors/wurth-5580510.step','M5-lug-'+str(yy),product,'nickel',(7-22.5,yy,17.25),-90)
 return [W,H,53]

if __name__=='__main__':
 dims={'mini':mini_parts(),'splanc':splanc_parts(),'max':max_parts()}
 (OUT/'scene.json').write_text(json.dumps(dict(items=items,dimensions=dims,sources=sources)))
 print('Prepared',len(items),'real CAD mesh objects')
