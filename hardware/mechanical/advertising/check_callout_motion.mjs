import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.argv[2]||'http://127.0.0.1:8767/advertising-kit/sim/';
const out=process.argv[3]||'/tmp';const engine=process.argv[4]||'chromium';
const browser=await (engine==='webkit'?webkit.launch({headless:true}):chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true}));
const results=[],errors=[];
try{
 for(const mobile of [false,true]){
  const width=mobile?390:1440,height=mobile?844:1000;
  const page=await browser.newPage({viewport:{width,height},hasTouch:mobile});page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base);await page.waitForFunction(()=>window.splancReady,null,{timeout:60000});
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const b=await page.evaluate(()=>window.splancStats.bodies.find(b=>b.sku==='splanc'));
  await page.mouse.dblclick(...b.screen,{delay:70});await page.waitForFunction(()=>window.splancStats.inspection?.phase==='inspecting');
  await page.getByRole('button',{name:'Sensors',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===1);await page.waitForTimeout(800);
  await page.evaluate(()=>{
   window.calloutMotion={maxStep:0,detached:0,frames:0,active:true};let previous=new Map();
   function sample(){
    const state=window.calloutMotion;if(!state.active)return;const current=new Map();
    for(const card of document.querySelectorAll('.port-callout'))if(!card.hidden){
     const b=card.getBoundingClientRect(),key=card.querySelector('button').ariaLabel,p={x:b.x,y:b.y};current.set(key,p);
     if(previous.has(key))state.maxStep=Math.max(state.maxStep,Math.hypot(p.x-previous.get(key).x,p.y-previous.get(key).y));
    }
    const cards=[...current.values()],lines=[...document.querySelectorAll('.port-leaders line')].filter(l=>l.style.display!=='none');
    lines.forEach((l,i)=>{if(Math.abs(+l.getAttribute('x2')-cards[i].x-20)>.1||Math.abs(+l.getAttribute('y2')-cards[i].y-20)>.1)state.detached++;});
    previous=current;state.frames++;requestAnimationFrame(sample);
   }requestAnimationFrame(sample);
  });
  await page.getByRole('button',{name:'About Motion',exact:true}).click();await page.waitForTimeout(700);
  await page.getByRole('button',{name:'About Motion',exact:true}).click();await page.waitForTimeout(400);
  const before=await page.evaluate(()=>window.splancStats.inspection.rotation);
  await page.mouse.move(width*.5,height*.53);await page.mouse.down();
  for(let i=1;i<=24;i++){await page.mouse.move(width*.5+i*3,height*.53+i);await page.waitForTimeout(20);}
  await page.mouse.up();await page.waitForTimeout(1200);
  const after=await page.evaluate(()=>window.splancStats.inspection.rotation);assert.notDeepEqual(before,after,'exercise a real product orbit');
  const motion=await page.evaluate(()=>{window.calloutMotion.active=false;return window.calloutMotion;});
  assert(motion.frames>25);assert(motion.maxStep<=36.5,'visible bubbles must not jump on an update');assert.equal(motion.detached,0);
  await page.screenshot({path:`${out}/callout-orbit-${mobile?'mobile':'desktop'}-${engine}.png`});
  await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'Close case',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===0);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.splancStats.inspection);
  results.push({mobile,...motion,reducedMotionReturn:true});await page.close();
 }
 assert.deepEqual(errors,[]);await fs.writeFile(`${out}/callout-motion-${engine}.json`,JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors}));
}finally{await browser.close();}
