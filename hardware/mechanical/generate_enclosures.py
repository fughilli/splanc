"""Board-interface-driven enclosure solids and assembly STEP (millimetres)."""
import argparse,json,hashlib,math
from pathlib import Path
import cadquery as cq

def box(x,y,z,w,d,h,r=0):
 q=cq.Workplane('XY').box(w,d,h,centered=False)
 if r:q=q.edges('|Z').fillet(min(r,w/3,d/3))
 return q.translate((x,y,z))
def cylinder(x,y,z,r,h):return cq.Workplane('XY').center(x,y).circle(r).extrude(h).translate((0,0,z))
def ring(x,y,z,w,d,h,th,r=0):return box(x,y,z,w,d,h,r).cut(box(x+th,y+th,z-.1,w-2*th,d-2*th,h+.2,max(0,r-th)))
def board_shape(spec,origin):
 x,y,z=origin;o=spec['outline'];q=box(x,y,z,o['width_mm'],o['height_mm'],o['thickness_mm'],1)
 for p in spec['mounts']:q=q.cut(cylinder(x+p['x'],y+p['y'],z-.1,p['diameter_mm']/2,o['thickness_mm']+.2))
 return q

def populated(spec,origin):
 shapes=[board_shape(spec,origin).val()];ox,oy,oz=origin;th=spec['outline']['thickness_mm']
 for c in spec.get('components',[]):
  if c['ref'].startswith(('MH','TP','J','CN','USB','SW','LED')) or not c.get('pads'):continue
  pads=c['pads'];xs=[p['position'][0] for p in pads];ys=[p['position'][1] for p in pads]
  w=max(.6,max(xs)-min(xs));d=max(.6,max(ys)-min(ys));height=2.3 if c['ref'].startswith('U') else 1.0
  if c['ref'].startswith('L'):height=4.0
  if max(w,d)>22:height=3.0
  z=oz+th if c.get('side')!='bottom' else oz-height
  shapes.append(box(ox+(max(xs)+min(xs))/2-w/2,oy+(max(ys)+min(ys))/2-d/2,z,w,d,height).val())
 return cq.Workplane('XY').newObject([cq.Compound.makeCompound(shapes)])

def render(parts,path,title,explode=False):
 import numpy as np
 from PIL import Image,ImageDraw,ImageFont
 # Software orthographic render of actual solid tessellations, no AI imagery.
 polys=[];camera=np.array([[.81,.59,0],[.30,-.41,-.86],[.51,-.70,.50]])
 for name,part,color,offset in parts:
  delta=np.array(offset if explode else (0,0,0));verts,faces=part.val().tessellate(.35,.3)
  vs=np.array([[v.x,v.y,v.z] for v in verts])+delta
  if not len(vs):continue
  projected=vs@camera.T
  for face in faces:
   ids=list(face);pts=vs[ids];n=np.cross(pts[1]-pts[0],pts[2]-pts[0]);n=n/(np.linalg.norm(n)+1e-9)
   shade=.60+.32*abs(n@np.array([-.3,-.45,.84]));rgb=tuple(int(min(255,c*shade)) for c in color)
   polys.append((projected[ids,2],projected[ids,:2],rgb))
 allxy=np.concatenate([p[1] for p in polys]);lo=allxy.min(0);hi=allxy.max(0);scale=min(1400/(hi[0]-lo[0]),820/(hi[1]-lo[1]));center=(lo+hi)/2
 pixels=np.full((1100,1600,3),(235,239,243),dtype=np.uint8);depth=np.full((1100,1600),-np.inf,dtype=np.float32)
 # Per-pixel depth testing prevents painter-order artefacts around holes/posts.
 for zavg,pts,color in polys:
  q=(pts-center)*scale+[800,575]
  x0=max(0,int(q[:,0].min()));x1=min(1599,int(q[:,0].max())+1);y0=max(0,int(q[:,1].min()));y1=min(1099,int(q[:,1].max())+1)
  if x1<x0 or y1<y0:continue
  xx=np.arange(x0,x1+1)[None,:]+.5;yy=np.arange(y0,y1+1)[:,None]+.5
  a,b,c=q;den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
  if abs(den)<1e-9:continue
  u=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/den
  v=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/den;w=1-u-v
  zz=u*zavg[0]+v*zavg[1]+w*zavg[2]
  region=depth[y0:y1+1,x0:x1+1];mask=(u>=-1e-8)&(v>=-1e-8)&(w>=-1e-8)&(zz>region)
  region[mask]=zz[mask];pixels[y0:y1+1,x0:x1+1][mask]=color
 im=Image.fromarray(pixels);d=ImageDraw.Draw(im)
 try:f=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',30);small=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',18)
 except OSError:f=small=ImageFont.load_default()
 d.text((55,35),title,fill=(22,39,58),font=f);d.text((55,80),'Engineering CAD study | actual enclosure solids | component envelopes simplified | dimensions in mm',fill=(65,80,96),font=small)
 im.save(path)

