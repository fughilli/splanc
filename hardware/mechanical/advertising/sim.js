import * as T from './vendor/three.module.js';
import {step,contact,random} from './physics.mjs';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
if(params.get('embed')==='1')document.body.classList.add('embed');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let running=!reduced.matches,visible=true,ready=false,bodies=[],models={},bounds={x:.6,y:.34},collisions=0,simtime=0;
const scene=new T.Scene(),camera=new T.OrthographicCamera(-.6,.6,.34,-.34,.01,10);
camera.position.set(0,0,2);camera.lookAt(0,0,0);
let renderer;
try{renderer=new T.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});}catch(e){$('fallback').style.display='block';$('message').textContent='3D is unavailable on this device.';throw e;}
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
$('stage').prepend(renderer.domElement);
scene.add(new T.HemisphereLight(0xe4efff,0x1b2538,2.6));
for(const [p,c,intensity] of [[[0,0,2],0xffffff,3],[[-1,1,1],0xb5d6ff,4],[[1,-1,.7],0xffedd1,2]]){const l=new T.DirectionalLight(c,intensity);l.position.set(...p);scene.add(l);}
const styles={shell_base:[0x14161a,.48,.05],shell_lid:[0x17191c,.48,.05],logo_white:[0xf6f4eb,.46,0],button:[0xffcf56,.55,0],nickel:[0xb4bec4,.28,.85],gold:[0xd6b75c,.32,.75],fastener:[0x87919b,.31,.85],nylon:[0x1a1d22,.55,0],white_nylon:[0xe9e7d8,.55,0],terminal:[0x223832,.55,0],lightpipe:[0x98d9c1,.35,.05],seal:[0x141414,.85,0],dc_red:[0xa81016,.4,0]};
async function load(sku){
 const compressed='DecompressionStream' in window;
 const [meta,buffer]=await Promise.all([fetch(`models/${sku}.json`).then(r=>{if(!r.ok)throw Error(r.status);return r.json();}),fetch(`models/${sku}.bin${compressed?'.gz':''}`).then(r=>{if(!r.ok)throw Error(r.status);return compressed?new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():r.arrayBuffer();})]);
 const root=new T.Group();
 for(const p of meta.parts){
  const g=new T.BufferGeometry(),inter=new T.InterleavedBuffer(new Float32Array(buffer,p.offset,p.vertices*6),6);
  g.setAttribute('position',new T.InterleavedBufferAttribute(inter,3,0));g.setAttribute('normal',new T.InterleavedBufferAttribute(inter,3,3));g.setIndex(new T.BufferAttribute(new Uint32Array(buffer,p.indexOffset,p.indices),1));g.computeBoundingSphere();
  const [color,roughness,metalness]=styles[p.material]||styles.nylon;
  const m=new T.MeshStandardMaterial({color,roughness,metalness});if(p.material==='lightpipe'){m.emissive.setHex(0x193f2e);m.emissiveIntensity=.3;}
  root.add(new T.Mesh(g,m));
 }
 return{root,size:meta.size};
}
function resize(){
 const w=innerWidth,h=innerHeight,aspect=w/h;
 bounds.y=Math.max(.29,.32/aspect);bounds.x=bounds.y*aspect;
 camera.left=-bounds.x;camera.right=bounds.x;camera.top=bounds.y;camera.bottom=-bounds.y;camera.updateProjectionMatrix();renderer.setSize(w,h);
}
function reset(){
 for(const b of bodies)scene.remove(b.object);bodies=[];collisions=0;simtime=0;const rng=random(Number(params.get('seed')||81026));
 const count=Math.max(3,Math.min(12,Number($('count').value)));let products=['mini','splanc','max'];
 while(products.length<count)products.push(rng()<.5?'mini':rng()<.85?'splanc':'max');
 // Largest assemblies placed first with conservative planar collision footprints.
 products.sort((a,b)=>models[b].size[0]-models[a].size[0]);
 for(const sku of products){
  const m=models[sku],object=m.root.clone(true);const hx=m.size[0]/2+.002,hy=(m.size[1]+m.size[2]*.3)/2+.002;
  const b={sku,object,hx,hy,mass:{mini:1,splanc:1.8,max:6}[sku],vx:(rng()-.5)*.13,vy:(rng()-.5)*.10,w:(rng()-.5)*1.2,a:0,x:0,y:0,phase:rng()*6.28};
  let placed=false;
  for(let attempt=0;attempt<1000;attempt++){
   b.a=(rng()-.5)*6.28;const r=Math.hypot(hx,hy);
   b.x=(rng()-.5)*Math.max(.001,(bounds.x-r)*1.85);b.y=(rng()-.5)*Math.max(.001,(bounds.y-r)*1.75);
   if(!bodies.some(other=>contact(b,other))){placed=true;break;}
  }
  if(!placed)continue;scene.add(object);bodies.push(b);
 }
 renderBodies();
}
function renderBodies(){for(const b of bodies){b.object.position.set(b.x,b.y,0);b.object.rotation.set(.24+Math.sin(simtime*.55+b.phase)*.10,Math.sin(simtime*.35+b.phase)*.10,b.a,'ZXY');}}
function pause(){running=!running;sync();}
function sync(){$('pause').textContent=running?'Pause':'Play';$('pause').setAttribute('aria-pressed',String(!running));}
$('pause').onclick=pause;$('restart').onclick=reset;$('count').onchange=reset;
addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','BUTTON'].includes(document.activeElement.tagName)){e.preventDefault();pause();}});
reduced.addEventListener('change',e=>{if(e.matches){running=false;sync();}});
document.addEventListener('visibilitychange',()=>visible=!document.hidden);
new IntersectionObserver(entries=>visible=entries[0].isIntersecting&&!document.hidden).observe(renderer.domElement);
addEventListener('resize',()=>{resize();if(ready)reset();});
let drag=null;
const pointer=e=>({x:(e.clientX/innerWidth*2-1)*bounds.x,y:(1-e.clientY/innerHeight*2)*bounds.y});
renderer.domElement.addEventListener('pointerdown',e=>{
 const p=pointer(e);let best;
 for(const b of bodies){const dx=p.x-b.x,dy=p.y-b.y,c=Math.cos(b.a),s=Math.sin(b.a);if(Math.abs(dx*c+dy*s)<b.hx&&Math.abs(-dx*s+dy*c)<b.hy)best=b;}
 if(best){renderer.domElement.setPointerCapture(e.pointerId);drag={b:best,last:p,time:performance.now()};}
});
renderer.domElement.addEventListener('pointermove',e=>{if(!drag)return;const p=pointer(e),dt=Math.max(.016,(performance.now()-drag.time)/1000);drag.b.x=p.x;drag.b.y=p.y;drag.b.vx=Math.max(-.35,Math.min(.35,(p.x-drag.last.x)/dt));drag.b.vy=Math.max(-.35,Math.min(.35,(p.y-drag.last.y)/dt));drag.last=p;drag.time=performance.now();renderBodies();});
for(const name of ['pointerup','pointercancel','lostpointercapture'])renderer.domElement.addEventListener(name,()=>drag=null);
renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();running=false;$('fallback').style.display='block';$('message').textContent='3D paused. Reload to resume.';sync();});
resize();sync();
Promise.all(['mini','splanc','max'].map(async k=>models[k]=await load(k))).then(()=>{
 new T.TextureLoader().load('models/environment.jpg',tex=>{tex.mapping=T.EquirectangularReflectionMapping;tex.colorSpace=T.SRGBColorSpace;scene.environment=tex;scene.environmentIntensity=.45;});
 ready=true;reset();$('message').textContent='';window.splancReady=true;
}).catch(e=>{$('message').textContent='Unable to load the 3D models. Reload to retry.';$('fallback').style.display='block';console.error(e);});
let prev=performance.now(),acc=0,frames=0,start=prev;
function tick(now){requestAnimationFrame(tick);const dt=Math.min(.05,(now-prev)/1000);prev=now;if(!ready||!visible)return;
 if(running&&!drag){acc+=dt*Number($('speed').value);while(acc>=1/120){collisions+=step(bodies,1/120,bounds);simtime+=1/120;acc-=1/120;}}
 renderBodies();renderer.render(scene,camera);frames++;
 window.splancStats={products:bodies.length,collisions,time:simtime,fps:frames*1000/(now-start),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,running};
}requestAnimationFrame(tick);
