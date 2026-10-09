// Decorative WS2812-style strip. Static packages are cached; only light changes.
export class PerimeterLEDs {
 constructor(stage){
  this.canvas=document.createElement('canvas');this.canvas.id='perimeter-leds';
  this.canvas.setAttribute('aria-hidden','true');stage.append(this.canvas);
  this.ctx=this.canvas.getContext('2d');this.base=document.createElement('canvas');
  this.points=[];this.lastTime=-1;
 }
 resize(w,h){
  const dpr=Math.min(devicePixelRatio||1,1.5),inset=12,r=13;
  this.w=w;this.h=h;this.dpr=dpr;
  for(const canvas of [this.canvas,this.base]){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
  const c=this.base.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);
  const x0=inset,y0=inset,x1=w-inset,y1=h-inset;
  c.strokeStyle='#212a2b';c.lineWidth=13;c.beginPath();c.roundRect(x0,y0,x1-x0,y1-y0,r);c.stroke();
  c.strokeStyle='#091011';c.lineWidth=11;c.stroke();
  this.points=[];
  // Corners get their own packages; regular gaps on each straight side.
  const sides=[[x0,y0,x1,y0,0,1],[x1,y0,x1,y1,-1,0],[x1,y1,x0,y1,0,-1],[x0,y1,x0,y0,1,0]];
  for(const [ax,ay,bx,by,nx,ny] of sides){
   const n=Math.max(1,Math.round(Math.hypot(bx-ax,by-ay)/23));
   for(let i=0;i<n;i++)this.points.push({x:ax+(bx-ax)*i/n,y:ay+(by-ay)*i/n,nx,ny,angle:Math.atan2(ny,nx)});
  }
  for(const p of this.points){
   c.save();c.translate(p.x,p.y);c.rotate(p.angle);
   c.fillStyle='#796441';for(const y of [-4,2])c.fillRect(-3,y,4,2);
   c.fillStyle='#535a57';c.beginPath();c.roundRect(-3,-3.5,6,7,1);c.fill();
   c.fillStyle='#111c20';c.fillRect(1.6,-2.8,1.5,5.6);c.restore();
  }
  this.lastTime=-1;
 }
 draw(time){
  if(this.lastTime===time)return;this.lastTime=time;
  const c=this.ctx,n=this.points.length;c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,this.canvas.width,this.canvas.height);c.drawImage(this.base,0,0);
  c.setTransform(this.dpr,0,0,this.dpr,0,0);
  const head=time*30;
  for(let i=0;i<n;i++){
   const age=((head-i)%(n/3)+n/3)%(n/3),brightness=Math.exp(-age/7);
   if(brightness<.025)continue;
   const p=this.points[i],hue=(i/n*360-time*16+3600)%360;
   c.save();c.translate(p.x,p.y);c.rotate(p.angle);
   c.save();c.scale(1,.42);
   const glow=c.createRadialGradient(3,0,0,3,0,85);glow.addColorStop(0,`hsla(${hue},100%,65%,${brightness*.16})`);glow.addColorStop(1,`hsla(${hue},100%,50%,0)`);
   c.fillStyle=glow;c.fillRect(3,-85,85,170);c.restore();
   c.fillStyle=`hsla(${hue},100%,65%,${brightness})`;c.fillRect(2,-2.8,1.5,5.6);
   c.restore();
  }
 }
 lights(time){
  const n=this.points.length,result=[];
  for(let tail=0;tail<3;tail++)for(const age of [0,4,9]){
   const i=((Math.floor(time*30+tail*n/3-age)%n)+n)%n,p=this.points[i];
   result.push({...p,hue:(i/n*360-time*16+3600)%360,brightness:Math.exp(-age/7)});
  }
  return result;
 }
}
