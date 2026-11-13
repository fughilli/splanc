const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./blePicker-DjdjLx7_.js","./capacitorImprov-LcXGxwjH.js","./assetBase-C7BP6CBI.js","./improv-QZRBf4Xc.js","./guard-D2g0Xd7k.js","./chunk-QTnfLwEv.js","./kit-YMAAJyzP.js","./bleTransport-CBUs6cQa.js","./nativeBlePlayer-B4F8ibGn.js","./flashSheet-B78v66Pn.js","./webserial-Dt_B3Iz2.js","./env-DizaJSfd.js","./state-DjoB7Qrp.js","./imuCalWriteback-CAb3qBN2.js","./imuExtrinsic-C3sWgyWW.js","./client-BIAFy0X5.js","./proto-Abxnh9zu.js","./firmwareRepo-Dy4McnNK.js","./deviceMapCard-CLncGxqI.js","./mapview-DOAemO49.js"])))=>i.map(i=>d[i]);
import{n as e}from"./chunk-QTnfLwEv.js";import{_ as t,c as n,g as r,h as i,i as a,l as o,m as s,n as c,o as l,p as u,t as d,u as f}from"./kit-YMAAJyzP.js";import{c as p,d as m,f as h,l as g,p as _,s as v,u as y}from"./client-BIAFy0X5.js";import{d as b,h as x,i as S,m as C,p as w,s as T,t as E}from"./state-DjoB7Qrp.js";import{c as ee,d as te,l as ne,o as re,s as ie}from"./improv-QZRBf4Xc.js";import{c as ae}from"./bleTransport-CBUs6cQa.js";import{n as D}from"./assetBase-C7BP6CBI.js";import{a as oe,i as O,l as k,o as se,s as ce,t as le}from"./kiosk-BB4OdQTD.js";var ue=`fughilli/splanc`,de=`https://github.com/${ue}`,fe={gitCommit:`6246321fdbd0bb8a30d47abe22614940414c1697`,gitCommitShort:`6246321f`,gitDirty:!1,version:`0.0.0-dev`};function pe(e){return`${de}/commit/${e}`}function me(e,t){if(!e)return`unknown`;let n=e.slice(0,8);return t?`${n} (dirty)`:n}var he=`unknown (connect once)`;function ge(e){let t=e.fwGitCommit??``,n=t.length>0;return{version:e.fwVersion||he,build:n?me(t,e.fwGitDirty??!1):he,buildUrl:n?pe(t):null,commit:t}}var A=`ledmapper.wifi`,j=`ledmapper.wifiList`,_e=`ledmapper.calibratedK`,M=`ledmapper.theme`,N=`ledmapper.captureLedCount`,P=`ledmapper.manualExposureCeilingMs`,F=`ledmapper.aiHintDismissed`,I=`ledmapper.diffuseCapture`,L=`ledmapper.diffuseParams`,R=`ledmapper.stripPriorOff`,z=.2,B=`ledmapper.minCameraDistM`,ve={anchorDensity:3,lcGain:1,threshold:.18,downscale:2,flipV:!1};function V(e,t,n,r){let i=typeof e==`number`?e:parseFloat(String(e));return Number.isFinite(i)?Math.min(n,Math.max(t,i)):r}function H(e,t){try{let n=localStorage.getItem(e);return n?JSON.parse(n):t}catch{return t}}function U(e,t){try{localStorage.setItem(e,JSON.stringify(t))}catch{}}var W={getWifi(){return H(A,{ssid:``,password:``})},setWifi(e){U(A,e)},getWifiList(){let e=H(j,[]);if(Array.isArray(e)&&e.length>0)return e.filter(e=>e&&e.ssid);let t=this.getWifi();return t.ssid?[t]:[]},addWifi(e){if(!e.ssid)return;let t=this.getWifiList().filter(t=>t.ssid!==e.ssid);t.unshift(e),U(j,t.slice(0,8)),this.setWifi(e)},getCalibratedK(){return H(_e,null)??void 0},getCaptureLedCount(){let e=localStorage.getItem(N),t=e===null?NaN:parseInt(e,10);return Number.isFinite(t)&&t>=1?t:void 0},setCaptureLedCount(e){if(!(!Number.isFinite(e)||e<1))try{localStorage.setItem(N,String(Math.round(e)))}catch{}},getManualExposureCeilingMs(){let e=localStorage.getItem(P),t=e===null?NaN:parseFloat(e);return Number.isFinite(t)&&t>0?t:50},setManualExposureCeilingMs(e){if(!(!Number.isFinite(e)||e<=0))try{localStorage.setItem(P,String(Math.round(e)))}catch{}},getMinCameraDistM(){try{let e=localStorage.getItem(B),t=e===null?NaN:parseFloat(e);return Number.isFinite(t)&&t>=0&&t<=5?t:z}catch{return z}},setMinCameraDistM(e){if(!(!Number.isFinite(e)||e<0||e>5))try{localStorage.setItem(B,String(e))}catch{}},getTheme(){return localStorage.getItem(M)===`light`?`light`:`dark`},setTheme(e){try{localStorage.setItem(M,e)}catch{}},getAiHintDismissed(){return localStorage.getItem(F)===`1`},setAiHintDismissed(){try{localStorage.setItem(F,`1`)}catch{}},getDiffuseEnabled(){return localStorage.getItem(I)===`1`},setDiffuseEnabled(e){try{e?localStorage.setItem(I,`1`):localStorage.removeItem(I)}catch{}},getDiffuseParams(){let e=H(L,{}),t=ve;return{anchorDensity:Math.round(V(e.anchorDensity,3,32,t.anchorDensity)),lcGain:V(e.lcGain,0,4,t.lcGain),threshold:V(e.threshold,.01,1,t.threshold),downscale:Math.round(V(e.downscale,1,8,t.downscale)),flipV:typeof e.flipV==`boolean`?e.flipV:t.flipV}},setDiffuseParams(e){U(L,{...this.getDiffuseParams(),...e})},getStripPrior(){try{return localStorage.getItem(R)!==`1`}catch{return!0}},setStripPrior(e){try{e?localStorage.removeItem(R):localStorage.setItem(R,`1`)}catch{}},resetDiffuseParams(){try{localStorage.removeItem(L)}catch{}}};async function G(){if(te()){let{pickImprovDeviceNative:e}=await D(async()=>{let{pickImprovDeviceNative:e}=await import(`./blePicker-DjdjLx7_.js`);return{pickImprovDeviceNative:e}},__vite__mapDeps([0,1,2,3,4,5,6]),import.meta.url);return e()}return ee()}function K(e,t){let n=f(e===`ble`?`Add device over Bluetooth`:`Add device by address`);n.body.className=`wifi-sheet`;let r=W.getWifiList(),i=r[0]??{ssid:``,password:``},a=document.createElement(`p`);a.className=`wifi-lead`,a.textContent=e===`ble`?`Choose the Wi-Fi network the device should join, then pick it in the Bluetooth chooser.`:`Choose the Wi-Fi network the device is on, then enter its address.`;let s=document.createElement(`div`);s.className=`wifi-picks`;let l=document.createElement(`input`);l.className=`sheet-input`,l.placeholder=`Wi-Fi network (SSID)`,l.value=i.ssid,l.setAttribute(`autocomplete`,`off`),l.setAttribute(`autocapitalize`,`off`),l.setAttribute(`autocorrect`,`off`),l.setAttribute(`spellcheck`,`false`);let u=document.createElement(`input`);u.className=`sheet-input`,u.placeholder=`Wi-Fi password`,u.setAttribute(`aria-label`,`Wi-Fi password`),u.value=i.password;let d=o(u,{autocomplete:`new-password`,className:`sheet-pw`}),p=()=>{s.replaceChildren();for(let e of W.getWifiList()){let t=document.createElement(`button`);t.type=`button`,t.className=`wifi-pick`,e.ssid===l.value&&t.classList.add(`wifi-pick--on`),t.textContent=e.ssid,t.addEventListener(`click`,()=>{l.value=e.ssid,u.value=e.password,p()}),s.appendChild(t)}};p();let m=document.createElement(`div`);m.className=`wifi-status metric`;let h=e=>{m.textContent=e},g=c({label:e===`ble`?`Scan for device`:`Enter address`,icon:e===`ble`?`bluetooth`:`link`,block:!0,onClick:()=>{let r={ssid:l.value.trim(),password:u.value};if(e===`manual`){r.ssid&&W.addWifi(r),n.close(),we(),t?.();return}g.disabled=!0,be(r,h).then(e=>{e?(n.close(),t?.()):g.disabled=!1}).catch(()=>{g.disabled=!1})}});if(n.body.append(a),r.length>0){let e=document.createElement(`div`);e.className=`wifi-cap`,e.textContent=`Saved networks`,n.body.append(e,s)}n.body.append(l,d.el,g,m),l.focus()}function ye(e,t){(async()=>{let n;try{n=await G()}catch(e){J(e)||r(`Bluetooth: ${q(e)}`,{error:!0});return}if(e?.bleId&&n.id&&n.id!==e.bleId&&!await i({title:`Different device?`,message:`The device you picked${n.name?` ("${n.name}")`:``} doesn't look like "${e.label}" — it's a different Bluetooth device. Setting it up will connect to it and may overwrite "${e.label}"'s name. Continue?`,confirmLabel:`Continue`,danger:!0}))return;let a=W.getWifiList()[0];if(!a||!a.ssid){r(`Pick a Wi-Fi network first`,{error:!0}),K(`ble`,t);return}try{await xe(n,a,e=>r(e)),t?.()}catch(e){r(`Setup failed: ${q(e)}`,{error:!0})}})()}async function be(e,t){let n;try{n=await G()}catch(e){return J(e)||t(`Bluetooth: ${q(e)}`),!1}if(!e.ssid)return t(`Enter a Wi-Fi network name.`),!1;try{return await xe(n,e,t),!0}catch(e){return t(`Setup failed: ${q(e)}`),!1}}async function xe(e,t,n){let i=await ie(e,t.ssid,t.password,n);W.addWifi(t);let a=i.map(e=>re(e)).find(e=>e!==null);if(a){n(`Bridge joined ${t.ssid} (${a}).`),r(`Bridge is on ${t.ssid}. Not paired yet? Open Live via bridge and enter the code on its screen.`);return}let o=i.map(e=>ne(e)).find(e=>e!==null);if(!o)throw Error(`device joined but sent no usable address (${i})`);n(`Provisioned at ${o} — connecting…`),E.connect(o),e.id&&x.setBleId(o,e.id),r(`Device provisioned`)}function Se(e){(async()=>{let{requestBleDevice:t,bleSocketFactory:n,bleDeviceUrl:i,BLE_UPLOAD_CHUNK_BYTES:a}=await D(async()=>{let{requestBleDevice:e,bleSocketFactory:t,bleDeviceUrl:n,BLE_UPLOAD_CHUNK_BYTES:r}=await import(`./bleTransport-CBUs6cQa.js`).then(e=>e.s);return{requestBleDevice:e,bleSocketFactory:t,bleDeviceUrl:n,BLE_UPLOAD_CHUNK_BYTES:r}},__vite__mapDeps([7,5,2,4,3]),import.meta.url),o;try{o=te()?await Ce():await t()}catch(e){J(e)||r(`Bluetooth: ${q(e)}`,{error:!0});return}let s=o.name||`Bluetooth device`,c=i(o);r(`Connecting over Bluetooth…`),E.connect(c,s,{socketFactory:n(o),coldRetryLimit:6,uploadChunkBytes:a}),o.id&&x.setBleId(c,o.id),e?.()})()}async function Ce(){let[{loadNativeBle:e,nativeBleDevice:t},{pickNativeBleDevice:n}]=await Promise.all([D(()=>import(`./nativeBlePlayer-B4F8ibGn.js`),__vite__mapDeps([8,2,7,5,4,3]),import.meta.url),D(()=>import(`./blePicker-DjdjLx7_.js`),__vite__mapDeps([0,1,2,3,4,5,6]),import.meta.url)]),r=await e();return n(async(e,n)=>t(r,e,n),{title:`Connect over Bluetooth`,prompt:`Tap the device to connect:`})}function we(){let e=prompt(`Device address (wss://host:port):`,`wss://`);if(e){if(!/^wss?:\/\//.test(e)){r(`Address must start with ws:// or wss://`,{error:!0});return}E.connect(e)}}function q(e){return e instanceof Error?e.message:String(e)}function J(e){return e instanceof DOMException&&(e.name===`NotFoundError`||e.name===`AbortError`)}function Te(e){let n=f(e.title??`Move to folder`);n.body.className=`folder-picker`;let r=t=>{n.close(),e.onPick(t)},i=document.createElement(`div`);i.className=`folder-list`;let a=(n,i,a)=>{let o=document.createElement(`button`);o.type=`button`,o.className=`folder-row`+(i===e.current?` folder-row--on`:``),o.append(t(a));let s=document.createElement(`span`);return s.textContent=n,o.appendChild(s),o.addEventListener(`click`,()=>r(i)),o};i.appendChild(a(`Ungrouped`,``,`close`));for(let t of e.existing)i.appendChild(a(t,t,`folder`));let o=document.createElement(`div`);o.className=`folder-new`;let s=document.createElement(`input`);s.className=`sheet-input`,s.placeholder=`New folder name…`;let l=()=>{let e=s.value.trim();e&&r(e)};s.addEventListener(`keydown`,e=>{e.key===`Enter`&&(e.preventDefault(),l())}),o.append(s,c({label:`Create`,onClick:l})),n.body.append(i,o)}var Ee=`ledmapper.foldersCollapsed`;function De(){try{let e=localStorage.getItem(Ee),t=e?JSON.parse(e):[];return new Set(Array.isArray(t)?t:[])}catch{return new Set}}function Oe(e){try{localStorage.setItem(Ee,JSON.stringify([...e]))}catch{}}function ke(e,n,r,i,a){let o=new Map,s=[];for(let e of n){let t=(r(e)??``).trim();if(t){let n=o.get(t)??[];n.push(e),o.set(t,n)}else s.push(e)}let c=o.size>0,l=De(),u=(n,r,o=!1)=>{let s=`${a.scope}:${n}`,c=l.has(s),u=document.createElement(`button`);u.type=`button`,u.className=`folder-header`+(o?` folder-header--muted`:``);let d=t(`chevron`);d.classList.add(`folder-chevron`),u.append(d),o||u.append(t(`folder`));let f=document.createElement(`span`);f.className=`folder-header-name`,f.textContent=n;let p=document.createElement(`span`);p.className=`folder-count`,p.textContent=String(r.length),u.append(f,p),e.appendChild(u);let m=[];for(let t of r){let n=i(t);m.push(n),e.appendChild(n)}let h=()=>{u.classList.toggle(`folder-header--collapsed`,c);for(let e of m)e.classList.toggle(`folder-hidden`,c)};h(),u.addEventListener(`click`,()=>{c=!c,c?l.add(s):l.delete(s),Oe(l),h()})};for(let e of[...o.keys()].sort((e,t)=>e.localeCompare(t)))u(e,o.get(e));if(s.length>0)if(c)u(`Ungrouped`,s,!0);else for(let t of s)e.appendChild(i(t))}var Ae={auto:`Auto`,fixed:`Fixed`,manual:`Manual`,offline:`Offline`},je={auto:`Rescans soon after losing the network, backing off to the cap and keeping that pace. Optionally slows down after a long absence (off unless you set the hours below).`,fixed:`Rescans at a steady interval while the network is missing.`,manual:`Never looks for the network on its own — only when you tap Rejoin now.`,offline:`Forward-deployed: Wi-Fi radio off, credentials kept. Change it over Bluetooth or the console.`},Me=[{key:`scanCapS`,label:`Longest wait between scans (s)`,min:10,max:86400,modes:[`auto`]},{key:`decayAfterH`,label:`Slow down after unseen for (h, 0 = off)`,min:0,max:8760,modes:[`auto`]},{key:`sparseIntervalS`,label:`Slowed scan interval (s)`,min:60,max:86400,modes:[`auto`]},{key:`intervalS`,label:`Scan interval (s)`,min:10,max:86400,modes:[`fixed`]}];function Ne(e,t){let n=document.createElement(`div`);n.className=`wifi-policy`;let o=null,u=`auto`,d=!1,f=new Map,b=e=>{o=e,u=e.mode,t?.(e),x()},x=()=>{n.replaceChildren(),f.clear();let e=document.createElement(`div`);if(e.className=`device-detail-cap wifi-policy-title`,e.textContent=`Wi-Fi rejoin`,n.append(e),!o){let e=document.createElement(`div`);e.className=`wifi-policy-status`,e.textContent=`Reading Wi-Fi settings…`,n.append(e);return}let t=document.createElement(`div`);t.className=`wifi-policy-status`;let r=o.scans>0&&o.state===`searching`?` · ${o.scans} scans`:``;t.textContent=y(o)+r,n.append(t),o.otaPending&&n.append(Pe(v));let i=document.createElement(`div`);i.className=`wifi-policy-modes`;for(let e of p)i.append(a({label:Ae[e],on:e===u,onClick:()=>{u=e,x()}}));n.append(i);let s=document.createElement(`div`);s.className=`device-detail-cap`,s.textContent=je[u],n.append(s);for(let e of Me){if(!e.modes.includes(u))continue;let t=l({label:e.label,type:`number`,value:String(o[e.key])});t.input.inputMode=`numeric`,t.input.min=String(e.min),t.input.max=String(e.max),f.set(e.key,t.input),n.append(t.el)}let m=document.createElement(`div`);m.className=`wifi-policy-btns`;let h=c({label:`Apply`,variant:`primary`,disabled:d,onClick:()=>void w()});m.append(h),u!==`offline`&&o.mode!==`offline`&&m.append(c({label:`Rejoin now`,variant:`quiet`,disabled:d,onClick:()=>void T()})),n.append(m)},S=async e=>{if(!d){d=!0,x();try{await e()}catch(e){r(`Wi-Fi settings: ${e instanceof Error?e.message:String(e)}`,{error:!0})}finally{d=!1,x()}}},C=async e=>await s({title:`Update awaiting confirmation`,message:`A firmware update is installed but not yet confirmed. Keep the device online until the update is confirmed, so its networking gets checked before the device leaves the network. Confirm the update first, while the device is still online, then switch to ${Ae[e]}.`,choices:[{id:`stay`,label:`Stay online`,variant:`primary`},{id:`force`,label:e===`offline`?`Go offline anyway`:`Switch anyway`,variant:`danger`}]})===`force`?i({title:`Skip the update check?`,message:`Without a network the update is confirmed on rendering alone, so its Wi-Fi is never checked. If it later can't rejoin, recover the device over Bluetooth, the console or USB.`,confirmLabel:e===`offline`?`Go offline anyway`:`Switch anyway`,danger:!0}):!1,w=()=>S(async()=>{if(!o)return;let t={mode:u};for(let e of Me){let n=f.get(e.key);if(!n)continue;let i=m(n.value);if(i===null||i<e.min||i>e.max){r(`${e.label}: enter ${e.min}–${e.max}`,{error:!0});return}t[e.key]=i}let n=h(o.mode,u);if(n&&!await i({...n,confirmLabel:u===`offline`?`Go offline`:`Switch to manual`,danger:u===`offline`}))return;if(_(u)&&u!==o.mode&&o.otaPending){if(!await C(u))return;t.force=!0}let a=await e.setWifiPolicy(t);if(a.refused===`ota_pending`&&!t.force){if(b(a),!await C(u))return;a=await e.setWifiPolicy({...t,force:!0})}b(a),a.refused?r(`Not applied: ${a.refused===`ota_pending`?`an update is awaiting confirmation`:a.refused}`,{error:!0}):a.mode===`offline`?r(`Offline mode on — use Bluetooth or the console to change it`):r(`Wi-Fi settings saved`)}),T=()=>S(async()=>{let t=await e.setWifiPolicy({rejoinNow:!0});b(t),r(t.nextScanS>0?`Rejoining — next scan in ${g(t.nextScanS)}`:`Rejoining…`)});return x(),e.getWifiPolicy().then(b,e=>{n.replaceChildren();let t=document.createElement(`div`);t.className=`device-detail-cap`,t.textContent=`Wi-Fi settings unavailable (${e instanceof Error?e.message:String(e)})`,n.append(t)}),n}function Pe(e){let t=document.createElement(`div`);return t.className=`k-card wifi-policy-warn`,t.style.borderColor=`var(--warn)`,t.textContent=e,t}var Fe=`rope_start`;function Ie(e){let t=t=>Math.max(0,e.find(e=>e.channel===t)?.ledCount??0);return t(1)>0?t(0):0}function Le(e,t){return{...e.uniforms,[Fe]:t}}var Re=[{id:`pumpkin-candles`,name:`Pumpkin Candles`,emoji:`🕯️`,sliders:[`speed`,`warmth`],uniforms:{speed:1,warmth:.4},source:`// Jack-o'-lantern candles: warm orange flicker in patches, like candles inside pumpkins.
// The rope glows like embers.
uniform float speed : 0.2 .. 3.0 = 1.0;
uniform float warmth : 0.0 .. 1.0 = 0.4;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed hue;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 1.3));
  ph2 = fract(ph2 + fixed(dt * speed * 0.41));
  hue = fixed(0.025 + warmth * 0.08);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  // a flame "patch" id from the LED's 3D cell (~25 cm), cached once per LED
  fixed r = fixed(hash(floor(led.pos.x * 4.0) + floor(led.pos.y * 4.0) * 17.0 + floor(led.pos.z * 4.0) * 131.0));
  fixed j = fixed(hash(float(led.idx)));
  fixed h = fixed(led.uv.y);
  fixed f = sin(ph + r) * fixed(0.22) + sin(ph2 * fixed(3.0) + r * fixed(2.0)) * fixed(0.14) + fixed(0.62) + j * fixed(0.1);
  fixed v = clamp(f * (fixed(1.0) - h * fixed(0.45)), fixed(0.0), fixed(1.0));
  if (led.idx >= rope_i) { v = v * fixed(0.45); }
  return hsv2rgb(hue + j * fixed(0.025), fixed(1.0), v * v);
}
`},{id:`graveyard-fog`,name:`Graveyard Fog`,emoji:`🌫️`,sliders:[`speed`,`green`],uniforms:{speed:.3,green:.5},source:`// Graveyard fog: purple and green fog banks rolling low across the curtain; the rope is the ground mist.
uniform float speed : 0.05 .. 1.0 = 0.3;
uniform float green : 0.0 .. 1.0 = 0.5;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed g;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.5));
  ph2 = fract(ph2 + fixed(dt * speed * 0.23));
  g = fixed(green);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed u = fixed((led.pos.x + led.pos.z) * 0.7);
  fixed r = fixed(hash(floor(led.pos.x * 3.0) + floor(led.pos.y * 3.0) * 17.0 + floor(led.pos.z * 3.0) * 131.0));
  fixed h = fixed(led.uv.y);
  fixed w = sin(u + h * fixed(0.3) - ph + r * fixed(0.15)) * fixed(0.5) + fixed(0.5);
  fixed w2 = sin(ph2 - u * fixed(0.6) + h * fixed(0.4)) * fixed(0.5) + fixed(0.5);
  fixed hue = mix(fixed(0.79), fixed(0.36), clamp(w2 * g * fixed(2.0), fixed(0.0), fixed(1.0)));
  fixed v = (w * fixed(0.75) + fixed(0.1)) * (fixed(1.05) - h * fixed(0.6));
  if (led.idx >= rope_i) { v = w * fixed(0.5) + fixed(0.2); }
  return hsv2rgb(hue, fixed(0.85), v * v);
}
`},{id:`thunderstorm`,name:`Thunderstorm`,emoji:`⚡`,sliders:[`storm`,`power`],uniforms:{storm:.45,power:1},source:`// Thunderstorm: a dark stormy blue sky, then lightning strikes that flash and re-flicker across the curtain.
uniform float storm : 0.1 .. 1.0 = 0.45;
uniform float power : 0.2 .. 1.0 = 1.0;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state float wait;
state float flash;
state float re;
state float bolt;
state fixed fl;
state fixed bx;
state fixed ph;
state int rope_i;
void update() {
  wait = wait - dt;
  if (wait <= 0.0) {
    flash = power;
    re = 0.12 + hash(time * 3.1) * 0.15;
    bolt = hash(time * 7.3);
    wait = 0.5 + hash(time * 1.7) * 5.0 / storm;
  }
  if (re > 0.0) {
    re = re - dt;
    if (re <= 0.0) { flash = power * 0.8; }
  }
  flash = max(flash - dt * 4.0 * flash - dt * 0.2, 0.0);
  fl = fixed(flash);
  bx = fixed(bolt);
  ph = fract(ph + fixed(dt * 0.07));
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed r = fixed(hash(floor(led.pos.x * 5.0) + floor(led.pos.y * 5.0) * 17.0 + floor(led.pos.z * 5.0) * 131.0));
  fixed h = fixed(led.uv.y);
  // the bolt's reach: brighter high up and in this strike's random patch set
  fixed reach = clamp(h * fixed(0.8) + fixed(0.5) - abs(r - bx) * fixed(1.6), fixed(0.0), fixed(1.0));
  fixed s = fl * reach;
  fixed amb = (sin(ph + r * fixed(0.5)) * fixed(0.5) + fixed(0.5)) * fixed(0.06) + fixed(0.03);
  if (led.idx >= rope_i) { s = fl * fixed(0.4); }
  fixed v = clamp(amb + s, fixed(0.0), fixed(1.0));
  return hsv2rgb(fixed(0.64), fixed(0.9) - s * fixed(0.85), v);
}
`},{id:`ghost-wisps`,name:`Ghost Wisps`,emoji:`👻`,sliders:[`speed`,`ghosts`],uniforms:{speed:.35,ghosts:.5},source:`// Ghost wisps: pale ghosts drift up the curtain and fade; faint violet spirits slide along the rope.
uniform float speed : 0.05 .. 1.0 = 0.35;
uniform float ghosts : 0.1 .. 1.0 = 0.5;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed amt;
state int rope_i;
state fixed inv_len;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.5));
  amt = fixed(ghosts);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed r = fixed(hash(floor((led.pos.x + led.pos.z) * 6.0) + floor(led.pos.z * 4.0) * 31.0));
  fixed h = fixed(led.uv.y);
  fixed y = fract(ph - h * fixed(0.7) - r);
  fixed v = clamp(fixed(1.0) - y * fixed(5.0), fixed(0.0), fixed(1.0));
  v = v * v * step(r * fixed(1.4), amt + fixed(0.2));
  fixed sat = fixed(0.25);
  if (led.idx >= rope_i) {
    fixed q = fract(ph * fixed(2.0) - fixed(float(led.idx) * 0.03));
    v = clamp(fixed(1.0) - q * fixed(4.0), fixed(0.0), fixed(1.0)) * fixed(0.6);
    sat = fixed(0.6);
  }
  return hsv2rgb(fixed(0.55) + v * fixed(0.2), sat, v + fixed(0.02));
}
`},{id:`toxic-ooze`,name:`Toxic Ooze`,emoji:`🧪`,sliders:[`speed`,`glow`],uniforms:{speed:.3,glow:.8},source:`// Toxic ooze: radioactive green slime drips down the curtain into a bubbling pool on the rope.
uniform float speed : 0.05 .. 1.0 = 0.3;
uniform float glow : 0.2 .. 1.0 = 0.8;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed gl;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.35));
  ph2 = fract(ph2 + fixed(dt * 0.4));
  gl = fixed(glow);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  // drip column: a ~10 cm horizontal cell; its rate (1..3 drips per cycle) and offset
  fixed r = fixed(hash(floor((led.pos.x + led.pos.z) * 9.0)));
  fixed k = floor(r * fixed(3.0)) + fixed(1.0);
  fixed h = fixed(led.uv.y);
  fixed d = fract(ph * k + r * fixed(7.0));
  fixed head = fixed(1.0) - d * fixed(1.2);
  fixed t = h - head;
  fixed drip = clamp(fixed(1.0) - t * fixed(3.0), fixed(0.0), fixed(1.0)) * step(fixed(0.0), t);
  fixed slime = clamp((h - fixed(0.82)) * fixed(6.0), fixed(0.0), fixed(1.0)) * (sin(ph2 + r) * fixed(0.3) + fixed(0.7));
  fixed v = max(drip, slime);
  if (led.idx >= rope_i) { v = sin(ph2 * fixed(3.0) + r * fixed(2.0)) * fixed(0.3) + fixed(0.6); }
  return hsv2rgb(fixed(0.3) - v * fixed(0.06), fixed(1.0), (v * fixed(0.95) + fixed(0.05)) * gl);
}
`},{id:`eyes-in-the-dark`,name:`Eyes in the Dark`,emoji:`👀`,sliders:[`eyes`,`blink`],uniforms:{eyes:.5,blink:.6},source:`// Eyes in the dark: pairs of glowing eyes open in the curtain, blink, and vanish; the rope smoulders red.
uniform float eyes : 0.1 .. 1.0 = 0.5;
uniform float blink : 0.1 .. 2.0 = 0.6;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ep;
state fixed bl;
state fixed amt;
state fixed ph;
state int rope_i;
void update() {
  ep = fract(ep + fixed(dt * 0.05));
  bl = fract(bl + fixed(dt * blink * 0.5));
  amt = fixed(eyes * 0.5);
  ph = fract(ph + fixed(dt * 0.2));
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  // a creature cell ~30 cm wide x 20 cm tall; its eyes are the upper-left/right quarters
  float cu = (led.pos.x + led.pos.z) * 3.3;
  float cv = led.pos.y * 5.0;
  fixed r = fixed(hash(floor(cu) + floor(cv) * 57.0));
  fixed eye = fixed(step(0.4, fract(cv)) * step(abs(fract(cu) - 0.5), 0.42) * step(0.08, abs(fract(cu) - 0.5)));
  fixed life = fract(ep + r * fixed(3.0));
  fixed open = clamp(fixed(1.0) - abs(life - amt * fixed(0.5)) / (amt * fixed(0.5) + fixed(0.01)), fixed(0.0), fixed(1.0));
  fixed bk = step(fixed(0.06), fract(bl + r * fixed(5.0)));
  fixed v = clamp(open * fixed(3.0), fixed(0.0), fixed(1.0)) * bk * eye;
  fixed hue = r * fixed(0.18);
  if (led.idx >= rope_i) {
    v = (sin(ph + r) * fixed(0.25) + fixed(0.35));
    hue = fixed(0.0);
  }
  return hsv2rgb(hue, fixed(1.0), max(v, fixed(0.015)));
}
`},{id:`rope-snake`,name:`Rope Snake`,emoji:`🐍`,sliders:[`speed`,`length`],uniforms:{speed:.6,length:.2},source:`// Rope snake: a green serpent slithers along the rope while the curtain breathes a slow purple.
uniform float speed : 0.1 .. 2.0 = 0.6;
uniform float length : 0.05 .. 0.6 = 0.2;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed il;
state int rope_i;
state fixed inv_n;
state fixed start;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.25));
  ph2 = fract(ph2 + fixed(dt * 0.12));
  il = fixed(1.0 / length);
  rope_i = int(rope_start);
  start = fixed(rope_start);
  inv_n = fixed(1.0 / max(float(led.count) - rope_start, 1.0));
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed h = fixed(led.uv.y);
  fixed r = fixed(hash(float(led.idx)));
  if (led.idx >= rope_i) {
    fixed s = (fixed(led.idx) - start) * inv_n;
    fixed d = fract(ph - s);
    fixed v = clamp(fixed(1.0) - d * il, fixed(0.0), fixed(1.0));
    fixed scales = sin(s * fixed(25.0)) * fixed(0.25) + fixed(0.75);
    return hsv2rgb(fixed(0.3) + v * fixed(0.05), fixed(1.0), v * scales + fixed(0.02));
  }
  fixed b = sin(ph2 + h * fixed(0.5) + r * fixed(0.2)) * fixed(0.5) + fixed(0.5);
  return hsv2rgb(fixed(0.77), fixed(0.9), b * b * fixed(0.5) + fixed(0.04));
}
`},{id:`haunted-glow`,name:`Haunted Glow`,emoji:`🎃`,sliders:[`speed`,`level`],uniforms:{speed:.25,level:.8},attract:!0,source:`// Haunted glow (attract show): calm, slowly shifting pumpkin orange, witchy purple and slime green; embers drift along the rope.
uniform float speed : 0.05 .. 1.0 = 0.25;
uniform float level : 0.2 .. 1.0 = 0.8;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed lv;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.08));
  ph2 = fract(ph2 + fixed(dt * speed * 0.3));
  lv = fixed(level);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed r = fixed(hash(floor(led.pos.x * 3.0) + floor(led.pos.y * 3.0) * 17.0 + floor(led.pos.z * 3.0) * 131.0));
  fixed h = fixed(led.uv.y);
  // three-colour cycle: orange 0.06 -> purple 0.78 -> green 0.33, picked by a slow wave
  fixed w = fract(ph + h * fixed(0.25) + r * fixed(0.08));
  fixed hue = fixed(0.06);
  if (w > fixed(0.333)) { hue = fixed(0.78); }
  if (w > fixed(0.667)) { hue = fixed(0.36); }
  fixed b = sin(ph2 + r * fixed(0.6) + h * fixed(0.3)) * fixed(0.3) + fixed(0.7);
  if (led.idx >= rope_i) {
    hue = fixed(0.05);
    b = sin(ph2 * fixed(4.0) - fixed(led.idx) * fixed(0.05)) * fixed(0.4) + fixed(0.5);
  }
  return hsv2rgb(hue, fixed(0.95), b * b * lv);
}
`}];function Y(e){return Array.isArray(e)?e:[e]}function ze(e,t,n={}){let r=[];for(let i of e.sliders){if(r.length>=2)break;let a=t.find(e=>e.name===i);if(!a||a.width!==1||a.ui.kind!==`slider`)continue;let{min:o,max:s}=a.ui,c=e.uniforms[i],l=n[i]??(c===void 0?void 0:Y(c)[0])??a.default[0]??o,u=a.ui.step>0?a.ui.step:(s-o)/100;r.push({name:i,slot:a.slot,min:o,max:s,step:u,value:Math.min(s,Math.max(o,l))})}return r}function Be(e,t,n={}){return t.map(t=>{let r=t.default.slice(),i=e.uniforms[t.name];i!==void 0&&Y(i).length===t.width&&(r=Y(i).slice());let a=n[t.name];return a!==void 0&&t.width===1&&(r=[a]),{slot:t.slot,value:r}})}function Ve(e){return`boo-${e.id}`}function He(e,t=Re){let n=t.find(t=>Ve(t)===e||t.id===e);return n?`${n.emoji} ${n.name}`:e}var Ue=`splanc.kioskSecrets.v1`;function X(){try{let e=localStorage.getItem(Ue),t=e?JSON.parse(e):{};return t&&typeof t==`object`?t:{}}catch{return{}}}function We(e){try{localStorage.setItem(Ue,JSON.stringify(e))}catch{}}function Ge(e=Ke){return Array.from(e(16),e=>e.toString(16).padStart(2,`0`)).join(``)}function Ke(e){let t=new Uint8Array(e);return crypto.getRandomValues(t),t}function Z(e){return e.trim().toUpperCase()}function qe(e){return e?X()[Z(e)]:void 0}function Je(e){let t=X(),n=Z(e),r=t[n];if(r)return r;let i=Ge();return t[n]=i,We(t),i}function Ye(e,t){let n=X();n[Z(e)]=t,We(n)}var Xe=e({kioskStore:()=>Q}),Q=new class{clock=new le;listeners=new Set;revertListeners=new Set;bound=null;boundConnected=!1;unsubs=[];started=!1;start(){this.started||(this.started=!0,E.subscribe(()=>this.follow()),this.follow())}get active(){return this.clock.status?.enabled===!0}get status(){return this.clock.status}remaining(){return this.clock.remaining()}subscribe(e){return this.listeners.add(e),()=>this.listeners.delete(e)}onRevert(e){return this.revertListeners.add(e),()=>this.revertListeners.delete(e)}apply(e){let t=this.clock.sync(e);if(this.emit(),t)for(let t of this.revertListeners)t(e)}async refresh(){let e=this.bound;if(!(!e?.isConnected||!O(e.welcome)))try{let t=k(await e.getKioskStatus());t&&this.apply(t)}catch{}}emit(){for(let e of this.listeners)e()}follow(){let e=E.client,t=E.status.state===`connected`;if(!(e===this.bound&&t===this.boundConnected)){if(e!==this.bound){for(let e of this.unsubs)e();this.unsubs=[],this.clock.clear(),this.bound=e,e&&this.unsubs.push(e.onKioskStatus(e=>{let t=k(e);t&&this.apply(t)}),e.onActivity(()=>{this.clock.noteActivity(),this.emit()})),this.emit()}if(this.boundConnected=t,e&&t){let t=ce(e.welcome);t?this.apply(t):this.refresh()}}}},Ze=!1;function Qe(){if(Ze||typeof document>`u`)return;Ze=!0;let e=document.createElement(`style`);e.textContent=$e,document.head.appendChild(e)}var $e=`
.screen--play {
  --boo-orange: #ff7a1a;
  --boo-purple: #8b3dff;
  --boo-green: #5dff8a;
  --boo-bg: #0b0710;
  --boo-card: #1a1222;
  --boo-text: #fff4e8;
  --boo-dim: #c9b8d6;
  min-height: 100dvh;
  box-sizing: border-box;
  padding: max(12px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom));
  background:
    radial-gradient(120% 60% at 50% -10%, rgba(139, 61, 255, 0.35), transparent 70%),
    var(--boo-bg);
  color: var(--boo-text);
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 560px;
  margin: 0 auto;
  animation: none;
}
/* Author display rules would otherwise beat the [hidden] attribute. */
.screen--play [hidden] { display: none !important; }
.play-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.play-title {
  font-size: 1.25rem;
  font-weight: 800;
  margin: 0;
  flex: 1;
  letter-spacing: 0.01em;
}
.play-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--boo-card);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 0.9375rem;
  font-weight: 600;
  white-space: nowrap;
  max-width: 55vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
