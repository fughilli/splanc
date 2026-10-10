import * as T from './vendor/three.module.js';
import {CalloutLayout} from './callout-layout.mjs';
export class PortLabels {
 constructor(panel,camera){
  this.layout=new CalloutLayout();this.camera=camera;this.root=document.createElement('div');this.root.id='port-labels';panel.append(this.root);
  this.svg=document.createElementNS('http://www.w3.org/2000/svg','svg');this.svg.classList.add('port-leaders');this.root.append(this.svg);this.entries=[];
 }
 clear(){for(const e of this.entries){e.card.remove();e.line.remove();}this.entries=[];}
 open(ports,onSelect=()=>{}){
  this.clear();
  for(const port of ports){
   const card=document.createElement('div');card.className='port-callout';
   const button=document.createElement('button');button.setAttribute('aria-expanded','false');button.setAttribute('aria-label','About '+port.label);
   const detail=document.createElement('p');
   const title=document.createElement('strong');title.textContent=port.label;
   const description=document.createElement('span');description.textContent=port.description;detail.append(title,description);detail.hidden=true;detail.id='port-detail-'+port.id;button.setAttribute('aria-controls',detail.id);
   card.append(button,detail);this.root.append(card);
   const line=document.createElementNS('http://www.w3.org/2000/svg','line');this.svg.append(line);
   const entry={port,card,button,detail,line,width:0,height:0};this.entries.push(entry);
   button.onclick=()=>{
    const expand=detail.hidden;
    for(const e of this.entries){e.detail.hidden=true;e.button.setAttribute('aria-expanded','false');e.width=0;}
    detail.hidden=!expand;button.setAttribute('aria-expanded',String(expand));entry.width=0;onSelect(expand?port.id:null);
   };
  }
 }
 update(object,show,dt,reduced=false){
  this.root.hidden=!show;if(!show)return;
  if(this.lastWidth!==innerWidth){for(const e of this.entries)e.width=0;this.lastWidth=innerWidth;}
  object.updateMatrixWorld(true);this.svg.setAttribute('viewBox',`0 0 ${innerWidth} ${innerHeight}`);
  const visibleEntries=[];
  for(const e of this.entries){
   const point=object.localToWorld(new T.Vector3(...e.port.position));
   const normal=new T.Vector3(...e.port.normal).applyQuaternion(object.quaternion);
   // Hysteresis prevents the same edge-facing port blinking on/off during orbit.
   const visible=normal.z>(e.visible?-.24:-.12);e.visible=visible;
   e.card.hidden=!visible;e.line.style.display=visible?'':'none';if(!visible)continue;
   point.project(this.camera);const x=(point.x+1)*innerWidth/2,y=(1-point.y)*innerHeight/2;
   if(!e.width){e.width=e.card.offsetWidth;e.height=e.card.offsetHeight;}
   e.anchor={x,y};
   const dx=normal.x+.35*(x-innerWidth/2)/(innerWidth/2);
   const dy=-normal.y+.35*(y-innerHeight/2)/(innerHeight/2);
   const length=Math.sqrt(dx*dx+dy*dy+.09);
   e.preferred={x:x+72*dx/length,y:y+72*dy/length};
   visibleEntries.push(e);
  }
  this.layout.update(visibleEntries,{left:26,right:innerWidth-26,top:164,bottom:innerHeight-56},dt,reduced);
  for(const e of visibleEntries){
   e.card.style.transform=`translate(${e.display.x-20}px,${e.display.y-20}px)`;
   for(const [k,v] of Object.entries({x1:e.anchor.x,y1:e.anchor.y,x2:e.display.x,y2:e.display.y}))e.line.setAttribute(k,v);
  }
 }
}