def save_product(out,name,parts,checks,views):
 folder=out/name;folder.mkdir(parents=True,exist_ok=True);assembly=cq.Assembly(name=name);records=[]
 for label,shape,color,offset in parts:
  assert shape.val().isValid(),label
  f=folder/(label+'.step');cq.exporters.export(shape,str(f));b=shape.val().BoundingBox();v=shape.val().Volume()
  assert v>0,label
  records.append(dict(name=label,file=f.name,dimensions_mm=[b.xlen,b.ylen,b.zlen],volume_mm3=v,valid=True,sha256=hashlib.sha256(f.read_bytes()).hexdigest()))
  assembly.add(shape,name=label,color=cq.Color(*(c/255 for c in color)))
 assembly.export(str(folder/(name+'-assembly.step')))
 for view,subset,exploded in views:render(subset,folder/(view+'.png'),name.upper()+' / '+view.replace('-',' '),exploded)
 (folder/'manifest.json').write_text(json.dumps(dict(parts=records,checks=checks,status='engineering prototype; not production tooling',views=[x[0]+'.png' for x in views]),indent=2))
 return records

def mini(spec,ports,out):
 o=spec['outline'];w,h=o['width_mm'],o['height_mm'];clear=1.;wall=2.2;x=y=-clear-wall;W=w-2*x;H=h-2*y;floor=2.2;pcb_z=5.8;split=9.;top=20.
 base=box(x,y,0,W,H,split,3).cut(box(-clear,-clear,floor,w+2*clear,h+2*clear,split,1))
 lid=box(x,y,split,W,H,top-split,3).cut(box(-clear,-clear,split-.1,w+2*clear,h+2*clear,top-wall-split+.1,1))
 lid=lid.union(ring(-.75,-.75,split-1.4,w+1.5,h+1.5,1.5,.6,1)).union(ring(-1.1,-1.1,split,w+2.2,h+2.2,.8,.95,1))
 lid=lid.cut(box(7.75,h+.05,split-1.5,19,1.0,2.5)) # Radio model rear overhang.
 for p in spec['mounts']:
  a,b=p['x'],p['y'];base=base.union(cylinder(a,b,floor,3,pcb_z-floor));base=base.cut(cylinder(a,b,1.5,1.05,pcb_z))
  lid=lid.union(cylinder(a,b,pcb_z+o['thickness_mm']+1.7,3,top-pcb_z-o['thickness_mm']-1.7));lid=lid.cut(cylinder(a,b,pcb_z,1.4,top)).cut(cylinder(a,b,top-1.8,2.5,2.0))
 parts=[];byref={c['ref']:c for c in spec['components']};cutouts=[]
 for p in ports['ports']:
  if not p.get('expose_in_enclosure',True):continue
  c=byref[p['ref']];a,b=c['position'];pw,ph=p['opening'];z=pcb_z+p['center_z_above_pcb_mm'];edge=p['edge']
  if edge=='south':cut=box(a-pw/2,y-1,z-ph/2,pw,8,ph)
  else:cut=box(a-pw/2,b-ph/2,-1 if edge=='bottom' else top-wall-.1,pw,ph,floor+2 if edge=='bottom' else wall+1)
  base=base.cut(cut);lid=lid.cut(cut);cutouts.append(dict(ref=p['ref'],position=[a,b,z],edge=edge,size=p['opening']))
  if p['ref'].startswith('SW'):
   # External shoulder stops travel at0.25mm; internal flange retains the stem.
   button=box(a-1.5,y-.25,z-1.5,3,5.15,3,.3).union(box(a-2.5,y-1.35,z-2.5,5,1.1,5,.5)).union(box(a-2.3,-.6,z-2.3,4.6,.7,4.6,.4))
   parts.append(('button-'+p['ref'],button,(41,179,188),(0,-7,0)))
  if p['ref'].startswith('LED'):
   parts.append(('lightpipe-'+p['ref'],cylinder(a,b,pcb_z+2.3,.9,top-pcb_z-2.3),(123,224,207),(0,0,12)))
 # Pressure equalization vent at rear clear of screws; antenna remains plastic-only.
 for a in (w/2-2,w/2,w/2+2):lid=lid.cut(cylinder(a,h-3,top-3,.55,4))
 pcb=board_shape(spec,(0,0,pcb_z));parts=[('base',base,(65,81,101),(0,0,-5)),('lid',lid,(202,218,231),(0,0,28)),('pcb-envelope',populated(spec,(0,0,pcb_z)),(38,124,104),(0,0,8)),*parts]
 assert base.intersect(lid).val().Volume()<.01
 assert base.intersect(pcb).val().Volume()<.01 and lid.intersect(pcb).val().Volume()<.01
 checks=dict(outside_mm=[W,H,top],wall_mm=wall,pcb_bottom_z=pcb_z,source_sha256=spec['sha256'],mounts=spec['mounts'],cutouts=cutouts,base_lid_overlap_mm3=base.intersect(lid).val().Volume(),board_envelope_clear=True,assembly='Four M2.5 thread-forming screws with 1.7mm upper spacers; length/pilot require print trials',pending=['Cable plug fit','Button tolerance/travel fit','Light-pipe brightness','Injection molding draft and tooling review'])
 return save_product(out,'mini',parts,checks,[('assembled',parts,False),('exploded',parts,True),('base-interior',[p for p in parts if p[0]!='lid'],False)])

