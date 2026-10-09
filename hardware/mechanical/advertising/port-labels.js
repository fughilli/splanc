import * as T from './vendor/three.module.js';
export class PortLabels {
 constructor(panel,camera){
  this.camera=camera;this.root=document.createElement('div');this.root.id='port-labels';panel.append(this.root);
  this.svg=document.createElementNS('http://www.w3.org/2000/svg','svg');this.svg.classList.add('port-leaders');this.root.append(this.svg);this.entries=[];
 }
 clear(){for(const e of this.entries){e.card.remove();e.line.remove();}this.entries=[];}
 open(ports){
  this.clear();
  for(const port of ports){
   const card=document.createElement('div');card.className='port-callout';
   const button=document.createElement('button');button.textContent=port.label+' +';button.setAttribute('aria-expanded','false');button.setAttribute('aria-label','About '+port.label);
   const detail=document.createElement('p');detail.textContent=port.description;detail.hidden=true;detail.id='port-detail-'+port.id;button.setAttribute('aria-controls',detail.id);
   card.append(button,detail);this.root.append(card);
   const line=document.createElementNS('http://www.w3.org/2000/svg','line');this.svg.append(line);
   const entry={port,card,button,detail,line,width:0,height:0};this.entries.push(entry);
   button.onclick=()=>{
    const expand=detail.hidden;
    for(const e of this.entries){e.detail.hidden=true;e.button.setAttribute('aria-expanded','false');e.button.textContent=e.port.label+' +';e.width=0;}
    detail.hidden=!expand;button.setAttribute('aria-expanded',String(expand));button.textContent=port.label+(expand?' −':' +');entry.width=0;
   };
  }
 }
 update(object,show){
  this.root.hidden=!show;if(!show)return;
  if(this.lastWidth!==innerWidth){for(const e of this.entries)e.width=0;this.lastWidth=innerWidth;}
  object.updateMatrixWorld(true);this.svg.setAttribute('viewBox',`0 0 ${innerWidth} ${innerHeight}`);
  const used=[];
  for(const e of this.entries){
   const point=object.localToWorld(new T.Vector3(...e.port.position));
   const normal=new T.Vector3(...e.port.normal).applyQuaternion(object.quaternion);
   const visible=normal.z>-.18;
   e.card.hidden=!visible;e.line.style.display=visible?'':'none';if(!visible)continue;
   point.project(this.camera);const x=(point.x+1)*innerWidth/2,y=(1-point.y)*innerHeight/2;
   if(!e.width){e.width=e.card.offsetWidth;e.height=e.card.offsetHeight;}
   const w=e.width,h=e.height,side=normal.x<-.05?-1:normal.x>.05?1:x<innerWidth/2?-1:1;
   let left=Math.max(26,Math.min(innerWidth-26-w,x+side*48-(side<0?w:0)));
   let top=Math.max(140,Math.min(innerHeight-30-h,y-normal.y*50-h/2));
   const desiredTop=top,desiredLeft=left;
   const ys=[top,140,innerHeight-30-h,...used.flatMap(r=>[r.y-h-10,r.y+r.h+10])];
   const xs=[left,26,innerWidth-26-w];let best=null;
   for(const x of xs)for(const y of ys){
    if(y<140||y+h>innerHeight-30||used.some(r=>x<r.x+r.w+8&&x+w+8>r.x&&y<r.y+r.h+8&&y+h+8>r.y))continue;
    const score=(x-desiredLeft)**2+(y-desiredTop)**2;
    if(!best||score<best.score)best={x,y,score};
   }
   if(best){left=best.x;top=best.y;}
   used.push({x:left,y:top,w,h});e.card.style.transform=`translate(${left}px,${top}px)`;
   for(const [k,v] of Object.entries({x1:x,y1:y,x2:Math.max(left,Math.min(left+w,x)),y2:Math.max(top,Math.min(top+h,y))}))e.line.setAttribute(k,v);
  }
 }
}
