import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out=process.argv[2],base='http://127.0.0.1:8767/advertising-kit/sim/';
const engine=process.argv[3]||'chromium',suffix=engine==='chromium'?'':'-webkit';
const browser=await (engine==='webkit'?webkit.launch({headless:true}):chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true}));
const errors=[],results=[];
const stats=p=>p.evaluate(()=>window.splancStats);
async function focus(p,sku,touch){
 const b=(await stats(p)).bodies.find(b=>b.sku===sku);assert(b,sku+' available');
 if(touch){await p.touchscreen.tap(...b.screen);await p.waitForTimeout(70);await p.touchscreen.tap(...b.screen);}
 else await p.mouse.dblclick(...b.screen,{delay:70});
 await p.waitForFunction(()=>window.splancStats.inspection?.phase==='inspecting');
}
try{
 for(const mobile of [false,true]){
  const context=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}:{viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(base);await page.waitForFunction(()=>window.splancReady,null,{timeout:60000});
  await page.waitForTimeout(700);await page.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForTimeout(80);
  assert((await stats(page)).diffuser);const frozen=await stats(page);
  await page.screenshot({path:out+`/review/diffuser-${mobile?'mobile':'desktop'}${suffix}.png`});
  for(const sku of mobile?['mini','splanc','max']:['mini','splanc','max']){
   console.log('Checking',mobile?'mobile':'desktop',sku);
   await focus(page,sku,mobile);await page.waitForTimeout(150);
   const markers=await page.locator('.port-callout button').evaluateAll(es=>es.map(e=>({text:e.textContent,w:e.offsetWidth,h:e.offsetHeight,radius:getComputedStyle(e).borderRadius,label:e.getAttribute('aria-label')})));
   assert(markers.length>0);for(const m of markers){assert.equal(m.text,'');assert.equal(m.w,m.h);assert.equal(m.radius,'50%');assert(m.label.startsWith('About '));}
   if(sku!=='max'){
    for(const label of ['Reset','Boot','User 1','User 2'])assert.equal(await page.getByRole('button',{name:'About '+label,exact:true}).count(),1);
    if(sku==='mini')await page.screenshot({path:out+`/review/buttons-${mobile?'mobile':'desktop'}${suffix}.png`});
   }
   await page.getByRole('button',{name:'Sensors',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===1);await page.waitForTimeout(200);
   const s=await stats(page);assert.equal(s.inspection.sensorCount,sku==='max'?3:sku==='splanc'?8:6);assert(s.inspection.sensors);
   if(sku==='max'){
    assert.equal(await page.locator('.port-callout button').count(),3);
    for(const label of ['UWB · optional','GNSS · optional']){
     const button=page.getByRole('button',{name:'About '+label,exact:true});await button.click();assert.equal(await button.getAttribute('aria-expanded'),'true');
     assert((await page.locator('.port-callout p:not([hidden])').textContent()).includes('Optional'));
    }
   }
   assert.equal(s.time,frozen.time);assert.equal(s.ledTime,frozen.ledTime);
   await page.screenshot({path:out+`/review/sensors-${sku}-${mobile?'mobile':'desktop'}${suffix}.png`});
   const name=sku==='max'?'20-channel power telemetry':'Motion';await page.getByRole('button',{name:'About '+name,exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'About '+name,exact:true}).getAttribute('aria-expanded'),'true');
   assert.equal(await page.locator('.port-callout p:not([hidden]) strong').textContent(),name);
   await page.waitForTimeout(1200); // Allow the continuous callout layout to settle.
   await page.screenshot({path:out+`/review/sensor-detail-${sku}-${mobile?'mobile':'desktop'}${suffix}.png`});
   const boxes=await page.locator('.port-callout').evaluateAll(es=>es.filter(e=>!e.hidden).map(e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};}));
   const overlaps=boxes.some((a,i)=>boxes.slice(i+1).some(b=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y));
   assert.equal(overlaps,false);results.push({mobile,sku,sensors:s.inspection.sensorCount,overlaps});
   await page.getByRole('button',{name:'Close case',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===0);
   await page.getByRole('button',{name:'Sensors',exact:true}).click();await page.waitForTimeout(100);
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.splancStats.inspection);
   const restored=await stats(page);assert.deepEqual(restored.bodies,frozen.bodies);assert.equal(restored.running,false);
  }
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await focus(page,'mini',mobile);const inspecting=await stats(page);
  const stripBefore=await page.locator('#perimeter-leds').evaluate(c=>c.toDataURL());
  await page.waitForTimeout(650);const chasing=await stats(page);
  assert.equal(chasing.time,inspecting.time);assert.deepEqual(chasing.bodies,inspecting.bodies);
  assert(chasing.ledTime>inspecting.ledTime,'diffuser must keep chasing during playing inspection');
  assert.notEqual(await page.locator('#perimeter-leds').evaluate(c=>c.toDataURL()),stripBefore,'diffuser pixels must animate');
  await page.screenshot({path:out+`/review/inspection-chase-${mobile?'mobile':'desktop'}${suffix}.png`});
  results.push({mobile,inspectionChase:true,flightFrozen:true,ledAdvance:chasing.ledTime-inspecting.ledTime});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.splancStats.inspection);
  await page.waitForFunction(()=>window.splancStats.running===true);
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForFunction(()=>window.splancReady);await page.waitForTimeout(100);
  await focus(page,'mini',mobile);await page.getByRole('button',{name:'Sensors',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===1);
  assert.equal((await stats(page)).running,false);await context.close();
 }
 await fs.writeFile(out+`/review/sensors-validation${suffix}.json`,JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors}));assert.equal(errors.length,0);
}finally{await browser.close();}
