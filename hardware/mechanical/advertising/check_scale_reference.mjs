// Verify the reference in the actual double-click / double-tap detail flow.
import {chromium,webkit} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2],base=process.argv[3]||'http://127.0.0.1:8767/advertising-kit/sim/';
const engine=process.argv[4]||'chromium',suffix=engine==='webkit'?'-webkit':'';
const browser=await (engine==='webkit'?webkit.launch({headless:true}):chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true}));
const results=[],errors=[],dimensions={mini:[75.6,62.3,11.8],splanc:[106.4,87.8,17.2],max:[339,134,43]};
const stats=p=>p.evaluate(()=>window.splancStats);
async function open(page,sku,touch){
 const b=(await stats(page)).bodies.find(b=>b.sku===sku);assert(b,sku+' in simulation');
 if(touch){await page.touchscreen.tap(...b.screen);await page.waitForTimeout(60);await page.touchscreen.tap(...b.screen);}
 else await page.mouse.dblclick(...b.screen,{delay:60});
 await page.waitForFunction(()=>window.splancStats.inspection?.phase==='inspecting');await page.waitForTimeout(300);
 assert.equal((await stats(page)).inspection.sku,sku);
}
try{
 for(const mobile of [false,true]){
  const context=await browser.newContext(mobile?{viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:2}:{viewport:{width:1440,height:900}});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.splancReady,null,{timeout:60000});
  await page.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForTimeout(80);
  const original=await stats(page);
  for(const sku of ['mini','splanc','max']){
   await open(page,sku,mobile);const initial=(await stats(page)).inspection;
   assert(initial.reference.visible);assert.deepEqual(initial.reference.productMillimeters,dimensions[sku]);
   assert(Math.abs(initial.reference.cardMillimeters[0]-85.6)<1e-6);assert(Math.abs(initial.reference.cardMillimeters[1]-53.98)<1e-6);assert.equal(initial.reference.cardMillimeters[2],.76);
   assert.equal(await page.locator('#scale-toggle').getAttribute('aria-pressed'),'true');assert(await page.locator('#scale-reference-labels').isVisible());
   assert.equal(await page.locator('.dimension-label').count(),3);
   await page.screenshot({path:out+`/review/size-${sku}-${mobile?'mobile':'desktop'}${suffix}.png`});
   await page.getByRole('button',{name:'Size reference',exact:true}).click();await page.waitForTimeout(250);
   assert(!(await stats(page)).inspection.reference.visible);assert(!(await page.locator('#scale-reference-labels').isVisible()));
   await page.getByRole('button',{name:'Size reference',exact:true}).click();await page.waitForTimeout(250);
   assert((await stats(page)).inspection.reference.visible);
   await page.getByRole('button',{name:'Sensors',exact:true}).click();
   await page.waitForFunction(()=>{const r=window.splancStats.inspection.reference;return r.opacity>0&&r.opacity<1;});
   await page.waitForFunction(()=>window.splancStats.inspection.explosion===1);
   assert(!(await page.locator('#scale-reference-labels').isVisible()));assert.equal((await stats(page)).inspection.reference.opacity,0);
   await page.screenshot({path:out+`/review/size-${sku}-${mobile?'mobile':'desktop'}-sensors${suffix}.png`});
   await page.getByRole('button',{name:'Close case',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===0);
   assert((await stats(page)).inspection.reference.visible,'reference returns when case closes');
   await page.getByRole('button',{name:'Sensors',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===1);
   await page.getByRole('button',{name:'Size reference',exact:true}).click();
   await page.getByRole('button',{name:'Close case',exact:true}).click();await page.waitForFunction(()=>window.splancStats.inspection.explosion===0);
   assert(!(await stats(page)).inspection.reference.visible,'disabled reference remains hidden after closing');
   await page.getByRole('button',{name:'Size reference',exact:true}).click();
   await page.getByRole('button',{name:'Size reference',exact:true}).click();
   await page.getByRole('button',{name:'Close product inspection',exact:true}).click();await page.waitForFunction(()=>!window.splancStats.inspection);
   assert.equal(await page.locator('#scale-reference-labels').count(),0);assert.deepEqual((await stats(page)).bodies,original.bodies);
   await open(page,sku,mobile);assert((await stats(page)).inspection.reference.visible,'reset visible on next detail open');
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.splancStats.inspection);
   results.push({sku,mobile,defaultVisible:true,toggle:true,sensorsFade:true,retainsToggle:true,resetOnReopen:true,restoredFlight:true});
  }
  await page.getByRole('button',{name:'Play',exact:true}).click();await open(page,'mini',mobile);
  const before=await stats(page);await page.waitForTimeout(300);const after=await stats(page);
  assert.equal(after.time,before.time);assert(after.ledTime>before.ledTime);
  await page.getByRole('button',{name:'Close product inspection',exact:true}).click();await page.waitForFunction(()=>!window.splancStats.inspection);
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.splancReady,null,{timeout:60000});
  await open(page,'mini',mobile);assert((await stats(page)).inspection.reference.visible);assert.equal((await stats(page)).running,false);
  await context.close();
 }
 assert.equal(errors.length,0);await fs.writeFile(out+`/review/scale-reference-validation${suffix}.json`,JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors}));
}finally{await browser.close();}
