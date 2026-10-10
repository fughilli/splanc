// Isolated Chrome check; does not touch the user's browser profile.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2],url='http://127.0.0.1:8767/advertising-kit/sim/';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
const errors=[],report={};
async function ready(page){await page.waitForFunction(()=>window.splancReady,null,{timeout:60000});await page.waitForTimeout(100);}
const stats=page=>page.evaluate(()=>window.splancStats);
async function inspect(page,touch=false,sku='max'){
 const s=await stats(page),b=s.bodies.find(b=>b.sku===sku)||s.bodies[0],p=b.screen;
 if(touch){await page.touchscreen.tap(...p);await page.waitForTimeout(70);await page.touchscreen.tap(...p);}
 else await page.mouse.dblclick(...p,{delay:70});
 await page.waitForFunction(()=>window.splancStats.inspection?.phase==='inspecting');
}
try{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(url);await ready(page);
 const first=await stats(page);await page.waitForTimeout(500);const moving=await stats(page);
 assert(moving.ledTime>first.ledTime);assert(moving.ledCount>100);
 await page.screenshot({path:out+'/review/sim-leds-desktop.png'});
 await page.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForTimeout(60);
 const paused=await stats(page);await page.waitForTimeout(200);
 assert.equal((await stats(page)).ledTime,paused.ledTime);
 await inspect(page);const focused=await stats(page);assert.equal(focused.time,paused.time);assert(focused.inspection.scale>1);
 await page.screenshot({path:out+'/review/sim-inspect-desktop.png'});
 const ethernet=page.getByRole('button',{name:'About Ethernet 1',exact:true});
 await ethernet.click();assert.equal(await ethernet.getAttribute('aria-expanded'),'true');assert.match(await page.locator('#port-detail-ethernet-1').innerText(),/daisy-chainable/);
 await page.screenshot({path:out+'/review/sim-port-callout.png'});
 await page.mouse.move(720,450);await page.mouse.down();await page.mouse.move(840,485,{steps:12});await page.mouse.up();
 const rotated=await stats(page);assert.notDeepEqual(rotated.inspection.rotation,focused.inspection.rotation);
 await page.mouse.wheel(0,-380);await page.waitForTimeout(200);assert((await stats(page)).inspection.zoom>1);
 await page.getByRole('button',{name:'Close product inspection'}).click();
 await page.waitForFunction(()=>!window.splancStats.inspection);
 const returned=await stats(page);assert.equal(returned.running,false);assert.deepEqual(returned.bodies,paused.bodies);assert.equal(returned.time,paused.time);
 report.pausedReturnExact=true;report.orbitAndWheel=true;
 await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForTimeout(200);
 await inspect(page);const frozen=await stats(page);await page.waitForTimeout(200);assert.equal((await stats(page)).time,frozen.time);
 await page.mouse.click(70,800);await page.waitForFunction(()=>!window.splancStats.inspection);await page.waitForTimeout(200);
 assert((await stats(page)).time>frozen.time);report.backgroundResumes=true;
 await page.getByRole('button',{name:'Pause',exact:true}).click();await inspect(page,false,'mini');
 await page.getByRole('button',{name:'About USB-C',exact:true}).click();
 await page.screenshot({path:out+'/review/sim-button-caps.png'});await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.splancStats.inspection);
 const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
 const mobile=await mobileContext.newPage();mobile.on('pageerror',e=>errors.push(String(e)));mobile.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await mobile.goto(url+'?embed=1');await ready(mobile);
 await mobile.getByRole('button',{name:'Pause',exact:true}).click();await mobile.waitForTimeout(60);
 await mobile.screenshot({path:out+'/review/sim-leds-mobile.png'});
 await inspect(mobile,true);await mobile.screenshot({path:out+'/review/sim-inspect-mobile.png'});
 await mobile.getByRole('button',{name:'About Ethernet 1',exact:true}).tap();assert.equal(await mobile.getByRole('button',{name:'About Ethernet 1',exact:true}).getAttribute('aria-expanded'),'true');
 await mobile.waitForTimeout(80);
 const overlapping=await mobile.locator('.port-callout').evaluateAll(es=>{
  const boxes=es.filter(e=>!e.hidden).map(e=>e.getBoundingClientRect());
  return boxes.some((a,i)=>boxes.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));
 });assert.equal(overlapping,false);report.portCalloutsAndMobileLayout=true;
 await mobile.screenshot({path:out+'/review/sim-port-callout-mobile.png'});
 const beforePinch=await stats(mobile),cdp=await mobileContext.newCDPSession(mobile);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:160,y:422,id:1},{x:230,y:422,id:2}]});
 for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:160-i*5,y:422,id:1},{x:230+i*5,y:422,id:2}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await mobile.waitForTimeout(100);
 assert((await stats(mobile)).inspection.zoom>beforePinch.inspection.zoom);
 // Zoomed geometry may fill the screen: use X, with background exit tested above.
 await mobile.getByRole('button',{name:'Close product inspection'}).tap();await mobile.waitForFunction(()=>!window.splancStats.inspection);report.touchDoubleTapPinchAndClose=true;
 await mobile.emulateMedia({reducedMotion:'reduce'});await mobile.reload();await ready(mobile);
 const reduced=await stats(mobile);await mobile.waitForTimeout(200);assert.equal((await stats(mobile)).ledTime,reduced.ledTime);assert.equal(reduced.running,false);
 await inspect(mobile,true);await mobile.keyboard.press('Escape');await mobile.waitForFunction(()=>!window.splancStats.inspection);report.reducedMotionAndEscape=true;
 report.desktop=moving;report.mobile=await stats(mobile);report.errors=errors;
 await fs.writeFile(out+'/review/interaction-validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.equal(errors.length,0);
}finally{await browser.close();}
