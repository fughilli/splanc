import assert from 'node:assert/strict';
import {CalloutLayout,leadersCross} from './callout-layout.mjs';
const bounds={left:26,right:764,top:164,bottom:744};
const node=(ax,ay,x,y,width=40,height=40)=>({anchor:{x:ax,y:ay},preferred:{x,y},target:{x,y},width,height});
const overlaps=nodes=>nodes.some((a,i)=>nodes.slice(i+1).some(b=>a.target.x<b.target.x+b.width&&a.target.x+a.width>b.target.x&&a.target.y<b.target.y+b.height&&a.target.y+a.height>b.target.y));
const settle=(layout,nodes,frames=240,box=bounds)=>{for(let i=0;i<frames;i++)layout.update(nodes,box,1/60);};
const crossed=[node(250,300,550,550),node(550,300,250,550)];
assert(leadersCross(...crossed));settle(new CalloutLayout(),crossed);assert(!leadersCross(...crossed),'untangle a crossed pair without swapping labels');
const crowded=Array.from({length:8},(_,i)=>node(350+i*4,400+i%2*6,390+i*2,450+i%2*4));
const layout=new CalloutLayout();settle(layout,crowded);assert(!overlaps(crowded),'separate eight crowded hit targets');
settle(layout,crowded);const still=crowded.map(n=>({...n.display}));settle(layout,crowded,120);
assert(crowded.every((n,i)=>Math.hypot(n.display.x-still[i].x,n.display.y-still[i].y)<.5),'settled labels should not jitter');
crowded[3].width=210;crowded[3].height=170;
const phone={left:26,right:364,top:164,bottom:788};settle(layout,crowded,300,phone);
assert(!overlaps(crowded),'make room for an expanded card after a phone resize');
for(const n of crowded){assert(n.display.x>=phone.left+20-.1);assert(n.display.x+n.width-20<=phone.right+.1);assert(n.display.y>=phone.top+20-.1);assert(n.display.y+n.height-20<=phone.bottom+.1);}
for(const fps of [30,60,120]){
 const moving=[node(200,300,260,300)],solver=new CalloutLayout();settle(solver,moving);
 const before={...moving[0].display};moving[0].anchor={x:650,y:450};moving[0].preferred={x:710,y:450};
 let maxStep=0;
 for(let i=0;i<fps;i++){const p={...moving[0].display};solver.update(moving,bounds,1/fps);maxStep=Math.max(maxStep,Math.hypot(moving[0].display.x-p.x,moving[0].display.y-p.y));}
 assert(maxStep<=720/fps+.001,'no snapping after an abrupt target change');
 assert(Math.hypot(moving[0].display.x-before.x,moving[0].display.y-before.y)>200,'track the new port rather than freezing');
}
const reduced=[node(300,300,370,300)];const instant=new CalloutLayout();instant.update(reduced,bounds,1/60,true);
reduced[0].preferred={x:480,y:450};instant.update(reduced,bounds,1/60,true);assert.deepEqual(reduced[0].display,reduced[0].target,'reduced motion bypasses interpolation');
console.log('Callout layout: crossing, crowding, expansion/resize, stability, 30/60/120 Hz motion and reduced-motion checks passed.');
