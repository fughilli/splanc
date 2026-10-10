import * as T from './vendor/three.module.js';
import {PortLabels} from './port-labels.js';

// Render the selected assembly separately so its flight state stays untouched.
export class Inspector {
 constructor({renderer,camera,scene,bounds,reduced,onChange}){
  Object.assign(this,{renderer,camera,scene,bounds,reduced,onChange});
  this.overlay=new T.Scene();this.active=null;this.pointers=new Map();
  this.ray=new T.Raycaster();this.pointer=new T.Vector2();
  this.shade=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({color:0x05080d,transparent:true,opacity:0,depthWrite:false}));
  this.shade.position.z=-1;this.overlay.add(this.shade);
  for(const child of scene.children)if(child.isLight)this.overlay.add(child.clone());
  this.panel=document.getElementById('inspection');this.closeButton=document.getElementById('close-inspection');
  this.labels=new PortLabels(this.panel,camera);
  this.sensorButton=document.getElementById('sensor-toggle');this.note=document.getElementById('inspection-note');
  this.sensorButton.onclick=()=>this.toggleSensors();
  this.closeButton.onclick=()=>this.close();
  addEventListener('keydown',e=>{if(this.active&&e.key==='Escape'){e.preventDefault();this.close();}});
  const canvas=renderer.domElement;
  canvas.addEventListener('wheel',e=>{if(!this.active)return;e.preventDefault();this.zoom(Math.exp(-e.deltaY*.0015));},{passive:false});
 }
 hit(x,y){
  if(!this.active)return false;
  this.pointer.set(x/innerWidth*2-1,1-y/innerHeight*2);this.ray.setFromCamera(this.pointer,this.camera);
  this.active.object.updateMatrixWorld(true);
  return this.ray.intersectObject(this.active.object,true).length>0;
 }
 open(body){
  if(this.active)return;
  const object=body.object.clone(true);this.overlay.add(object);body.object.visible=false;
  const homeRotation=object.quaternion.clone();
  const presentation=new T.Quaternion().setFromEuler(new T.Euler(-.45,.20,innerWidth<innerHeight?Math.PI/2-.16:-.18,'ZXY'));
  object.quaternion.copy(presentation);object.updateMatrixWorld(true);
  const fitSize=new T.Box3().setFromObject(object).getSize(new T.Vector3());
  for(const mesh of object.children)if(mesh.userData.explode)mesh.position.fromArray(mesh.userData.explode);
  object.updateMatrixWorld(true);const explodedSize=new T.Box3().setFromObject(object).getSize(new T.Vector3());
  for(const mesh of object.children)mesh.position.set(0,0,0);
  object.quaternion.copy(homeRotation);
  this.active={body,object,phase:'entering',elapsed:0,homePosition:object.position.clone(),homeRotation,fitSize,explodedSize,zoom:1,shade:0,explode:0,explodeTarget:0,markers:[]};
  const radius=body.sku==='max'?.003:.0014;
  for(const sensor of body.sensors||[]){
   const marker=new T.Mesh(new T.RingGeometry(radius*.7,radius,24),new T.MeshBasicMaterial({color:0x9be9ce,side:T.DoubleSide,depthTest:false,transparent:true,opacity:.9}));
   marker.position.fromArray(sensor.position);marker.renderOrder=20;marker.visible=false;object.add(marker);
   this.active.markers.push({sensor,marker});
  }
  this.sensorButton.hidden=!body.sensors?.length;this.sensorButton.textContent='Sensors';this.sensorButton.setAttribute('aria-pressed','false');this.note.hidden=true;
  this.fit();this.begin(new T.Vector3(),presentation,this.active.fitScale,'entering');
  this.previousFocus=document.activeElement;this.panel.hidden=false;
  this.labels.open(body.ports||[]);
  document.getElementById('inspection-title').textContent={mini:'Splanc Mini',splanc:'Splanc / GNSS',max:'Splanc MAX'}[body.sku];
  this.closeButton.focus({preventScroll:true});this.onChange();
 }
 fit(){
  if(!this.active)return;
  const b=this.bounds(),a=this.active;
  const size=a.explodeTarget?a.explodedSize:a.fitSize;
  a.fitScale=Math.min(b.x*1.60/size.x,b.y*1.24/size.y);
  if(a.phase==='entering')a.toScale=a.fitScale;
  this.shade.scale.set(b.x*2,b.y*2,1);
 }
 toggleSensors(){
  const a=this.active;if(a?.phase!=='inspecting')return;
  a.explodeTarget=a.explodeTarget?0:1;a.zoom=1;this.fit();
  this.sensorButton.setAttribute('aria-pressed',String(!!a.explodeTarget));this.sensorButton.textContent=a.explodeTarget?'Close case':'Sensors';
  this.note.textContent=a.body.note||'';this.note.hidden=!a.explodeTarget;
  this.labels.open(a.explodeTarget?a.body.sensors:a.body.ports,id=>{
   for(const {sensor,marker} of a.markers){marker.material.color.setHex(sensor.id===id?0xffdc8b:0x9be9ce);marker.scale.setScalar(sensor.id===id?1.5:1);}
  });
 }
 begin(position,rotation,scale,phase){
  const a=this.active;Object.assign(a,{phase,elapsed:0,fromPosition:a.object.position.clone(),fromRotation:a.object.quaternion.clone(),fromScale:a.object.scale.x,fromShade:a.shade,toPosition:position,toRotation:rotation,toScale:scale});
 }
 close(){
  if(!this.active||this.active.phase==='returning')return;
  this.pointers.clear();const a=this.active;
  a.explodeTarget=0;this.note.hidden=true;
  this.begin(a.homePosition,a.homeRotation,1,'returning');this.onChange();
 }
 zoom(factor){
  if(this.active?.phase!=='inspecting')return;
  this.active.zoom=Math.max(.5,Math.min(2.7,this.active.zoom*factor));
 }
 down(e){
  if(!this.active)return;
  this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false,onObject:this.hit(e.clientX,e.clientY)});
  if(this.pointers.size>1)for(const p of this.pointers.values())p.moved=true;
  this.renderer.domElement.setPointerCapture(e.pointerId);
 }
 move(e){
  const a=this.active,p=this.pointers.get(e.pointerId);if(!a||!p)return;
  const dx=e.clientX-p.x,dy=e.clientY-p.y;
  if(Math.hypot(e.clientX-p.startX,e.clientY-p.startY)>6)p.moved=true;
  if(a.phase==='inspecting'){
   if(this.pointers.size===2){
    const other=[...this.pointers.values()].find(q=>q!==p);
    const before=Math.hypot(p.x-other.x,p.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y);
    if(before>8)this.zoom(after/before);
   }else if(p.onObject&&p.moved){
    const turn=new T.Quaternion().setFromEuler(new T.Euler(dy*.007,dx*.007,0,'YXZ'));
    a.object.quaternion.premultiply(turn).normalize();
   }
  }
  p.x=e.clientX;p.y=e.clientY;
 }
 up(e,cancelled=false){
  const p=this.pointers.get(e.pointerId);this.pointers.delete(e.pointerId);
  if(p&&!cancelled&&!p.moved&&!p.onObject&&this.active?.phase==='inspecting')this.close();
 }
 update(dt){
  const a=this.active;if(!a)return;
  a.explode=T.MathUtils.lerp(a.explode,a.explodeTarget,this.reduced.matches?1:1-Math.exp(-dt*9));
  if(Math.abs(a.explode-a.explodeTarget)<.001)a.explode=a.explodeTarget;
  for(const mesh of a.object.children){
   if(mesh.userData.explode)mesh.position.fromArray(mesh.userData.explode).multiplyScalar(a.explode);
   if(mesh.userData.interior)mesh.visible=a.explode>.02;
  }
  for(const {marker} of a.markers)marker.visible=a.explode>.7&&a.explodeTarget===1;
  this.sensorButton.disabled=a.phase!=='inspecting';
  if(a.phase==='inspecting'){
   const target=a.fitScale*a.zoom;
   a.object.scale.setScalar(T.MathUtils.lerp(a.object.scale.x,target,this.reduced.matches?1:1-Math.exp(-dt*14)));
  }else{
   a.elapsed+=dt;const t=this.reduced.matches?1:Math.min(1,a.elapsed/.65),s=t*t*(3-2*t);
   a.object.position.lerpVectors(a.fromPosition,a.toPosition,s);
   a.object.quaternion.slerpQuaternions(a.fromRotation,a.toRotation,s);
   a.object.scale.setScalar(T.MathUtils.lerp(a.fromScale,a.toScale,s));
   a.shade=T.MathUtils.lerp(a.fromShade,a.phase==='entering'?.91:0,s);
   if(t===1){
    if(a.phase==='returning'){
     for(const {marker} of a.markers){marker.geometry.dispose();marker.material.dispose();}
     a.body.object.visible=true;this.overlay.remove(a.object);this.active=null;this.panel.hidden=true;this.labels.clear();
     this.previousFocus?.focus({preventScroll:true});this.onChange();return;
    }
    a.phase='inspecting';
   }
  }
  this.shade.material.opacity=a.shade;
  this.labels.update(a.object,a.phase==='inspecting'&&(!a.explodeTarget||a.explode>.9));
 }
 render(){
  if(!this.active)return;
  this.overlay.environment=this.scene.environment;this.overlay.environmentIntensity=this.scene.environmentIntensity;
  this.renderer.autoClear=false;this.renderer.clearDepth();this.renderer.render(this.overlay,this.camera);this.renderer.autoClear=true;
 }
 stats(){
  const a=this.active;return a?{sku:a.body.sku,phase:a.phase,zoom:a.zoom,sensors:!!a.explodeTarget,explosion:a.explode,sensorCount:a.body.sensors?.length||0,rotation:a.object.quaternion.toArray(),position:a.object.position.toArray(),scale:a.object.scale.x}:null;
 }
}
