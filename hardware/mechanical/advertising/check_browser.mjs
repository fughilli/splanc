import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const out=process.argv[2],url='http://127.0.0.1:8767/advertising-kit/';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
let errors=[];page.on('pageerror',e=>errors.push(String(e)));
await page.goto(url+'sim/');await page.waitForFunction(()=>window.splancReady,{timeout:60000});
await page.waitForTimeout(8000);
const active=await page.evaluate(()=>window.splancStats);
await page.screenshot({path:out+'/review/sim-desktop.png'});
await page.getByRole('button',{name:'Pause',exact:true}).click();
let t=await page.evaluate(()=>window.splancStats.time);await page.waitForTimeout(500);if((await page.evaluate(()=>window.splancStats.time))!==t)throw Error('Pause failed');
await page.getByRole('button',{name:'Play',exact:true}).click();
await page.getByLabel('Number of products').selectOption('12');await page.waitForTimeout(500);
const dense=await page.evaluate(()=>window.splancStats);
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(1000);await page.screenshot({path:out+'/review/sim-mobile.png'});
const mobile=await page.evaluate(()=>window.splancStats);
await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForFunction(()=>window.splancReady);await page.waitForTimeout(250);
if(await page.evaluate(()=>window.splancStats.running))throw Error('Reduced motion failed');
await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:1440,height:900});await page.goto(url);
await page.screenshot({path:out+'/review/gallery.png'});
await page.locator('video').first().scrollIntoViewIfNeeded();
const metadata=await page.locator('video').evaluateAll(async videos=>{
 const result=[];
 for(const v of videos){
  if(v.readyState<1)await new Promise((res,rej)=>{v.onloadedmetadata=res;v.onerror=rej;v.load();});
  v.currentTime=v.duration*.5;await new Promise(res=>v.addEventListener('seeked',res,{once:true}));
  result.push({src:v.currentSrc.split('/').at(-1),width:v.videoWidth,height:v.videoHeight,duration:v.duration,error:v.error});
 }
 return result;
});
if(metadata.length!==5||metadata.some(v=>v.width!==1920||v.height!==1080||v.duration<3.9||v.error))throw Error('Video validation failed');
await page.goto(url+'pricing/');await page.screenshot({path:out+'/review/pricing-browser.png'});
await fs.writeFile(out+'/review/browser-validation.json',JSON.stringify({errors,active,dense,mobile,metadata,reducedMotionPassed:true,pausePassed:true},null,2));
console.log(JSON.stringify({errors,active,dense,mobile,metadata}));
await browser.close();
if(errors.length)process.exitCode=1;