def max_case(interface,out):
 lv=interface['boards']['lv'];power=interface['boards']['power'];pw=power['outline']['width_mm'];ph=power['outline']['height_mm'];lx=pw+25;ly=8;px=7;py=7;W=lx+lv['outline']['width_mm']+25;H=max(ph+14,72);wall=2.8;floor=2.5;top=53;split=47;pcb_z=8;hat_z=36
 base=box(0,0,0,W,H,split,5).cut(box(wall,wall,floor,W-2*wall,H-2*wall,split,2))
 lid=box(0,0,split,W,H,top-split,5).cut(box(wall,wall,split-.1,W-2*wall,H-2*wall,top-wall-split+.1,2));lid=lid.union(ring(wall+.3,wall+.3,split-1.8,W-2*wall-.6,H-2*wall-.6,2,.9,2)).union(ring(wall-.1,wall-.1,split,W-2*wall+.2,H-2*wall+.2,.8,1.3,2))
 pi=dict(outline=dict(width_mm=85,height_mm=56,thickness_mm=1.6),mounts=lv['mounts'])
 components=[('power-pcb-envelope',populated(power,(px,py,pcb_z)),(29,117,95),(0,0,8)),('pi5-pcb-envelope',board_shape(pi,(lx,ly,pcb_z)),(32,128,84),(0,0,5)),('lv-pcb-envelope',populated(lv,(lx,ly,hat_z)),(35,119,126),(0,0,18))]
 for spec,origin in ((power,(px,py,pcb_z)),(pi,(lx,ly,pcb_z))):
  for p in spec['mounts']:
   a,b=origin[0]+p['x'],origin[1]+p['y'];base=base.union(cylinder(a,b,floor,3.6,pcb_z-floor)).cut(cylinder(a,b,1.4,1.25,pcb_z))
 for p in lv['mounts']:
  a,b=lx+p['x'],ly+p['y'];post=cylinder(a,b,pcb_z+1.6,2.8,hat_z-pcb_z-1.6).cut(cylinder(a,b,pcb_z,1.35,hat_z))
  components.append(('hat-standoff-'+str(len(components)),post,(185,173,140),(0,0,10)))
 # Case fasteners lie outside board areas.
 for a,b in ((4,4),(W-4,4),(4,H-4),(W-4,H-4),(W/2,4),(W/2,H-4)):
  base=base.union(cylinder(a,b,floor,3,split-floor)).cut(cylinder(a,b,split-12,1.25,15));lid=lid.cut(cylinder(a,b,split-2.1,3.3,2.1)).cut(cylinder(a,b,split-2,1.75,10)).cut(cylinder(a,b,top-2,3,3))
 cutouts=[]
 for c in power['connectors']:
  a,b=px+c['position'][0],py+c['position'][1];edge=c['edge'];cw,ch=c['opening'];z=pcb_z+c['center_z_above_pcb_mm']
  if edge=='internal':continue
  if edge in ('north','south'):cut=box(a-cw/2,-1 if edge=='south' else H-14,z-ch/2,cw,15,ch)
  elif edge=='west':cut=box(-1,b-cw/2,z-ch/2,16,cw,ch)
  else:continue
  base=base.cut(cut);cutouts.append(dict(ref=c['ref'],center=[a,b,z],edge=edge,opening=c['opening']))
  # Simplified connector mating/body envelopes, never manufacturer CAD substitutes.
  if edge in ('north','south'):shape=box(a-cw/2,b-5,pcb_z+1.6,cw,10,8)
  else:shape=box(a-4,b-cw/2,pcb_z+1.6,8,cw,8)
  components.append(('connector-'+c['ref'],shape,(65,137,91),(0,0,8)))
 # Pi side service windows: recessed tunnels clear normal plugs;USBbridge own bay.
 for a,width in ((11.2,12),(25.8,9),(39.2,9)):
  base=base.cut(box(lx+a-width/2,-1,pcb_z+1, width,ly+3,6))
 for b,width,height in ((10.2,19,17),(29.1,17,18),(47,17,18)):
  base=base.cut(box(lx+80,ly+b-width/2,pcb_z+1, W-lx-79,width,height))
 # MicroSD service opening and Pi power-button access.
 base=base.cut(box(lx-1,ly+22,pcb_z-3,6,16,4))
 # Vent slots over power stage and Pi cooler; ribs between slots retained.
 for a in range(25,int(pw)-15,8):lid=lid.cut(box(a,35,top-4,3,ph-56,6,1))
 for a in range(int(lx+10),int(lx+66),6):lid=lid.cut(box(a,ly+12,top-4,2.4,32,6,1))
 for a in range(25,int(pw)-15,10):base=base.cut(box(a,32,-1,3,ph-50,floor+2,1))
 # Low separating rib keeps ribbon away from busbar terminal hardware.
 base=base.union(box(px+pw+8,wall,floor,2,H-2*wall,10))
 # Cooler keepout and ribbon are translucent-colour envelopes in STEP/render.
 components.append(('active-cooler-envelope',box(lx+8,ly+7,pcb_z+1.6,63.5,42.5,13.7,2),(160,170,179),(0,0,12)))
 rx,ry=px+28,py+60; tx,ty=lx+65,ly+12
 ribbon=box(0,-16,43,math.hypot(tx-rx,ty-ry),32,1.2).rotate((0,0,0),(0,0,1),math.degrees(math.atan2(ty-ry,tx-rx))).translate((rx,ry,0))
 components.append(('ribbon-clearance-envelope',ribbon,(201,142,71),(0,0,18)))
 # Vertical rigid jumper planeYZ;male shells point back towardsPi/HAT.
 bridge_x=lx+98;bridge_y=ly+29.1;hi=hat_z+2;lo=hi-26.4
 bridge_spec=interface['boards']['usb_bridge']['outline']
 bridge=box(bridge_x,bridge_y-bridge_spec['width_mm']/2,lo-7,bridge_spec['thickness_mm'],bridge_spec['width_mm'],bridge_spec['height_mm'])
 components.append(('usb-jumper-pcb-envelope',bridge,(34,119,117),(12,0,12)))
 for label,z,width,height in [('A',lo,12,4.5),('C',hi,8.4,2.8)]:components.append(('usb-male-'+label+'-envelope',box(lx+83,bridge_y-width/2,z-height/2,15,width,height),(180,185,191),(12,0,12)))
 # Busbar solids from electrical contract; holesforboltedlugs andbondingstuds.
 for i,b in enumerate(interface['power'].get('busbars',[])):
  pos=[b['x'],b['y']];size=[b['length_mm'],b['width_mm'],b['thickness_mm']];bar=box(px+pos[0],py+pos[1],pcb_z+3,*size)
  for a in (pos[0]+4,pos[0]+size[0]-4):bar=bar.cut(cylinder(px+a,py+pos[1]+size[1]/2,pcb_z+2,2.6,5))
  components.append(('busbar-'+str(i+1),bar,(183,111,55),(0,0,12)))
 parts=[('base',base,(65,81,101),(0,0,-8)),('lid',lid,(204,218,230),(0,0,40)),*components]
 overlap=base.intersect(lid).val().Volume();assert overlap<.01,overlap
 pcb_clear={name:base.intersect(shape).val().Volume() for name,shape,_,_ in components if 'pcb-envelope' in name};assert all(v<.01 for v in pcb_clear.values()),pcb_clear
 checks=dict(outside_mm=[W,H,top],wall_mm=wall,board_origins_mm=dict(power=[px,py,pcb_z],pi=[lx,ly,pcb_z],lv=[lx,ly,hat_z]),base_lid_overlap_mm3=overlap,pcb_base_overlap_mm3=pcb_clear,cutouts=cutouts,thermal='Ventilated; full-load thermal test required',pending=['USB male and socket exact mating stack','Pi official model comparison','Lug insulating guard and torque','Cable strain relief','Production draft/ribs/thermal qualification'])
 return save_product(out,'max',parts,checks,[('assembled',parts,False),('exploded',parts,True),('base-interior',[p for p in parts if p[0]!='lid'],False)])

def main():
 p=argparse.ArgumentParser();p.add_argument('--mini',type=Path,required=True);p.add_argument('--mini-ports',type=Path,default=Path('hardware/mechanical/mini-ports.json'));p.add_argument('--max',type=Path,required=True);p.add_argument('--max-lv',type=Path);p.add_argument('--max-power',type=Path);p.add_argument('--out',type=Path,default=Path('output/mechanical'));a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
 mini(json.loads(a.mini.read_text()),json.loads(a.mini_ports.read_text()),a.out)
 mx=json.loads(a.max.read_text())
 for name,path in [('lv',a.max_lv),('power',a.max_power)]:
     if path:
         native=json.loads(path.read_text());assert native['outline']==mx['boards'][name]['outline'], 'Native board/interface mismatch'
         mx['boards'][name]['components']=native['components'];mx['boards'][name]['source_sha256']=native['sha256']
 max_case(mx,a.out)
if __name__=='__main__':main()
