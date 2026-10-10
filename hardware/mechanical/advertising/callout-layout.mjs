// Screen-space callouts retain their layout between frames. Coordinates are the
// bubble center; an expanded card extends right and down from that bubble.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const distance2=(a,b)=>(a.x-b.x)**2+(a.y-b.y)**2;
const rect=n=>({x:n.target.x-20,y:n.target.y-20,w:n.width,h:n.height});
export function leadersCross(a,b){
 const p=a.anchor,q=a.target,r=b.anchor,s=b.target;
 return cross(p,q,r)*cross(p,q,s)<-1e-6&&cross(r,s,p)*cross(r,s,q)<-1e-6;
}
function lineDistance(p,a,b){return Math.abs(cross(a,b,p))/Math.max(1,Math.sqrt(distance2(a,b)));}
function segmentDistance(p,a,b){
 const t=clamp(((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/Math.max(1,distance2(a,b)),0,1);
 return Math.hypot(p.x-a.x-t*(b.x-a.x),p.y-a.y-t*(b.y-a.y));
}
function pairCost(a,b){
 const ar=rect(a),br=rect(b),gap=12;
 const px=Math.min(ar.x+ar.w+gap-br.x,br.x+br.w+gap-ar.x);
 const py=Math.min(ar.y+ar.h+gap-br.y,br.y+br.h+gap-ar.y);
 let cost=px>0&&py>0?24*Math.min(px,py)**2:0;
 // Penetration depth goes continuously to zero as crossing segments untangle.
 // No binary crossing count or discrete slot/side switch drives the layout.
 if(leadersCross(a,b)){
  const depth=Math.min(lineDistance(a.anchor,b.anchor,b.target),lineDistance(a.target,b.anchor,b.target),lineDistance(b.anchor,a.anchor,a.target),lineDistance(b.target,a.anchor,a.target));
  cost+=36*depth*depth;
 }
 // A small clearance term also discourages near crossings and collinear runs.
 // Shared/nearby physical ports can legitimately have touching leader origins.
 for(const [u,v] of [[a,b],[b,a]])for(const t of [.45,.75,1]){
  const p={x:u.anchor.x+(u.target.x-u.anchor.x)*t,y:u.anchor.y+(u.target.y-u.anchor.y)*t};
  const d=segmentDistance(p,v.anchor,v.target);
  cost+=.7*Math.max(0,10-d)**2;
 }
 return cost;
}
function localCost(n,nodes){
 let cost=.035*distance2(n.target,n.preferred)+.10*distance2(n.target,n.previous);
 const length=Math.sqrt(distance2(n.target,n.anchor));
 cost+=.15*Math.max(0,36-length)**2+.02*Math.max(0,length-160)**2;
 for(const other of nodes)if(other!==n)cost+=pairCost(n,other);
 return cost;
}
function constrain(n,bounds){
 n.target.x=clamp(n.target.x,bounds.left+20,Math.max(bounds.left+20,bounds.right-n.width+20));
 n.target.y=clamp(n.target.y,bounds.top+20,Math.max(bounds.top+20,bounds.bottom-n.height+20));
}
export class CalloutLayout {
 constructor(){this.frame=0;}
 update(nodes,bounds,dt=1/60,reduced=false){
  dt=clamp(dt,0,.05);
  for(const n of nodes){
   if(!n.target)n.target={...n.preferred};
   constrain(n,bounds);
   n.previous={...n.target};
  }
  // Bounded coordinate descent, warm-started, with a decreasing line search.
  // All visible labels participate; reverse traversal avoids fixed list priority.
  const ordered=this.frame++%2?[...nodes].reverse():nodes;
  for(let pass=0;pass<(reduced?24:6);pass++)for(const n of ordered){
   const start={...n.target},base=localCost(n,nodes);
   n.target.x=start.x+1;const xp=localCost(n,nodes);
   n.target.x=start.x-1;const xm=localCost(n,nodes);n.target.x=start.x;
   n.target.y=start.y+1;const yp=localCost(n,nodes);
   n.target.y=start.y-1;const ym=localCost(n,nodes);n.target.y=start.y;
   const gx=(xp-xm)/2,gy=(yp-ym)/2,length=Math.hypot(gx,gy);
   if(length<.01)continue;
   let accepted=false;
   for(let step=Math.min(12,length*.18);step>.025;step*=.5){
    n.target.x=start.x-gx/length*step;n.target.y=start.y-gy/length*step;constrain(n,bounds);
    if(localCost(n,nodes)<base-.00001){accepted=true;break;}
   }
   if(!accepted)Object.assign(n.target,start);
  }
  // Exponential interpolation behaves the same at 30/60/120 Hz. The speed
  // limit catches abrupt resize/expansion/orbit changes without a position snap.
  const alpha=1-Math.exp(-10*dt);
  for(const n of nodes){
   if(!n.display||reduced)n.display={...n.target};
   else{
    const dx=(n.target.x-n.display.x)*alpha,dy=(n.target.y-n.display.y)*alpha;
    const scale=Math.min(1,720*dt/Math.max(.001,Math.hypot(dx,dy)));
    n.display.x+=dx*scale;n.display.y+=dy*scale;
   }
  }
 }
}
