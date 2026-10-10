import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out=process.argv[2],base='http://mac-mini.tail6b8ad3.ts.net:8767/advertising-kit/sim/';
const results=[];
for(const engine of ['chromium','webkit']){
 const browser=await (engine==='chromium'?chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true}):webkit.launch({headless:true}));
 try{
  for(const raw of [false,true]){
   console.log('Checking',engine,raw?'raw':'gzip');
   const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),errors=[],requests=[];
   if(raw)await page.addInitScript(()=>Object.defineProperty(window,'DecompressionStream',{value:undefined}));
   page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.url().includes('/models/'))requests.push(r.url());});
   page.on('console',m=>{if(m.type()==='error')console.log('Browser error',m.text());});
   page.on('requestfailed',r=>console.log('Request failed',r.url(),r.failure()));
   await page.goto(base);
   try{await page.waitForFunction(()=>window.splancReady,null,{timeout:60000});}catch(e){
    await page.screenshot({path:out+`/review/model-delivery-${engine}-${raw?'raw':'gzip'}-failure.png`});
    console.log('Failed state',await page.locator('body').innerText(),errors,requests);throw e;
   }
   await page.waitForTimeout(500);
   const stats=await page.evaluate(()=>window.splancStats);assert.equal(stats.products,8);assert(stats.triangles>1000000);
   await page.screenshot({path:out+`/review/model-delivery-${engine}-${raw?'raw':'gzip'}.png`});
   await page.reload();await page.waitForFunction(()=>window.splancReady,null,{timeout:60000});
   const binaries=requests.filter(url=>/\.bin(?:\.gz)?$/.test(url));assert(binaries.length>=6);
   assert(binaries.every(url=>new RegExp(`-[a-f0-9]{16}\\.bin${raw?'':'\\.gz'}$`).test(url)));
   assert.equal(errors.length,0);results.push({engine,mode:raw?'raw':'gzip',warmReload:true,products:stats.products,triangles:stats.triangles,errors});await context.close();
  }
  if(engine==='chromium'){
   console.log('Checking mismatched metadata');
   const page=await browser.newPage();
   let injected=false;page.on('console',m=>console.log('Mismatch console',m.type(),m.text()));
   page.on('pageerror',e=>console.log('Mismatch page error',String(e)));
   await page.route('**/models/mini-*.json',async route=>{const response=await route.fetch(),meta=await response.json();meta.bytes+=4;await route.fulfill({json:meta});injected=true;});
   await page.goto(base);await page.waitForFunction(()=>window.splancReady||document.querySelector('#message').textContent.includes('Unable'),null,{timeout:60000});
   assert(injected);assert.equal(await page.locator('#message').textContent(),'Unable to load the 3D models. Reload to retry.');
   assert.equal(await page.evaluate(()=>!!window.splancReady),false);assert(await page.locator('#fallback').isVisible());
   results.push({mismatchedMetadataRejected:true});await page.close();
  }
 }finally{await browser.close();}
}
await fs.writeFile(out+'/review/model-delivery-validation.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
