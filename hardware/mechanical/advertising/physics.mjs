// Fixed-step planar rigid bodies with oriented rectangle contacts.
// Visual presentation model, not an engineering impact simulation.
const dot=(a,b)=>a.x*b.x+a.y*b.y;
const cross=(a,b)=>a.x*b.y-a.y*b.x;
const axis=b=>[{x:Math.cos(b.a),y:Math.sin(b.a)},{x:-Math.sin(b.a),y:Math.cos(b.a)}];
const radius=(b,n)=>{const [u,v]=axis(b);return Math.abs(dot(u,n))*b.hx+Math.abs(dot(v,n))*b.hy;};
export function contact(a,b){
  const d={x:b.x-a.x,y:b.y-a.y};let overlap=Infinity,normal;
  for(const n of [...axis(a),...axis(b)]){
    const depth=radius(a,n)+radius(b,n)-Math.abs(dot(d,n));
    if(depth<=0)return null;
    if(depth<overlap){overlap=depth;const s=dot(d,n)<0?-1:1;normal={x:n.x*s,y:n.y*s};}
  }
  return {overlap,normal};
}
export function resolve(a,b,c){
  const n=c.normal,invA=1/a.mass,invB=1/b.mass,sum=invA+invB;
  const move=Math.max(0,c.overlap-.00005)*.8/sum;
  a.x-=n.x*move*invA;a.y-=n.y*move*invA;b.x+=n.x*move*invB;b.y+=n.y*move*invB;
  const t={x:-n.y,y:n.x};const tangent=dot({x:b.x-a.x,y:b.y-a.y},t)*.25;
  const ra={x:n.x*radius(a,n)+t.x*tangent,y:n.y*radius(a,n)+t.y*tangent};
  const rb={x:-n.x*radius(b,n)-t.x*tangent,y:-n.y*radius(b,n)-t.y*tangent};
  const rel={x:b.vx-b.w*rb.y-a.vx+a.w*ra.y,y:b.vy+b.w*rb.x-a.vy-a.w*ra.x};
  const speed=dot(rel,n);if(speed>=0)return false;
  const ia=3/(a.mass*(a.hx*a.hx+a.hy*a.hy)),ib=3/(b.mass*(b.hx*b.hx+b.hy*b.hy));
  const ca=cross(ra,n),cb=cross(rb,n);
  const j=-(1+.92)*speed/(sum+ca*ca*ia+cb*cb*ib);
  a.vx-=j*n.x*invA;a.vy-=j*n.y*invA;b.vx+=j*n.x*invB;b.vy+=j*n.y*invB;
  a.w=Math.max(-2,Math.min(2,a.w-j*ca*ia));b.w=Math.max(-2,Math.min(2,b.w+j*cb*ib));
  return true;
}
export function step(bodies,dt,bounds){
  let impacts=0;
  for(const b of bodies){b.x+=b.vx*dt;b.y+=b.vy*dt;b.a+=b.w*dt;}
  for(let pass=0;pass<3;pass++)for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){
    const c=contact(bodies[i],bodies[j]);if(c&&resolve(bodies[i],bodies[j],c))impacts++;
  }
  for(const b of bodies){
    const rx=radius(b,{x:1,y:0}),ry=radius(b,{x:0,y:1});
    if(b.x-rx<-bounds.x){b.x=-bounds.x+rx;b.vx=Math.abs(b.vx);}
    if(b.x+rx>bounds.x){b.x=bounds.x-rx;b.vx=-Math.abs(b.vx);}
    if(b.y-ry<-bounds.y){b.y=-bounds.y+ry;b.vy=Math.abs(b.vy);}
    if(b.y+ry>bounds.y){b.y=bounds.y-ry;b.vy=-Math.abs(b.vy);}
  }
  return impacts;
}
export function random(seed=81026){let n=seed>>>0;return()=>{n=(1664525*n+1013904223)>>>0;return n/4294967296;};}
