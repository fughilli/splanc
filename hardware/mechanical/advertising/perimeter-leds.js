// A continuous frosted diffuser with a smooth RGB chase around a rounded frame.
export class PerimeterLEDs {
 constructor(stage){
  this.canvas=document.createElement('canvas');this.canvas.id='perimeter-leds';
  this.canvas.setAttribute('aria-hidden','true');stage.append(this.canvas);
  this.ctx=this.canvas.getContext('2d');this.base=document.createElement('canvas');
  this.points=[];this.lastTime=-1;
 }
 resize(w,h){
  const dpr=Math.min(devicePixelRatio||1,1.5),inset=12,r=18;
  Object.assign(this,{w,h,dpr});
  for(const canvas of [this.canvas,this.base]){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
  const c=this.base.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);
  const x0=inset,y0=inset,x1=w-inset,y1=h-inset;
  c.lineWidth=14;c.strokeStyle='#090e13';c.beginPath();c.roundRect(x0,y0,x1-x0,y1-y0,r);c.stroke();
  c.lineWidth=9;c.strokeStyle='#7b898a';c.stroke();
  c.lineWidth=6;c.strokeStyle='#a3adab';c.globalAlpha=.25;c.stroke();c.globalAlpha=1;
  this.points=[];
  const line=(ax,ay,bx,by,nx,ny)=>{const n=Math.ceil(Math.hypot(bx-ax,by-ay)/5);for(let i=0;i<n;i++)this.points.push({x:ax+(bx-ax)*i/n,y:ay+(by-ay)*i/n,nx,ny});};
  const arc=(x,y,start)=>{const n=Math.ceil(r*Math.PI/2/5);for(let i=0;i<n;i++){const a=start+i/n*Math.PI/2;this.points.push({x:x+r*Math.cos(a),y:y+r*Math.sin(a),nx:-Math.cos(a),ny:-Math.sin(a)});}};
  line(x0+r,y0,x1-r,y0,0,1);arc(x1-r,y0+r,-Math.PI/2);
  line(x1,y0+r,x1,y1-r,-1,0);arc(x1-r,y1-r,0);
  line(x1-r,y1,x0+r,y1,0,-1);arc(x0+r,y1-r,Math.PI/2);
  line(x0,y1-r,x0,y0+r,1,0);arc(x0+r,y0+r,Math.PI);
  this.lastTime=-1;
 }
 field(t,time){return {hue:(t*360-time*16+3600)%360,brightness:Math.exp((Math.cos((t-time*.075)*Math.PI*6)-1)*4)};}
 draw(time){
  if(this.lastTime===time)return;this.lastTime=time;
  const c=this.ctx,n=this.points.length;c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,this.canvas.width,this.canvas.height);c.drawImage(this.base,0,0);
  c.setTransform(this.dpr,0,0,this.dpr,0,0);c.lineCap='round';
  // Overlapping sub-pixel color steps read as one diffuser, with no diode dots.
  for(const [width,alpha,lightness] of [[32,.07,60],[17,.12,65],[8,1,72]]){
   c.lineWidth=width;
   for(let i=0;i<n;i++){
    const p=this.points[i],q=this.points[(i+1)%n],f=this.field(i/n,time);
    if(width!==8&&f.brightness<.015)continue;
    // Opaque color in the frosted core avoids brighter dots where strokes join.
    c.strokeStyle=width===8?`hsl(${f.hue},${f.brightness*100}%,${53+f.brightness*19}%)`:`hsla(${f.hue},100%,${lightness}%,${f.brightness*alpha})`;
    c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.stroke();
   }
  }
 }
 lights(time){
  const n=this.points.length,result=[];
  for(let head=0;head<3;head++)for(const offset of [-.025,0,.025]){
   const t=((time*.075+head/3+offset)%1+1)%1,p=this.points[Math.floor(t*n)];
   result.push({...p,...this.field(t,time)});
  }
  return result;
 }
}
