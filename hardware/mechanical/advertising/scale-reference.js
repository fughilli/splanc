import * as T from './vendor/three.module.js';

// ISO/IEC 7810 ID-1. Units match the CAD meshes: metres.
// https://committee.iso.org/standard/31432.html?browse=ics
export const CARD_SIZE=[.08560,.05398,.00076];
const mm=value=>(value*1000).toFixed(1).replace(/\.0$/,'');
const svgNode=name=>document.createElementNS('http://www.w3.org/2000/svg',name);
function roundedRectangle(w,h,r){
 const s=new T.Shape(),x=-w/2,y=-h/2;
 s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);
 s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
 s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);
 s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s;
}
function cardTexture(){
 const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=646;
 const c=canvas.getContext('2d');c.fillStyle='#243c4f';c.fillRect(0,0,1024,646);
 c.strokeStyle='#597082';c.lineWidth=2;c.strokeRect(36,36,952,574);
 c.fillStyle='#dce9ed';c.font='500 47px system-ui';c.fillText('Credit card',68,111);
 c.fillStyle='#9eb4c2';c.font='29px system-ui';c.fillText('SIZE REFERENCE',68,156);
 c.fillStyle='#b2a485';c.beginPath();c.roundRect(72,234,146,111,14);c.fill();
 c.strokeStyle='#6b6356';c.lineWidth=3;for(const y of [271,308]){c.beginPath();c.moveTo(72,y);c.lineTo(218,y);c.stroke();}
 for(const x of [120,170]){c.beginPath();c.moveTo(x,234);c.lineTo(x,345);c.stroke();}
 c.fillStyle='#dce9ed';c.font='40px system-ui';c.fillText('85.60 × 53.98 mm',68,523);
 c.fillStyle='#9eb4c2';c.font='25px system-ui';c.fillText('SHOWN AT THE SAME SCALE',68,570);
 const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;return texture;
}
export class ScaleReference {
 constructor(panel,camera,box,size){
  this.camera=camera;this.size=size;this.enabled=true;this.group=new T.Group();this.group.name='credit-card-reference';
  const [w,h,thickness]=CARD_SIZE,shape=roundedRectangle(w,h,.003);
  const geometry=new T.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false,curveSegments:12});geometry.translate(0,0,-thickness/2);
  const card=new T.Mesh(geometry,new T.MeshStandardMaterial({color:0x304a5c,roughness:.68}));this.group.add(card);
  const face=new T.ShapeGeometry(shape,12),uv=face.attributes.uv,positions=face.attributes.position;
  for(let i=0;i<positions.count;i++)uv.setXY(i,positions.getX(i)/w+.5,positions.getY(i)/h+.5);
  this.texture=cardTexture();const print=new T.Mesh(face,new T.MeshStandardMaterial({map:this.texture,roughness:.75,side:T.DoubleSide}));
  print.position.z=thickness/2+.00001;this.group.add(print);
  // Beside the assembly in its own XY plane, never covering its connectors.
  this.group.position.set(box.getCenter(new T.Vector3()).x,box.min.y-.016-h/2,box.min.z+thickness/2);
  this.localBox=new T.Box3(new T.Vector3(-w/2,-h/2,-thickness/2),new T.Vector3(w/2,h/2,thickness/2)).translate(this.group.position);
  this.root=document.createElement('div');this.root.id='scale-reference-labels';this.root.hidden=true;panel.append(this.root);
  this.svg=svgNode('svg');this.svg.setAttribute('aria-hidden','true');this.root.append(this.svg);
  const lo=box.min,hi=box.max,g=.009;
  const dimensions=[
   {axis:'Width',value:size[0],a:[lo.x,hi.y+g,hi.z],b:[hi.x,hi.y+g,hi.z],from:[lo.x,hi.y,hi.z],to:[hi.x,hi.y,hi.z]},
   {axis:'Depth',value:size[1],a:[lo.x-g,lo.y,hi.z],b:[lo.x-g,hi.y,hi.z],from:[lo.x,lo.y,hi.z],to:[lo.x,hi.y,hi.z]},
   {axis:'Height',value:size[2],a:[hi.x+g,lo.y,lo.z],b:[hi.x+g,lo.y,hi.z],from:[hi.x,lo.y,lo.z],to:[hi.x,lo.y,hi.z]},
  ];
  this.entries=dimensions.map(d=>{
   const path=svgNode('path');this.svg.append(path);const label=document.createElement('span');label.className='dimension-label';
   label.textContent=`${d.axis} ${mm(d.value)} mm`;this.root.append(label);return {...d,path,label};
  });
  this.caption=document.createElement('div');this.caption.className='dimension-summary';
  this.caption.textContent=`${size.map(mm).join(' × ')} mm · overall W × D × H`;this.root.append(this.caption);
 }
 bounds(){return this.localBox.clone();}
 setEnabled(enabled){this.enabled=enabled;this.group.visible=enabled;if(!enabled)this.root.hidden=true;}
 update(object,show,explode=0){
  this.opacity=this.enabled&&show?Math.max(0,1-explode):0;
  this.group.visible=this.opacity>.002;this.root.hidden=!this.group.visible;this.root.style.opacity=this.opacity;
  this.group.traverse(o=>{if(o.material){o.material.transparent=true;o.material.opacity=this.opacity;}});
  if(this.root.hidden)return;
  object.updateMatrixWorld(true);this.svg.setAttribute('viewBox',`0 0 ${innerWidth} ${innerHeight}`);
  const project=p=>{const v=object.localToWorld(new T.Vector3(...p)).project(this.camera);return {x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};};
  for(const e of this.entries){
   const a=project(e.a),b=project(e.b),p=project(e.from),q=project(e.to),length=Math.hypot(b.x-a.x,b.y-a.y);
   const nx=-(b.y-a.y)/Math.max(1,length),ny=(b.x-a.x)/Math.max(1,length),tick=4;
   e.path.setAttribute('d',`M${p.x},${p.y} L${a.x},${a.y} L${b.x},${b.y} L${q.x},${q.y} M${a.x-nx*tick},${a.y-ny*tick} l${nx*tick*2},${ny*tick*2} M${b.x-nx*tick},${b.y-ny*tick} l${nx*tick*2},${ny*tick*2}`);
   const x=(a.x+b.x)/2+nx*15,y=(a.y+b.y)/2+ny*15;
   // Edge-on dimensions remain readable in the overall-size caption.
   e.label.hidden=length<12||x<55||x>innerWidth-55||y<174||y>innerHeight-55;
   e.label.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;
  }
 }
 dispose(){
  this.root.remove();this.group.removeFromParent();this.texture.dispose();
  this.group.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
 }
 stats(){return {enabled:this.enabled,visible:this.group.visible,opacity:this.opacity||0,cardMillimeters:CARD_SIZE.map(v=>v*1000),productMillimeters:this.size.map(v=>Number((v*1000).toFixed(1)))};}
}