.play-pill-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #777;
  flex: none;
}
.play-pill[data-state="connected"] .play-pill-dot { background: var(--boo-green); box-shadow: 0 0 8px var(--boo-green); }
.play-pill[data-state="connecting"] .play-pill-dot { background: var(--boo-orange); animation: play-blink 1s infinite; }
.play-pill[data-state="error"] .play-pill-dot { background: #ff4d4d; }
@keyframes play-blink { 50% { opacity: 0.3; } }

.play-big {
  appearance: none;
  border: 0;
  border-radius: 20px;
  min-height: 72px;
  padding: 16px 20px;
  font: inherit;
  font-size: 1.375rem;
  font-weight: 800;
  color: #1a0b00;
  background: linear-gradient(180deg, #ffa04d, var(--boo-orange));
  box-shadow: 0 6px 24px rgba(255, 122, 26, 0.35);
  cursor: pointer;
  width: 100%;
  touch-action: manipulation;
}
.play-big:active { transform: translateY(1px) scale(0.99); }
.play-big:disabled { opacity: 0.6; }
.play-big--acid {
  color: #fff;
  background: linear-gradient(135deg, #ff3dd2, var(--boo-purple) 55%, #2fd1ff);
  box-shadow: 0 6px 24px rgba(139, 61, 255, 0.45);
}
.play-connect-card {
  background: var(--boo-card);
  border-radius: 20px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: center;
}
.play-connect-card p { margin: 0; color: var(--boo-dim); font-size: 1rem; line-height: 1.4; }

.play-countdown {
  border-radius: 16px;
  padding: 12px 16px;
  background: rgba(255, 122, 26, 0.12);
  border: 1px solid rgba(255, 122, 26, 0.45);
  font-size: 1.0625rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 10px;
}
.play-countdown-time { font-variant-numeric: tabular-nums; color: var(--boo-orange); }
.play-countdown[data-low="1"] { background: rgba(255, 77, 77, 0.16); border-color: #ff4d4d; }

.play-revert {
  border-radius: 16px;
  padding: 14px 16px;
  background: rgba(93, 255, 138, 0.12);
  border: 1px solid rgba(93, 255, 138, 0.5);
  font-size: 1.0625rem;
  font-weight: 600;
  display: flex;
  gap: 10px;
  align-items: center;
}
.play-revert button {
  margin-left: auto;
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 1.375rem;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
}

.play-hint {
  border-radius: 14px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--boo-dim);
  font-size: 0.875rem;
  line-height: 1.4;
}

.play-preview {
  position: relative;
  height: 180px;
  border-radius: 20px;
  overflow: hidden;
  background: #000;
}
.play-preview canvas { width: 100%; height: 100%; display: block; }

.play-tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.play-tile {
  appearance: none;
  border: 2px solid transparent;
  border-radius: 20px;
  background: var(--boo-card);
  color: var(--boo-text);
  min-height: 112px;
  padding: 14px 10px;
  font: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  touch-action: manipulation;
}
.play-tile-emoji { font-size: 2.5rem; line-height: 1; }
.play-tile-name { font-size: 1.0625rem; font-weight: 700; text-align: center; }
.play-tile[aria-pressed="true"] {
  border-color: var(--boo-orange);
  box-shadow: 0 0 0 4px rgba(255, 122, 26, 0.25), 0 0 24px rgba(255, 122, 26, 0.35);
}
.play-tile:disabled { opacity: 0.5; }
.play-tile[data-busy="1"] .play-tile-emoji { animation: play-blink 0.8s infinite; }

.play-sliders { display: flex; flex-direction: column; gap: 14px; }
.play-slider {
  background: var(--boo-card);
  border-radius: 18px;
  padding: 12px 16px 16px;
}
.play-slider label {
  display: flex;
  justify-content: space-between;
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 8px;
  text-transform: capitalize;
}
.play-slider input[type="range"] {
  width: 100%;
  height: 44px;
  accent-color: var(--boo-orange);
  touch-action: pan-y;
}

.play-exit {
  text-align: center;
  font-size: 0.875rem;
  color: var(--boo-dim);
  text-decoration: underline;
  background: none;
  border: 0;
  padding: 12px;
  cursor: pointer;
  font: inherit;
}

/* Floating kiosk countdown chip (effects workspace / Acid Mode / anywhere but #/play). */
.kiosk-chip {
  position: fixed;
  left: 50%;
  bottom: max(12px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 900;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(20, 10, 26, 0.92);
  border: 1px solid rgba(255, 122, 26, 0.6);
  color: #fff4e8;
  font-size: 0.875rem;
  font-weight: 600;
  max-width: calc(100vw - 32px);
  box-sizing: border-box;
  text-align: center;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.kiosk-chip[hidden] { display: none; }
/* Acid Mode owns the bottom (its big mic): sit under its top bar instead. */
.kiosk-chip--top {
  bottom: auto;
  top: calc(max(12px, env(safe-area-inset-top)) + 6px);
  padding: 6px 10px;
  font-size: 0.8125rem;
  white-space: nowrap;
}

/* Kiosk owner section (device detail). */
.kiosk-section { display: flex; flex-direction: column; gap: 10px; }
.kiosk-section h3 { margin: 0; font-size: 1rem; }
.kiosk-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.kiosk-row label { flex: 1; min-width: 10rem; }
.kiosk-row input[type="number"] { width: 6rem; }
.kiosk-secret { font-family: var(--font-mono, monospace); font-size: 0.8125rem; word-break: break-all; color: var(--text-dim); }
.kiosk-status-line { font-size: 0.875rem; color: var(--text-dim); }
`;function et(e){let t=e?.code;return t===`kiosk_locked`?`the device is locked — unlock it first`:t===`kiosk_bad_secret`?`wrong owner secret (wait a couple of seconds before retrying)`:t===`kiosk_secret_required`?`the device needs an owner secret`:t===`kiosk_no_effect`?`nothing is playing to capture — start an effect first`:t===`kiosk_bad_config`?`the device rejected these settings`:e instanceof Error?e.message:String(e)}function tt(e){if(!e)return`Kiosk: reading…`;if(!e.enabled)return`Kiosk: off`;let t=[`Kiosk: on · idle ${oe(e.idleTimeoutS)}`];return t.push(e.hasAttract||e.attractName?`show: ${He(e.attractName)}`:`no attract show captured`),t.push(e.ownerUnlocked?`unlocked (owner)`:`locked`),t.join(` · `)}function nt(e){Qe();let t=document.createElement(`div`);t.className=`kiosk-section`;let n=e.welcome?.mac??``,a=Q.status,o=!1,s=a?.enabled??!1,d=!(a?.enabled??!1),f=null,p=e=>{let t=k(e);t&&(a=t,s=t.enabled,Q.apply(t),_())},m=async(e,t)=>{if(!o){o=!0,_();try{await t()}catch(t){r(`${e}: ${et(t)}`,{error:!0})}finally{o=!1,_()}}},h=()=>m(`Unlock`,async()=>{let t=qe(n);if(!t){let e=prompt(`Owner secret for this device (from the phone that set up kiosk mode):`)?.trim();if(!e)return;t=e}let i=await e.kioskUnlock(t);if(!i.ownerUnlocked)throw Error(`wrong owner secret`);n&&Ye(n,t),p(i),r(`Unlocked for this connection`)}),g=()=>m(`Kiosk settings`,async()=>{let t=Number(f?.value??120);if(!Number.isFinite(t)||t<10||t>86400){r(`Idle timeout: enter 10–86400 seconds`,{error:!0});return}if(!n)throw Error(`connect once so the device's identity is known`);let o=Je(n);if(a?.enabled&&!a.ownerUnlocked&&!(await e.kioskUnlock(o)).ownerUnlocked)throw Error(`this phone's owner secret doesn't match the device`);s&&!d&&!a?.hasAttract&&await i({title:`No attract show yet`,message:`Kiosk mode reverts to the attract show after the timeout. Capture what's playing now?`,confirmLabel:`Capture current look`,cancelLabel:`Leave as is`})&&(d=!0),p(await e.setKioskConfig(se({enabled:s,idleTimeoutS:t,captureAttractFromCurrent:s&&d,ownerSecret:o}))),d=!1,r(s?`Kiosk mode on`:`Kiosk mode off`)});function _(){t.replaceChildren();let e=document.createElement(`div`);e.className=`device-detail-cap`,e.textContent=`Kiosk mode (public install)`;let i=document.createElement(`div`);i.className=`kiosk-status-line`,i.textContent=tt(a),t.append(e,i);let p=document.createElement(`div`);p.className=`kiosk-row`;let m=document.createElement(`label`);m.textContent=`Visitors can play; owner settings locked`;let v=u({on:s,label:`Kiosk mode`,onChange:e=>{s=e,e&&!a?.enabled&&(d=!0),_()}});p.append(m,v.el),t.append(p);let y=l({label:`Back to the show after (seconds idle)`,type:`number`,value:String(a?.idleTimeoutS??120)});y.input.inputMode=`numeric`,y.input.min=`10`,f=y.input,t.append(y.el);let b=document.createElement(`label`);b.className=`kiosk-row`;let x=document.createElement(`input`);x.type=`checkbox`,x.checked=d,x.addEventListener(`change`,()=>d=x.checked);let S=document.createElement(`span`);S.textContent=`Use the current effect, uniforms and brightness as the attract show`,b.append(x,S),t.append(b);let C=document.createElement(`div`);C.className=`kiosk-row`,C.append(c({label:`Apply`,variant:`primary`,disabled:o,onClick:()=>void g()})),a?.enabled&&!a.ownerUnlocked&&C.append(c({label:`Unlock`,variant:`quiet`,disabled:o,onClick:()=>void h()})),t.append(C);let w=qe(n),T=document.createElement(`div`);T.className=`kiosk-secret`,T.textContent=w?`Owner secret (kept on this phone): ${w}`:`An owner secret is generated on this phone the first time you apply.`,t.append(T),w&&t.append(c({label:`Copy owner secret`,variant:`quiet`,onClick:()=>void navigator.clipboard?.writeText(w).then(()=>r(`Copied — keep it somewhere safe`),()=>r(`Couldn't copy`,{error:!0}))}));let E=document.createElement(`div`);E.className=`device-detail-cap`,E.textContent="Lost the secret? Run `kiosk off` on the device's USB serial console.",t.append(E)}return _(),e.getKioskStatus().then(p).catch(e=>{let n=t.querySelector(`.kiosk-status-line`);n&&(n.textContent=`Kiosk: couldn't read (${et(e)})`)}),t}var $=null,rt=1200;function it(){if($)return;let e=()=>{},t=()=>{},n=()=>{},r=f(`Devices`,{onClose:()=>{e(),t(),n(),$=null}});$=r;let i=()=>{r.body.innerHTML=``,r.body.append(ot())};e=x.subscribe(i),t=E.subscribe(i),n=b.subscribe(i),b.refresh(),i(),at(r.body,()=>b.probeAllNow())}function at(e,t){let n=e.parentElement;if(!n)return;let r=document.createElement(`div`);r.className=`device-ptr`;let i=document.createElement(`div`);i.className=`device-ptr-spin`,r.append(i),n.insertBefore(r,e);let a=0,o=!1,s=!1,c=0,l=e=>{c=e,r.style.height=`${e}px`,i.style.opacity=`${Math.min(1,e/60)}`},u=()=>{r.classList.remove(`device-ptr--active`,`device-ptr--busy`,`device-ptr--done`),r.style.height=``,i.style.opacity=``,c=0,o=!1,s=!1};n.addEventListener(`touchstart`,e=>{s||(o=n.scrollTop<=0&&e.touches.length===1,a=e.touches[0].clientY)},{passive:!0}),n.addEventListener(`touchmove`,e=>{if(!o||s)return;if(n.scrollTop>0){l(0),o=!1;return}let t=e.touches[0].clientY-a;if(t<=0){l(0);return}e.preventDefault(),r.classList.add(`device-ptr--active`),l(Math.min(90,t*.5))},{passive:!1});let d=()=>{!o||s||(r.classList.remove(`device-ptr--active`),c>=60?(s=!0,r.classList.add(`device-ptr--busy`),r.style.height=`60px`,i.style.opacity=`1`,t().finally(()=>{r.classList.remove(`device-ptr--busy`),r.classList.add(`device-ptr--done`),window.setTimeout(u,240)})):u())};n.addEventListener(`touchend`,d),n.addEventListener(`touchcancel`,d)}function ot(){let e=document.createElement(`div`),t=E.status,i=x.activeId(),a=x.list();if(t.certUrl){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--warn)`,n.style.marginBottom=`var(--sp-3)`;let r=document.createElement(`div`);r.className=`device-trust-text`,r.textContent=dt(t.trustKind??`first`,x.active()?.label),r.style.marginBottom=`var(--sp-2)`;let i=c({label:t.trustKind===`again`?`Trust again & connect`:`Trust & connect`,onClick:()=>ft(t.certUrl)}),a=c({label:`Connect over Bluetooth`,onClick:()=>Se()});n.append(r,i,a),e.append(n)}if(t.certChanged){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--err)`,n.style.marginBottom=`var(--sp-3)`;let i=document.createElement(`div`);i.textContent=t.certChanged.message,i.style.marginBottom=`var(--sp-2)`;let a=c({label:`I reset it — trust the new certificate`,onClick:()=>{E.retrustCert(),r(`Certificate re-trusted`)}}),o=c({label:`Disconnect`,onClick:()=>E.disconnect()});n.append(i,a,o),e.append(n)}if(t.error){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--err)`,n.style.color=`var(--err)`,n.style.marginBottom=`var(--sp-3)`,n.textContent=t.error,e.append(n)}if(a.length===0){let t=document.createElement(`div`);t.className=`device-empty`,t.textContent=`No devices yet. Add one to get started.`,e.append(t)}let o=new Map;for(let e of a)o.set(e.label,(o.get(e.label)??0)+1);ke(e,a,e=>e.folder,e=>st(e,e.id===i,t,b.isReachable(e.id),(o.get(e.label)??0)>1),{scope:`devices`});let s=E.client?.welcome;if(s&&((s.features??[]).includes(`ota`)||T(s))){let t=x.get(i??``)?.label||s.deviceName||`this device`,n=c({label:T(s)?`Update firmware — ${t} is in its updater`:`Update firmware`,icon:`chip`,...T(s)?{variant:`primary`}:{},block:!0,onClick:()=>void D(()=>import(`./flashSheet-B78v66Pn.js`).then(e=>e.openFlashSheet()),__vite__mapDeps([9,2,10,11,12,13,5,14,7,4,3,15,16,6,17]),import.meta.url)});n.classList.add(`device-update-fw`),n.title=`Update ${t}'s firmware over Wi-Fi`,e.append(n)}let l=document.createElement(`div`);l.className=`device-add`;let u=document.createElement(`div`);u.className=`device-add-label`,u.textContent=`Add device…`;let d=document.createElement(`div`);return d.className=`device-add-row`,d.append(n(`bluetooth`,{title:`Add device (Bluetooth)`,onClick:()=>K(`ble`)}),n(`plug`,{title:`Connect over Bluetooth (offline)`,onClick:()=>Se()}),n(`link`,{title:`Enter address manually`,onClick:()=>K(`manual`)}),n(`chip`,{title:`Flash a new board (USB)`,onClick:()=>void D(()=>import(`./flashSheet-B78v66Pn.js`).then(e=>e.openFlashSheet()),__vite__mapDeps([9,2,10,11,12,13,5,14,7,4,3,15,16,6,17]),import.meta.url)})),l.append(u,d),e.append(l),e}function st(e,t,r=E.status,i=!1,a=!1){let o=document.createElement(`div`);o.className=`device-row`;let s=t&&r.state===`connected`,c=document.createElement(`span`);c.className=`device-dot`,c.dataset.state=t?r.state:i?`reachable`:`offline`;let l=document.createElement(`div`);l.className=`device-info`;let u=document.createElement(`div`);u.className=`device-name`,u.textContent=e.label;let d=document.createElement(`div`);d.className=`device-url`;let f=t?ct(r):i?`on this network · ${C(e)}`:C(e),p=a?w(e):``;d.textContent=p?`${f} · ${p}`:f,l.append(u,d);let m=document.createElement(`div`);if(m.className=`device-btns`,s)m.append(n(`plug-off`,{title:`Disconnect`,className:`device-disconnect`,onClick:()=>E.disconnect()}));else if(t){let e=n(`plug`,{title:`Connecting… (tap to cancel)`,className:`device-connecting`,onClick:()=>E.disconnect()}),t=typeof performance<`u`?performance.now():0;e.style.setProperty(`--conn-phase`,`-${t%rt}ms`),m.append(e)}else if(i)m.append(n(`plug`,{title:`Connect`,className:`device-connect`,onClick:()=>E.connect(e.wssUrl,e.label)}));else if(ae(e.wssUrl)&&e.lanUrl){let t=e.lanUrl;m.append(n(`plug`,{title:`Connect over Wi-Fi (${ut(t)})`,className:`device-connect`,onClick:()=>E.connect(t,e.label)}),n(`ble-search`,{title:`Find over Bluetooth`,onClick:()=>ye(e)}))}else m.append(n(`ble-search`,{title:`Find over Bluetooth`,onClick:()=>ye(e)}));return m.append(n(`more`,{title:`Options`,onClick:()=>lt(e)})),o.append(c,l,m),o}function ct(e=E.status){let t=E.client;if(!t?.isConnected)return e.text;let n=t.clock.rttMs;return Number.isFinite(n)?`${e.text} · ${Math.round(n)} ms RTT`:e.text}function lt(e){let i=x.get(e.id)??e,a=ge(i),o=f(`Device`);o.body.className=`device-detail`;let s=x.activeId()===e.id&&(E.client?.isConnected??!1),c=i.label,l=(e,t)=>{let n=document.createElement(`div`);n.className=`device-detail-row`;let r=document.createElement(`span`);r.className=`device-detail-cap`,r.textContent=e;let i=document.createElement(`span`);return i.className=`device-detail-val metric`,i.textContent=t,n.append(r,i),n},u=(e,t)=>{if(!t.buildUrl)return l(e,t.build);let n=document.createElement(`div`);n.className=`device-detail-row`;let r=document.createElement(`span`);r.className=`device-detail-cap`,r.textContent=e;let i=document.createElement(`a`);return i.className=`device-detail-val metric about-link`,i.href=t.buildUrl,i.textContent=t.build,i.title=t.commit,i.target=`_blank`,i.rel=`noopener noreferrer`,n.append(r,i),n},p=document.createElement(`div`);p.className=`device-detail-field`;let m=document.createElement(`span`);m.className=`device-detail-cap`,m.textContent=`Display name (also the Bluetooth name)`;let h=document.createElement(`div`);h.className=`device-name-row`,p.append(m,h);let g=t=>{x.rename(e.id,t),s&&E.client?E.client.setDeviceName(t).then(t=>{x.applyWelcome(e.id,{mac:t.mac,deviceName:t.deviceName,fwGitCommit:t.fwGitCommit,fwGitDirty:t.fwGitDirty,fwVersion:t.fwVersion}),x.takePending(e.id),r(`Device renamed`)}).catch(()=>r(`Rename will apply on next connection`)):r(`Name saved — applies on next connection`)},_=()=>{let e=document.createElement(`span`);e.className=`device-name-val`,e.textContent=c;let t=n(`edit`,{title:`Rename`,onClick:()=>v()});h.replaceChildren(e,t)},v=()=>{let e=document.createElement(`input`);e.className=`sheet-input device-name-input`,e.value=c;let t=n(`save`,{title:`Save`,onClick:()=>i(!0)});t.addEventListener(`pointerdown`,e=>{e.preventDefault(),i(!0)});let r=!1,i=t=>{if(r)return;r=!0;let n=e.value.trim();t&&n&&n!==c&&(c=n,g(n)),_()};e.addEventListener(`blur`,()=>i(!1)),e.addEventListener(`keydown`,e=>{e.key===`Enter`?(e.preventDefault(),i(!0)):e.key===`Escape`&&(e.preventDefault(),i(!1))}),h.replaceChildren(e,t),e.focus(),e.select()};_();let b=document.createElement(`hr`);b.className=`device-detail-divider`;let w=d([{label:`Gamma`,icon:`gamma`,onClick:()=>{o.close(),location.hash=`#/settings/color-correction`}},{label:`Hardware`,icon:`chip`,onClick:()=>{o.close(),location.hash=`#/settings/hardware`}},{label:`Move`,icon:`folder`,onClick:()=>{o.close(),Te({current:i.folder??``,existing:x.folders(),onPick:t=>x.setFolder(e.id,t)})}},{label:`Forget`,icon:`trash`,variant:`danger`,onClick:()=>{x.forget(e.id),o.close()}}]),T=E.client;if(s&&T&&(async()=>{if(!await S(T))return;let{calibrateFromDevice:e,deviceMaps:n}=await D(async()=>{let{calibrateFromDevice:e,deviceMaps:t}=await import(`./deviceMapCard-CLncGxqI.js`).then(e=>e.i);return{calibrateFromDevice:e,deviceMaps:t}},__vite__mapDeps([18,5,16,12,13,14,7,2,4,3,15,6,19]),import.meta.url),r=await n.probe(T);if(r.kind!==`saved`&&r.kind!==`unsaved`)return;let i=document.createElement(`button`);i.type=`button`,i.className=`k-actiontile`,i.append(t(`camera`));let a=document.createElement(`span`);a.textContent=`Calibrate IMU`,i.append(a),i.addEventListener(`click`,()=>{i.disabled=!0,a.textContent=`Copying map…`,e(e=>{o.close(),location.hash=`#${e}`}).finally(()=>{i.disabled=!1,a.textContent=`Calibrate IMU`})}),w.insertBefore(i,w.lastElementChild)})(),o.body.append(p,w,b,l(`LAN address`,C(i)),l(`MAC address`,i.bleMac||`unknown (connect once)`),l(`Firmware version`,a.version),u(`Firmware build`,a),l(`Folder`,i.folder||`Ungrouped`)),s&&T&&(T.welcome?.features??[]).includes(`wifi_policy`)){let e=document.createElement(`div`);e.className=`device-detail-wifi`,e.textContent=`Wi-Fi: …`;let t=Ne(T,t=>{e.textContent=y(t),e.dataset.state=t.mode===`offline`?`offline`:t.state,e.dataset.otaPending=String(t.otaPending)}),n=document.createElement(`hr`);n.className=`device-detail-divider`,o.body.append(e,n,t)}if(s&&T&&O(T.welcome)){let e=document.createElement(`hr`);e.className=`device-detail-divider`,o.body.append(e,nt(T))}}function ut(e){try{return new URL(e).host}catch{return e}}function dt(e,t){let n=t||`This device`;return e===`again`?`Couldn't connect to ${n} over Wi-Fi. It serves one Wi-Fi connection at a time: if the Splanc agent, another phone or another browser tab is connected to it, close that and this reconnects by itself. If this browser forgot its certificate (or the device was reset), trust it again.`:`${n} uses a self-signed certificate — trust it once to connect. If its page then says the connection was refused, something else (the Splanc agent, another phone or browser tab) is connected to it: it serves one Wi-Fi connection at a time. Close that, or connect over Bluetooth.`}function ft(e){let t=new URL(e).origin,n=E.client?.url??x.active()?.wssUrl??`wss://${new URL(e).host}/ws`;E.disconnect();let i=null,a=!1,o=null,s=e=>{e.origin===t&&e.data===`ledmapper-cert-ok`&&l(!0)},c=()=>{document.visibilityState===`visible`&&l()},l=(e=!1)=>{if(!a){a=!0,window.removeEventListener(`message`,s),document.removeEventListener(`visibilitychange`,c),o!==null&&window.clearInterval(o);try{i?.close()}catch{}window.setTimeout(()=>E.connect(n,void 0,{coldRetryLimit:6,...e?{trustedBefore:!0}:{}}),800),r(`Certificate trusted — connecting…`)}};if(window.addEventListener(`message`,s),document.addEventListener(`visibilitychange`,c),i=window.open(`about:blank`,`ledmapper-cert`,`width=420,height=560`),i===null){r(`Popup blocked — open the device page, accept the warning, then return`,{error:!0}),window.open(e,`_blank`,`noopener`);return}try{i.document.write(`<!doctype html><meta charset=utf-8><title>Certificate</title><body style='font:15px system-ui;padding:2rem;color:#333'>Preparing the device page…</body>`)}catch{}o=window.setInterval(()=>{let e=!1;try{e=i?.closed===!0}catch{}e&&l()},500),window.setTimeout(()=>{if(!a)try{i.location.href=e}catch{window.open(e,`_blank`,`noopener`)}},900)}function pt(){let e=navigator;return/iP(hone|ad|od)/.test(e.userAgent)||e.platform===`MacIntel`&&(e.maxTouchPoints??0)>1}function mt(e,t){let n=URL.createObjectURL(e),r=document.createElement(`a`);r.href=n,r.download=t,r.rel=`noopener`,r.style.display=`none`,document.body.appendChild(r),r.click(),r.remove(),setTimeout(()=>URL.revokeObjectURL(n),6e4)}async function ht(e,t,n){let r=new Blob([e],{type:n});if(pt()&&typeof File<`u`&&typeof navigator.share==`function`){let e=new File([r],t,{type:n});if(navigator.canShare?.({files:[e]})??!1)try{await navigator.share({files:[e],title:t});return}catch(e){if(e instanceof DOMException&&e.name===`AbortError`)return}}mt(r,t)}var gt=class{worker;nextId=1;pending=new Map;constructor(){this.worker=new Worker(new URL(``+new URL(`compile-worker-Dqj_wlQa.js`,import.meta.url).href,``+import.meta.url),{type:`module`}),this.worker.onmessage=e=>{let t=e.data,n=this.pending.get(t.id);n&&(this.pending.delete(t.id),t.kind===`disassemble`?n(t.text):n(t.result))}}compile(e){let t=this.nextId++,n={id:t,src:e};return new Promise(e=>{this.pending.set(t,e),this.worker.postMessage(n)})}disassemble(e){let t=this.nextId++,n={id:t,kind:`disassemble`,fxb:e};return new Promise(e=>{this.pending.set(t,e),this.worker.postMessage(n)})}dispose(){this.worker.terminate(),this.pending.clear()}};export{pe as S,z as _,Q as a,fe as b,Ve as c,Re as d,Le as f,K as g,Te as h,Qe as i,Be as l,ke as m,ht as n,Xe as o,Ie as p,it as r,He as s,gt as t,ze as u,W as v,me as x,ue as y};