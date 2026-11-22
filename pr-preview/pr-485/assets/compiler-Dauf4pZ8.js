const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./blePicker-BYnb9u3o.js","./capacitorImprov-CsIuRQr7.js","./assetBase-C7BP6CBI.js","./improv--Wah3iBc.js","./guard-D2g0Xd7k.js","./chunk-QTnfLwEv.js","./native-4IISorch.js","./kit-BZRlQmWH.js","./bleTransport-DAtJ-Ii2.js","./nativeBlePlayer-DlyMEqQ4.js","./flashSheet-C09VfkJ-.js","./webserial-DTJTyFgz.js","./env-DizaJSfd.js","./firmwareRepo-Dc2fy2Pb.js","./otaUpdate-CSk3r2AD.js","./state-JJolFGNl.js","./imuCalWriteback-CAb3qBN2.js","./imuExtrinsic-C3sWgyWW.js","./client-BWaN1urO.js","./proto-DYWOnBv4.js","./deviceMapCard-ggc-RE5v.js","./mapview-DOAemO49.js"])))=>i.map(i=>d[i]);
import{n as e}from"./chunk-QTnfLwEv.js";import{d as t}from"./proto-DYWOnBv4.js";import{_ as n,c as r,g as i,h as a,i as o,l as s,m as c,n as l,o as u,p as d,t as f,u as p}from"./kit-BZRlQmWH.js";import{n as m}from"./native-4IISorch.js";import{A as h,D as g,E as _,M as v,N as y,O as b,T as x,j as S,k as C,w}from"./client-BWaN1urO.js";import{c as T,i as E,l as D,o as O,t as k,u as A}from"./state-JJolFGNl.js";import{c as ee}from"./bleTransport-DAtJ-Ii2.js";import{n as j}from"./assetBase-C7BP6CBI.js";import{a as te,c as ne,l as re,s as ie,u as ae}from"./improv--Wah3iBc.js";import{i as M}from"./otaUpdate-CSk3r2AD.js";import{a as oe,i as se,l as N,o as ce,s as le,t as ue}from"./kiosk-BB4OdQTD.js";var de=`fughilli/splanc`,fe=`https://github.com/${de}`,pe={gitCommit:`e7b91b8aef5a0f369dc570dd6276a2f21f139e1d`,gitCommitShort:`e7b91b8a`,gitDirty:!1,version:`0.0.0-dev`};function me(e){return`${fe}/commit/${e}`}function he(e,t){if(!e)return`unknown`;let n=e.slice(0,8);return t?`${n} (dirty)`:n}var ge=`unknown (connect once)`;function _e(e){let t=e.fwGitCommit??``,n=t.length>0;return{version:e.fwVersion||ge,build:n?he(t,e.fwGitDirty??!1):ge,buildUrl:n?me(t):null,commit:t}}var ve=`ledmapper.wifi`,ye=`ledmapper.wifiList`,be=`ledmapper.calibratedK`,xe=`ledmapper.theme`,Se=`ledmapper.captureLedCount`,Ce=`ledmapper.manualExposureCeilingMs`,we=`ledmapper.aiHintDismissed`,P=`ledmapper.diffuseCapture`,Te=`ledmapper.diffuseParams`,F=`ledmapper.stripPriorOff`,I=.2,Ee=`ledmapper.minCameraDistM`,De={anchorDensity:3,lcGain:1,threshold:.18,downscale:2,flipV:!1};function L(e,t,n,r){let i=typeof e==`number`?e:parseFloat(String(e));return Number.isFinite(i)?Math.min(n,Math.max(t,i)):r}function R(e,t){try{let n=localStorage.getItem(e);return n?JSON.parse(n):t}catch{return t}}function z(e,t){try{localStorage.setItem(e,JSON.stringify(t))}catch{}}var B={getWifi(){return R(ve,{ssid:``,password:``})},setWifi(e){z(ve,e)},getWifiList(){let e=R(ye,[]);if(Array.isArray(e)&&e.length>0)return e.filter(e=>e&&e.ssid);let t=this.getWifi();return t.ssid?[t]:[]},addWifi(e){if(!e.ssid)return;let t=this.getWifiList().filter(t=>t.ssid!==e.ssid);t.unshift(e),z(ye,t.slice(0,8)),this.setWifi(e)},getCalibratedK(){return R(be,null)??void 0},getCaptureLedCount(){let e=localStorage.getItem(Se),t=e===null?NaN:parseInt(e,10);return Number.isFinite(t)&&t>=1?t:void 0},setCaptureLedCount(e){if(!(!Number.isFinite(e)||e<1))try{localStorage.setItem(Se,String(Math.round(e)))}catch{}},getManualExposureCeilingMs(){let e=localStorage.getItem(Ce),t=e===null?NaN:parseFloat(e);return Number.isFinite(t)&&t>0?t:50},setManualExposureCeilingMs(e){if(!(!Number.isFinite(e)||e<=0))try{localStorage.setItem(Ce,String(Math.round(e)))}catch{}},getMinCameraDistM(){try{let e=localStorage.getItem(Ee),t=e===null?NaN:parseFloat(e);return Number.isFinite(t)&&t>=0&&t<=5?t:I}catch{return I}},setMinCameraDistM(e){if(!(!Number.isFinite(e)||e<0||e>5))try{localStorage.setItem(Ee,String(e))}catch{}},getTheme(){return localStorage.getItem(xe)===`light`?`light`:`dark`},setTheme(e){try{localStorage.setItem(xe,e)}catch{}},getAiHintDismissed(){return localStorage.getItem(we)===`1`},setAiHintDismissed(){try{localStorage.setItem(we,`1`)}catch{}},getDiffuseEnabled(){return localStorage.getItem(P)===`1`},setDiffuseEnabled(e){try{e?localStorage.setItem(P,`1`):localStorage.removeItem(P)}catch{}},getDiffuseParams(){let e=R(Te,{}),t=De;return{anchorDensity:Math.round(L(e.anchorDensity,3,32,t.anchorDensity)),lcGain:L(e.lcGain,0,4,t.lcGain),threshold:L(e.threshold,.01,1,t.threshold),downscale:Math.round(L(e.downscale,1,8,t.downscale)),flipV:typeof e.flipV==`boolean`?e.flipV:t.flipV}},setDiffuseParams(e){z(Te,{...this.getDiffuseParams(),...e})},getStripPrior(){try{return localStorage.getItem(F)!==`1`}catch{return!0}},setStripPrior(e){try{e?localStorage.removeItem(F):localStorage.setItem(F,`1`)}catch{}},resetDiffuseParams(){try{localStorage.removeItem(Te)}catch{}}},V=null,H={get(){return V?{...V}:null},set(e){V={ssid:e.ssid,password:e.password}},clear(){V=null}};async function Oe(){if(m()){let{pickImprovDeviceNative:e}=await j(async()=>{let{pickImprovDeviceNative:e}=await import(`./blePicker-BYnb9u3o.js`);return{pickImprovDeviceNative:e}},__vite__mapDeps([0,1,2,3,4,5,6,7]),import.meta.url);return e()}return re()}function U(e,t,n={}){let r=null,i=!1,a=p(e===`ble`?`Add device over Bluetooth`:`Add device by address`,{onClose:()=>{r?r.abort():u&&!i&&Ae(u)}});a.body.className=`wifi-sheet`;let o=B.getWifiList(),c=n.creds??H.get()??o[0]??{ssid:``,password:``},u=n.device??null,d=document.createElement(`p`);d.className=`wifi-lead`,d.textContent=e===`ble`?`Choose the Wi-Fi network the device should join, then pick it in the Bluetooth chooser.`:`Choose the Wi-Fi network the device is on, then enter its address.`;let f=document.createElement(`div`);f.className=`wifi-picks`;let m=document.createElement(`input`);m.className=`sheet-input`,m.placeholder=`Wi-Fi network (SSID)`,m.setAttribute(`aria-label`,`Wi-Fi network (SSID)`),m.value=c.ssid,m.setAttribute(`autocomplete`,`off`),m.setAttribute(`autocapitalize`,`off`),m.setAttribute(`autocorrect`,`off`),m.setAttribute(`spellcheck`,`false`);let h=document.createElement(`input`);h.className=`sheet-input`,h.placeholder=`Wi-Fi password`,h.setAttribute(`aria-label`,`Wi-Fi password`),h.value=c.password;let g=s(h,{autocomplete:`new-password`,className:`sheet-pw`}),_=()=>({ssid:m.value.trim(),password:h.value}),v=()=>H.set({ssid:m.value,password:h.value});m.addEventListener(`input`,v),h.addEventListener(`input`,v);let y=()=>{f.replaceChildren();for(let e of B.getWifiList()){let t=document.createElement(`button`);t.type=`button`,t.className=`wifi-pick`,e.ssid===m.value&&t.classList.add(`wifi-pick--on`),t.textContent=e.ssid,t.addEventListener(`click`,()=>{m.value=e.ssid,h.value=e.password,v(),y()}),f.appendChild(t)}};y(),m.addEventListener(`input`,y);let b=document.createElement(`div`);b.className=`wifi-status metric`,b.setAttribute(`role`,`status`),b.setAttribute(`aria-live`,`polite`);let x=(e,t=`info`)=>{b.textContent=e,b.classList.toggle(`wifi-status--error`,t===`error`)},S=l({label:e===`ble`?`Scan for device`:`Enter address`,icon:e===`ble`?`bluetooth`:`link`,block:!0,onClick:()=>{let n=_();if(e===`manual`){n.ssid&&B.addWifi(n),a.close(),Pe(),t?.();return}O(n,u)}}),C=e=>{let t=S.querySelector(`span`);t&&(t.textContent=e)},w=l({label:`Edit Wi-Fi details`,icon:`edit`,variant:`quiet`,block:!0,onClick:()=>r?.abort()});w.classList.add(`wifi-secondary`),w.hidden=!0;let T=l({label:`Choose a different device`,variant:`quiet`,block:!0,onClick:()=>{u&&Ae(u),u=null,T.hidden=!0,O(_(),null)}});T.classList.add(`wifi-secondary`),T.hidden=!0;let E=e=>{m.disabled=e,h.disabled=e;for(let t of f.querySelectorAll(`button`))t.disabled=e;S.hidden=e,w.hidden=!e,e&&(T.hidden=!0)},D=e=>{E(!1);let t=e instanceof te?e.kind:null;t===`cancelled`?x(`Stopped waiting. Edit the Wi-Fi details, then try again.`):x(t===`wrong-password`||t===`not-found`?W(e):t===`timeout`?`The device didn't join the network in time. Check the Wi-Fi details, then try again.`:`Setup failed: ${W(e)}`,`error`);let n=t===`not-found`?m:h;n.focus(),n.select(),u&&(C(`Try again`),T.hidden=!1)},O=async(e,n)=>{if(!n){S.disabled=!0;try{n=await Oe()}catch(e){G(e)||x(`Bluetooth: ${W(e)}`,`error`);return}finally{S.disabled=!1}u=n}if(!e.ssid){x(`Enter a Wi-Fi network name.`,`error`),m.focus();return}let o=new AbortController;r=o,E(!0),x(`Connecting…`);try{await je(n,e,e=>x(e),o.signal),r=null,i=!0,a.close(),t?.()}catch(e){r=null,D(e)}};if(a.body.append(d),o.length>0){let e=document.createElement(`div`);e.className=`wifi-cap`,e.textContent=`Saved networks`,a.body.append(e,f)}a.body.append(m,g.el,b,S,w,T),n.error===void 0?m.focus():D(n.error)}function ke(e,t){(async()=>{let n;try{n=await Oe()}catch(e){G(e)||i(`Bluetooth: ${W(e)}`,{error:!0});return}if(e?.bleId&&n.id&&n.id!==e.bleId&&!await a({title:`Different device?`,message:`The device you picked${n.name?` ("${n.name}")`:``} doesn't look like "${e.label}" — it's a different Bluetooth device. Setting it up will connect to it and may overwrite "${e.label}"'s name. Continue?`,confirmLabel:`Continue`,danger:!0}))return;let r=B.getWifiList()[0];if(!r||!r.ssid){i(`Pick a Wi-Fi network first`,{error:!0}),U(`ble`,t,{device:n});return}try{await je(n,r,e=>i(e)),t?.()}catch(e){e instanceof te&&e.kind!==`device`?U(`ble`,t,{device:n,creds:r,error:e}):i(`Setup failed: ${W(e)}`,{error:!0})}})()}function Ae(e){try{e.gatt?.disconnect()}catch{}}async function je(e,t,n,r){let a=await ne(e,t.ssid,t.password,n,{signal:r});B.addWifi(t),H.clear();let o=a.map(e=>ie(e)).find(e=>e!==null);if(o){n(`Bridge joined ${t.ssid} (${o}).`),i(`Bridge is on ${t.ssid}. Not paired yet? Open Live via bridge and enter the code on its screen.`);return}let s=a.map(e=>ae(e)).find(e=>e!==null);if(!s)throw Error(`device joined but sent no usable address (${a})`);n(`Provisioned at ${s} — connecting…`),k.connect(s),e.id&&A.setBleId(s,e.id),i(`Device provisioned`)}function Me(e){(async()=>{let{requestBleDevice:t,bleSocketFactory:n,bleDeviceUrl:r,BLE_UPLOAD_CHUNK_BYTES:a}=await j(async()=>{let{requestBleDevice:e,bleSocketFactory:t,bleDeviceUrl:n,BLE_UPLOAD_CHUNK_BYTES:r}=await import(`./bleTransport-DAtJ-Ii2.js`).then(e=>e.s);return{requestBleDevice:e,bleSocketFactory:t,bleDeviceUrl:n,BLE_UPLOAD_CHUNK_BYTES:r}},__vite__mapDeps([8,5,2,4,3,6]),import.meta.url),o;try{o=m()?await Ne():await t()}catch(e){G(e)||i(`Bluetooth: ${W(e)}`,{error:!0});return}let s=o.name||`Bluetooth device`,c=r(o);i(`Connecting over Bluetooth…`),k.connect(c,s,{socketFactory:n(o),coldRetryLimit:6,uploadChunkBytes:a}),o.id&&A.setBleId(c,o.id),e?.()})()}async function Ne(){let[{loadNativeBle:e,nativeBleDevice:t},{pickNativeBleDevice:n}]=await Promise.all([j(()=>import(`./nativeBlePlayer-DlyMEqQ4.js`),__vite__mapDeps([9,2,8,5,4,3,6]),import.meta.url),j(()=>import(`./blePicker-BYnb9u3o.js`),__vite__mapDeps([0,1,2,3,4,5,6,7]),import.meta.url)]),r=await e();return n(async(e,n)=>t(r,e,n),{title:`Connect over Bluetooth`,prompt:`Tap the device to connect:`})}function Pe(){let e=prompt(`Device address (wss://host:port):`,`wss://`);if(e){if(!/^wss?:\/\//.test(e)){i(`Address must start with ws:// or wss://`,{error:!0});return}k.connect(e)}}function W(e){return e instanceof Error?e.message:String(e)}function G(e){return e instanceof DOMException&&(e.name===`NotFoundError`||e.name===`AbortError`)}function Fe(e){let t=p(e.title??`Move to folder`);t.body.className=`folder-picker`;let r=n=>{t.close(),e.onPick(n)},i=document.createElement(`div`);i.className=`folder-list`;let a=(t,i,a)=>{let o=document.createElement(`button`);o.type=`button`,o.className=`folder-row`+(i===e.current?` folder-row--on`:``),o.append(n(a));let s=document.createElement(`span`);return s.textContent=t,o.appendChild(s),o.addEventListener(`click`,()=>r(i)),o};i.appendChild(a(`Ungrouped`,``,`close`));for(let t of e.existing)i.appendChild(a(t,t,`folder`));let o=document.createElement(`div`);o.className=`folder-new`;let s=document.createElement(`input`);s.className=`sheet-input`,s.placeholder=`New folder name…`;let c=()=>{let e=s.value.trim();e&&r(e)};s.addEventListener(`keydown`,e=>{e.key===`Enter`&&(e.preventDefault(),c())}),o.append(s,l({label:`Create`,onClick:c})),t.body.append(i,o)}var Ie=`ledmapper.foldersCollapsed`;function Le(){try{let e=localStorage.getItem(Ie),t=e?JSON.parse(e):[];return new Set(Array.isArray(t)?t:[])}catch{return new Set}}function Re(e){try{localStorage.setItem(Ie,JSON.stringify([...e]))}catch{}}function ze(e,t,r,i,a){let o=new Map,s=[];for(let e of t){let t=(r(e)??``).trim();if(t){let n=o.get(t)??[];n.push(e),o.set(t,n)}else s.push(e)}let c=o.size>0,l=Le(),u=(t,r,o=!1)=>{let s=`${a.scope}:${t}`,c=l.has(s),u=document.createElement(`button`);u.type=`button`,u.className=`folder-header`+(o?` folder-header--muted`:``);let d=n(`chevron`);d.classList.add(`folder-chevron`),u.append(d),o||u.append(n(`folder`));let f=document.createElement(`span`);f.className=`folder-header-name`,f.textContent=t;let p=document.createElement(`span`);p.className=`folder-count`,p.textContent=String(r.length),u.append(f,p),e.appendChild(u);let m=[];for(let t of r){let n=i(t);m.push(n),e.appendChild(n)}let h=()=>{u.classList.toggle(`folder-header--collapsed`,c);for(let e of m)e.classList.toggle(`folder-hidden`,c)};h(),u.addEventListener(`click`,()=>{c=!c,c?l.add(s):l.delete(s),Re(l),h()})};for(let e of[...o.keys()].sort((e,t)=>e.localeCompare(t)))u(e,o.get(e));if(s.length>0)if(c)u(`Ungrouped`,s,!0);else for(let t of s)e.appendChild(i(t))}var Be={auto:`Auto`,fixed:`Fixed`,manual:`Manual`,offline:`Offline`},Ve={auto:`Rescans soon after losing the network, backing off to the cap and keeping that pace. Optionally slows down after a long absence (off unless you set the hours below).`,fixed:`Rescans at a steady interval while the network is missing.`,manual:`Never looks for the network on its own — only when you tap Rejoin now.`,offline:`Forward-deployed: Wi-Fi radio off, credentials kept. Change it over Bluetooth or the console.`},He=[{key:`scanCapS`,label:`Longest wait between scans (s)`,min:10,max:86400,modes:[`auto`]},{key:`decayAfterH`,label:`Slow down after unseen for (h, 0 = off)`,min:0,max:8760,modes:[`auto`]},{key:`sparseIntervalS`,label:`Slowed scan interval (s)`,min:60,max:86400,modes:[`auto`]},{key:`intervalS`,label:`Scan interval (s)`,min:10,max:86400,modes:[`fixed`]}];function Ue(e,t){let n=document.createElement(`div`);n.className=`wifi-policy`;let r=null,s=`auto`,d=!1,f=new Map,p=e=>{r=e,s=e.mode,t?.(e),m()},m=()=>{n.replaceChildren(),f.clear();let e=document.createElement(`div`);if(e.className=`device-detail-cap wifi-policy-title`,e.textContent=`Wi-Fi rejoin`,n.append(e),!r){let e=document.createElement(`div`);e.className=`wifi-policy-status`,e.textContent=`Reading Wi-Fi settings…`,n.append(e);return}let t=document.createElement(`div`);t.className=`wifi-policy-status`;let i=r.scans>0&&r.state===`searching`?` · ${r.scans} scans`:``;t.textContent=g(r)+i,n.append(t),r.otaPending&&n.append(We(w));let a=document.createElement(`div`);a.className=`wifi-policy-modes`;for(let e of x)a.append(o({label:Be[e],on:e===s,onClick:()=>{s=e,m()}}));n.append(a);let c=document.createElement(`div`);c.className=`device-detail-cap`,c.textContent=Ve[s],n.append(c);for(let e of He){if(!e.modes.includes(s))continue;let t=u({label:e.label,type:`number`,value:String(r[e.key])});t.input.inputMode=`numeric`,t.input.min=String(e.min),t.input.max=String(e.max),f.set(e.key,t.input),n.append(t.el)}let p=document.createElement(`div`);p.className=`wifi-policy-btns`;let h=l({label:`Apply`,variant:`primary`,disabled:d,onClick:()=>void S()});p.append(h),s!==`offline`&&r.mode!==`offline`&&p.append(l({label:`Rejoin now`,variant:`quiet`,disabled:d,onClick:()=>void T()})),n.append(p)},v=async e=>{if(!d){d=!0,m();try{await e()}catch(e){i(`Wi-Fi settings: ${e instanceof Error?e.message:String(e)}`,{error:!0})}finally{d=!1,m()}}},y=async e=>await c({title:`Update awaiting confirmation`,message:`A firmware update is installed but not yet confirmed. Keep the device online until the update is confirmed, so its networking gets checked before the device leaves the network. Confirm the update first, while the device is still online, then switch to ${Be[e]}.`,choices:[{id:`stay`,label:`Stay online`,variant:`primary`},{id:`force`,label:e===`offline`?`Go offline anyway`:`Switch anyway`,variant:`danger`}]})===`force`?a({title:`Skip the update check?`,message:`Without a network the update is confirmed on rendering alone, so its Wi-Fi is never checked. If it later can't rejoin, recover the device over Bluetooth, the console or USB.`,confirmLabel:e===`offline`?`Go offline anyway`:`Switch anyway`,danger:!0}):!1,S=()=>v(async()=>{if(!r)return;let t={mode:s};for(let e of He){let n=f.get(e.key);if(!n)continue;let r=b(n.value);if(r===null||r<e.min||r>e.max){i(`${e.label}: enter ${e.min}–${e.max}`,{error:!0});return}t[e.key]=r}let n=C(r.mode,s);if(n&&!await a({...n,confirmLabel:s===`offline`?`Go offline`:`Switch to manual`,danger:s===`offline`}))return;if(h(s)&&s!==r.mode&&r.otaPending){if(!await y(s))return;t.force=!0}let o=await e.setWifiPolicy(t);if(o.refused===`ota_pending`&&!t.force){if(p(o),!await y(s))return;o=await e.setWifiPolicy({...t,force:!0})}p(o),o.refused?i(`Not applied: ${o.refused===`ota_pending`?`an update is awaiting confirmation`:o.refused}`,{error:!0}):o.mode===`offline`?i(`Offline mode on — use Bluetooth or the console to change it`):i(`Wi-Fi settings saved`)}),T=()=>v(async()=>{let t=await e.setWifiPolicy({rejoinNow:!0});p(t),i(t.nextScanS>0?`Rejoining — next scan in ${_(t.nextScanS)}`:`Rejoining…`)});return m(),e.getWifiPolicy().then(p,e=>{n.replaceChildren();let t=document.createElement(`div`);t.className=`device-detail-cap`,t.textContent=`Wi-Fi settings unavailable (${e instanceof Error?e.message:String(e)})`,n.append(t)}),n}function We(e){let t=document.createElement(`div`);return t.className=`k-card wifi-policy-warn`,t.style.borderColor=`var(--warn)`,t.textContent=e,t}var Ge=`rope_start`;function Ke(e){let t=t=>Math.max(0,e.find(e=>e.channel===t)?.ledCount??0);return t(1)>0?t(0):0}function qe(e,t){return{...e.uniforms,[Ge]:t}}var Je=[{id:`pumpkin-candles`,name:`Pumpkin Candles`,emoji:`🕯️`,sliders:[`speed`,`warmth`],uniforms:{speed:1,warmth:.4},source:`// Jack-o'-lantern candles: warm orange flicker in patches, like candles inside pumpkins.
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
`}];function K(e){return Array.isArray(e)?e:[e]}function Ye(e,t,n={}){let r=[];for(let i of e.sliders){if(r.length>=2)break;let a=t.find(e=>e.name===i);if(!a||a.width!==1||a.ui.kind!==`slider`)continue;let{min:o,max:s}=a.ui,c=e.uniforms[i],l=n[i]??(c===void 0?void 0:K(c)[0])??a.default[0]??o,u=a.ui.step>0?a.ui.step:(s-o)/100;r.push({name:i,slot:a.slot,min:o,max:s,step:u,value:Math.min(s,Math.max(o,l))})}return r}function Xe(e,t,n={}){return t.map(t=>{let r=t.default.slice(),i=e.uniforms[t.name];i!==void 0&&K(i).length===t.width&&(r=K(i).slice());let a=n[t.name];return a!==void 0&&t.width===1&&(r=[a]),{slot:t.slot,value:r}})}function Ze(e){return`boo-${e.id}`}function Qe(e,t=Je){let n=t.find(t=>Ze(t)===e||t.id===e);return n?`${n.emoji} ${n.name}`:e}var $e=`splanc.kioskSecrets.v1`;function q(){try{let e=localStorage.getItem($e),t=e?JSON.parse(e):{};return t&&typeof t==`object`?t:{}}catch{return{}}}function et(e){try{localStorage.setItem($e,JSON.stringify(e))}catch{}}function tt(e=nt){return Array.from(e(16),e=>e.toString(16).padStart(2,`0`)).join(``)}function nt(e){let t=new Uint8Array(e);return crypto.getRandomValues(t),t}function J(e){return e.trim().toUpperCase()}function rt(e){return e?q()[J(e)]:void 0}function it(e){let t=q(),n=J(e),r=t[n];if(r)return r;let i=tt();return t[n]=i,et(t),i}function at(e,t){let n=q();n[J(e)]=t,et(n)}var ot=e({kioskStore:()=>Y}),Y=new class{clock=new ue;listeners=new Set;revertListeners=new Set;bound=null;boundConnected=!1;unsubs=[];started=!1;start(){this.started||(this.started=!0,k.subscribe(()=>this.follow()),this.follow())}get active(){return this.clock.status?.enabled===!0}get status(){return this.clock.status}remaining(){return this.clock.remaining()}subscribe(e){return this.listeners.add(e),()=>this.listeners.delete(e)}onRevert(e){return this.revertListeners.add(e),()=>this.revertListeners.delete(e)}apply(e){let t=this.clock.sync(e);if(this.emit(),t)for(let t of this.revertListeners)t(e)}async refresh(){let e=this.bound;if(!(!e?.isConnected||!se(e.welcome)))try{let t=N(await e.getKioskStatus());t&&this.apply(t)}catch{}}emit(){for(let e of this.listeners)e()}follow(){let e=k.client,t=k.status.state===`connected`;if(!(e===this.bound&&t===this.boundConnected)){if(e!==this.bound){for(let e of this.unsubs)e();this.unsubs=[],this.clock.clear(),this.bound=e,e&&this.unsubs.push(e.onKioskStatus(e=>{let t=N(e);t&&this.apply(t)}),e.onActivity(()=>{this.clock.noteActivity(),this.emit()})),this.emit()}if(this.boundConnected=t,e&&t){let t=le(e.welcome);t?this.apply(t):this.refresh()}}}},st=!1;function ct(){if(st||typeof document>`u`)return;st=!0;let e=document.createElement(`style`);e.textContent=lt,document.head.appendChild(e)}var lt=`
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
`;function ut(e){let t=e?.code;return t===`kiosk_locked`?`the device is locked — unlock it first`:t===`kiosk_bad_secret`?`wrong owner secret (wait a couple of seconds before retrying)`:t===`kiosk_secret_required`?`the device needs an owner secret`:t===`kiosk_no_effect`?`nothing is playing to capture — start an effect first`:t===`kiosk_bad_config`?`the device rejected these settings`:e instanceof Error?e.message:String(e)}function dt(e){if(!e)return`Kiosk: reading…`;if(!e.enabled)return`Kiosk: off`;let t=[`Kiosk: on · idle ${oe(e.idleTimeoutS)}`];return t.push(e.hasAttract||e.attractName?`show: ${Qe(e.attractName)}`:`no attract show captured`),t.push(e.ownerUnlocked?`unlocked (owner)`:`locked`),t.join(` · `)}function ft(e){ct();let t=document.createElement(`div`);t.className=`kiosk-section`;let n=e.welcome?.mac??``,r=Y.status,o=!1,s=r?.enabled??!1,c=!(r?.enabled??!1),f=null,p=e=>{let t=N(e);t&&(r=t,s=t.enabled,Y.apply(t),_())},m=async(e,t)=>{if(!o){o=!0,_();try{await t()}catch(t){i(`${e}: ${ut(t)}`,{error:!0})}finally{o=!1,_()}}},h=()=>m(`Unlock`,async()=>{let t=rt(n);if(!t){let e=prompt(`Owner secret for this device (from the phone that set up kiosk mode):`)?.trim();if(!e)return;t=e}let r=await e.kioskUnlock(t);if(!r.ownerUnlocked)throw Error(`wrong owner secret`);n&&at(n,t),p(r),i(`Unlocked for this connection`)}),g=()=>m(`Kiosk settings`,async()=>{let t=Number(f?.value??120);if(!Number.isFinite(t)||t<10||t>86400){i(`Idle timeout: enter 10–86400 seconds`,{error:!0});return}if(!n)throw Error(`connect once so the device's identity is known`);let o=it(n);if(r?.enabled&&!r.ownerUnlocked&&!(await e.kioskUnlock(o)).ownerUnlocked)throw Error(`this phone's owner secret doesn't match the device`);s&&!c&&!r?.hasAttract&&await a({title:`No attract show yet`,message:`Kiosk mode reverts to the attract show after the timeout. Capture what's playing now?`,confirmLabel:`Capture current look`,cancelLabel:`Leave as is`})&&(c=!0),p(await e.setKioskConfig(ce({enabled:s,idleTimeoutS:t,captureAttractFromCurrent:s&&c,ownerSecret:o}))),c=!1,i(s?`Kiosk mode on`:`Kiosk mode off`)});function _(){t.replaceChildren();let e=document.createElement(`div`);e.className=`device-detail-cap`,e.textContent=`Kiosk mode (public install)`;let a=document.createElement(`div`);a.className=`kiosk-status-line`,a.textContent=dt(r),t.append(e,a);let p=document.createElement(`div`);p.className=`kiosk-row`;let m=document.createElement(`label`);m.textContent=`Visitors can play; owner settings locked`;let v=d({on:s,label:`Kiosk mode`,onChange:e=>{s=e,e&&!r?.enabled&&(c=!0),_()}});p.append(m,v.el),t.append(p);let y=u({label:`Back to the show after (seconds idle)`,type:`number`,value:String(r?.idleTimeoutS??120)});y.input.inputMode=`numeric`,y.input.min=`10`,f=y.input,t.append(y.el);let b=document.createElement(`label`);b.className=`kiosk-row`;let x=document.createElement(`input`);x.type=`checkbox`,x.checked=c,x.addEventListener(`change`,()=>c=x.checked);let S=document.createElement(`span`);S.textContent=`Use the current effect, uniforms and brightness as the attract show`,b.append(x,S),t.append(b);let C=document.createElement(`div`);C.className=`kiosk-row`,C.append(l({label:`Apply`,variant:`primary`,disabled:o,onClick:()=>void g()})),r?.enabled&&!r.ownerUnlocked&&C.append(l({label:`Unlock`,variant:`quiet`,disabled:o,onClick:()=>void h()})),t.append(C);let w=rt(n),T=document.createElement(`div`);T.className=`kiosk-secret`,T.textContent=w?`Owner secret (kept on this phone): ${w}`:`An owner secret is generated on this phone the first time you apply.`,t.append(T),w&&t.append(l({label:`Copy owner secret`,variant:`quiet`,onClick:()=>void navigator.clipboard?.writeText(w).then(()=>i(`Copied — keep it somewhere safe`),()=>i(`Couldn't copy`,{error:!0}))}));let E=document.createElement(`div`);E.className=`device-detail-cap`,E.textContent="Lost the secret? Run `kiosk off` on the device's USB serial console.",t.append(E)}return _(),e.getKioskStatus().then(p).catch(e=>{let n=t.querySelector(`.kiosk-status-line`);n&&(n.textContent=`Kiosk: couldn't read (${ut(e)})`)}),t}var pt=!1;function mt(){if(pt||typeof document>`u`)return;pt=!0;let e=document.createElement(`style`);e.textContent=`
.mesh-section { display: flex; flex-direction: column; gap: 12px; }
.mesh-status-line { font-size: 0.875rem; color: var(--text-dim); }
.mesh-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mesh-row-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.mesh-row-title { font-size: 0.9375rem; }
.mesh-row-hint { font-size: 0.8125rem; color: var(--text-dim); }
`,document.head.append(e)}function ht(e,t={}){mt();let n=document.createElement(`div`);n.className=`mesh-section`,n.hidden=!0;let r=r=>{let i=y(r);if(n.replaceChildren(),i===null){n.hidden=!0,t.onShown?.(!1);return}n.hidden=!1,t.onShown?.(!0);let a=v(r).length,o=document.createElement(`div`);o.className=`device-detail-cap`,o.textContent=`Mesh`;let s=document.createElement(`div`);s.className=`mesh-status-line`,s.textContent=i;let c=document.createElement(`div`);c.className=`mesh-row`;let l=document.createElement(`div`);l.className=`mesh-row-text`;let u=document.createElement(`span`);u.className=`mesh-row-title`,u.id=`mesh-all-title`,u.textContent=`Control the whole mesh`;let f=document.createElement(`span`);f.className=`mesh-row-hint`,f.textContent=`Effect, slider, brightness and crossfade changes also go to the ${a} other fixture${a===1?``:`s`}, on the same frame. New effects reach only this fixture for now, unless they are very small.`,l.append(u,f);let p=d({on:e.meshAll,label:`Control the whole mesh`,onChange:n=>{e.setMeshAll(n),t.onChange?.(n)}});p.el.setAttribute(`aria-labelledby`,u.id),c.append(l,p.el),n.append(o,s,c)},i=()=>{n.hidden=!0,t.onShown?.(!1)};try{e.getMesh().then(r).catch(i)}catch{i()}return n}function X(e){let t=Math.max(1,e.width);if(e.mins&&e.maxs&&e.mins.length===t&&e.maxs.length===t)return e.mins.map((t,n)=>({min:t,max:e.maxs[n]}));let n;if(e.min!==void 0&&e.max!==void 0)n={min:e.min,max:e.max};else switch(e.ui.kind){case`slider`:case`matrix`:n={min:e.ui.min,max:e.ui.max};break;case`color`:case`toggle`:n={min:0,max:1};break;case`dropdown`:n={min:0,max:Math.max(0,e.ui.options.length-1)};break;default:n=null}return n?Array.from({length:t},()=>({...n})):null}function Z(e,t){let n=X(e),r=Math.max(1,e.width),i=[];for(let a=0;a<r;a++){let r=t[a];(r===void 0||!Number.isFinite(r))&&(r=e.default[a]??n?.[a]?.min??0);let o=n?.[a];o&&(r=Math.min(Math.max(r,Math.min(o.min,o.max)),Math.max(o.min,o.max))),i.push(r)}return i}function gt(e){if(e.ui.kind!==`matrix`)return null;let t=Math.round(Math.sqrt(e.width));return t*t===e.width?t:null}function _t(e,t,n){return t*n+e}function vt(e){return e.width>1&&e.ui.kind===`slider`}function yt(e){return`${e.name}|${e.width}|${JSON.stringify(e.ui)}|${JSON.stringify([e.mins,e.maxs])}`}var bt=class{root;onChange;slots=[];setters=new Map;constructor(e,t){this.root=e,this.onChange=t}values(){return this.slots.map(e=>({slot:e.uniform.slot,value:e.value.slice()}))}applyExternal(e,t){let n=this.slots.find(t=>t.uniform.slot===e);n!==void 0&&(n.value=t.slice(),this.setters.get(e)?.(n.value),this.onChange(e,n.value))}setLive(e,t){let n=this.slots.find(t=>t.uniform.slot===e);return n===void 0?!1:(n.value=t.slice(),this.setters.get(e)?.(n.value),!0)}hydrate(e){for(let n of t(e,this.slots.map(e=>e.uniform))){let e=this.slots.find(e=>e.uniform.slot===n.slot);e&&(e.value=n.value.slice())}this.render()}setManifest(e){let t=new Map(this.slots.map(e=>[yt(e.uniform),e.value]));this.slots=e.map(e=>({uniform:e,value:(t.get(yt(e))??e.default).slice()})),this.render()}set(e,t){let n=this.slots[e];n!==void 0&&(n.value=t,this.onChange(n.uniform.slot,t))}render(){if(this.root.replaceChildren(),this.setters.clear(),this.slots.length===0){let e=document.createElement(`p`);e.className=`muted upanel-empty`,e.textContent=`No uniforms declared.`,this.root.appendChild(e);return}let e=document.createElement(`div`);e.className=`upanel-grid`,this.slots.forEach((t,n)=>{vt(t.uniform)?this.vectorRows(e,t,n):this.row(e,t,n)}),this.root.appendChild(e)}row(e,t,n){let r=document.createElement(t.uniform.ui.kind===`matrix`?`div`:`label`);r.className=`upanel-row`;let i=document.createElement(`span`);if(i.className=`upanel-name`,i.textContent=t.uniform.name,i.title=t.uniform.name,t.uniform.ui.kind===`matrix`){r.append(i,this.matrix(t,n)),e.appendChild(r);return}let a=document.createElement(`span`);a.className=`upanel-ctrl`;let o=document.createElement(`span`);o.className=`upanel-val`,this.fill(a,o,t,n),r.append(i,a,o),e.appendChild(r)}vectorRows(e,t,n){let r=t.uniform,i=r.ui,a=X(r),o=[];for(let s=0;s<r.width;s++){let c=document.createElement(`label`);c.className=`upanel-row`;let l=document.createElement(`span`);l.className=`upanel-name`,l.textContent=`${r.name}.${xt[s]??s}`,l.title=l.textContent;let u=document.createElement(`span`);u.className=`upanel-ctrl`;let d=document.createElement(`span`);d.className=`upanel-val`;let f=a?.[s]??{min:i.min,max:i.max};o.push(this.sliderPair(u,d,f.min,f.max,i.step,()=>t.value[s]??f.min,e=>{let i=t.value.slice();i[s]=e,this.set(n,Z(r,i))})),c.append(l,u,d),e.appendChild(c)}this.setters.set(r.slot,e=>o.forEach((t,n)=>t(e[n]??0)))}matrix(e,t){let n=e.uniform,r=gt(n)??Math.max(1,Math.round(Math.sqrt(n.width))),i=X(n),a=document.createElement(`span`);a.className=`upanel-mat`,a.style.gridTemplateColumns=`repeat(${r}, minmax(0, 1fr))`;let o=[];for(let s=0;s<r;s++)for(let c=0;c<r;c++){let l=_t(s,c,r),u=i?.[l],d=document.createElement(`input`);d.type=`number`,d.className=`upanel-num`,d.step=`any`,u&&(d.min=String(u.min),d.max=String(u.max)),d.title=`${n.name}[${c}][${s}] (row ${s}, column ${c})`,d.value=Q(e.value[l]??0),d.addEventListener(`change`,()=>{let r=e.value.slice(),i=parseFloat(d.value);r[l]=Number.isFinite(i)?i:e.value[l]??0;let a=Z(n,r);d.value=Q(a[l]??0),this.set(t,a)}),d.addEventListener(`keydown`,e=>{e.key===`Enter`&&(e.preventDefault(),d.blur())}),o[l]=d,a.appendChild(d)}return this.setters.set(n.slot,e=>o.forEach((t,n)=>t.value=Q(e[n]??0))),a}sliderPair(e,t,n,r,i,a,o){let s=i>0?i:.001,c=a(),l=document.createElement(`input`);l.type=`range`,l.min=String(n),l.max=String(r),l.step=String(s),l.value=String(c);let u=document.createElement(`input`);u.type=`number`,u.className=`upanel-num`,u.min=String(n),u.max=String(r),u.step=String(s),u.value=Q(c),l.addEventListener(`input`,()=>{let e=parseFloat(l.value);u.value=Q(e),o(e)});let d=()=>{let e=parseFloat(u.value);Number.isFinite(e)||(e=a()),e=Ct(e,n,r,s),l.value=String(e),u.value=Q(e),o(e)};return u.addEventListener(`change`,d),u.addEventListener(`keydown`,e=>{e.key===`Enter`&&(e.preventDefault(),d(),u.blur())}),e.appendChild(l),t.appendChild(u),e=>{l.value=String(e),u.value=Q(e)}}fill(e,t,n,r){let i=n.uniform.ui;if(i.kind===`toggle`){let i=document.createElement(`input`);i.type=`checkbox`,i.checked=(n.value[0]??0)>=.5,i.addEventListener(`change`,()=>{this.set(r,[+!!i.checked]),t.textContent=i.checked?`on`:`off`}),e.appendChild(i),t.textContent=i.checked?`on`:`off`,this.setters.set(n.uniform.slot,e=>{i.checked=(e[0]??0)>=.5,t.textContent=i.checked?`on`:`off`});return}if(i.kind===`color`){let i=document.createElement(`label`);i.className=`upanel-color`;let a=document.createElement(`span`);a.className=`upanel-color-swatch`;let o=document.createElement(`input`);o.type=`color`,o.value=Tt(n.value),a.style.background=o.value,t.textContent=o.value,o.addEventListener(`input`,()=>{this.set(r,Et(o.value,n.uniform.width)),a.style.background=o.value,t.textContent=o.value}),i.append(a,o),e.appendChild(i);return}if(i.kind===`dropdown`){let t=document.createElement(`select`);i.options.forEach((e,n)=>{let r=document.createElement(`option`);r.value=String(n),r.textContent=e,t.appendChild(r)}),t.value=String(Math.round(n.value[0]??0)),t.addEventListener(`change`,()=>this.set(r,[parseInt(t.value,10)])),e.appendChild(t);return}if(i.kind===`matrix`)return;let a=this.sliderPair(e,t,i.min,i.max,i.step,()=>this.slots[r]?.value[0]??i.min,e=>this.set(r,[e]));this.setters.set(n.uniform.slot,e=>a(e[0]??i.min))}},xt=[`x`,`y`,`z`,`w`];function St(e,t,n){return Math.min(n,Math.max(t,e))}function Ct(e,t,n,r){return e=St(e,t,n),r>0&&(e=t+Math.round((e-t)/r)*r),St(e,t,n)}function Q(e){return Number.isFinite(e)?String(Math.round(e*1e4)/1e4):`0`}function wt(e){return Math.max(0,Math.min(255,Math.round(e*255)))}function Tt(e){let[t,n,r]=[e[0]??0,e[1]??0,e[2]??0],i=e=>wt(e).toString(16).padStart(2,`0`);return`#${i(t)}${i(n)}${i(r)}`}function Et(e,t){let n=[parseInt(e.slice(1,3),16)/255,parseInt(e.slice(3,5),16)/255,parseInt(e.slice(5,7),16)/255];return t>=4&&n.push(1),n.slice(0,Math.max(3,t))}function Dt(e){return(e?.features??[]).includes(`effect_store`)}function Ot(e){let t=(e?.effects??[]).map(e=>({effectId:e.effectId??``,name:e.name??``,fxbBytes:e.fxbBytes??0,uniforms:[...e.uniforms??[]],decks:[...e.decks??[]]}));return t.sort((e,t)=>$(e).localeCompare($(t))),{effects:t,capacity:e?.capacity??0}}function $(e){return e.name.trim()||e.effectId}function kt(e){let t=[e.fxbBytes>=1024?`${(e.fxbBytes/1024).toFixed(1)} KB`:`${e.fxbBytes} B`];return e.uniforms.length>0&&t.push(e.uniforms.join(`, `)),e.decks.includes(0)&&t.push(`on deck A`),e.decks.includes(1)&&t.push(`on deck B`),t.join(` · `)}function At(e){return`${e.effects.length} of ${e.capacity} stored`}function jt(e){if(e===void 0||e.length===0)return[];try{let t=typeof e==`string`?e:new TextDecoder().decode(e),n=JSON.parse(t);return Array.isArray(n)?n.filter(e=>typeof e==`object`&&!!e&&typeof e.name==`string`&&typeof e.slot==`number`):[]}catch{return[]}}function Mt(e){let t=e?.code;return t===`store_full`?`the device's effect store is full — delete one first`:t===`store_no_space`?`the device is low on flash (room is kept for a map) — delete a stored effect first`:t===`not_found`?`that effect isn't stored on the device any more`:t===`no_store`?`the device's effect store is unavailable`:t===`effect_too_large`?`the effect is too large for this device`:t===`bad_fxb`?`the device rejected the effect`:t===`kiosk_locked`?`the device is locked — unlock it first`:e instanceof Error?e.message:String(e)}var Nt=!1;function Pt(){if(Nt||typeof document>`u`)return;Nt=!0;let e=document.createElement(`style`);e.textContent=Ft,document.head.appendChild(e)}var Ft=`
.stored-effects { display: flex; flex-direction: column; gap: var(--sp-2); }
.stored-effects-usage { margin: 0; }
.stored-effects-list { list-style: none; margin: 0; padding: 0; }
.stored-effects-row { border-bottom: 1px solid var(--border); }
.stored-effects-row:last-child { border-bottom: none; }
.stored-effects-open {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 48px;
  padding: var(--sp-3) 0;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.stored-effects-open svg { flex-shrink: 0; width: 18px; height: 18px; color: var(--text-dim); }
.stored-effects-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.stored-effects-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stored-effects-detail { font-size: var(--f-caption); }
.stored-effects-badge {
  flex-shrink: 0;
  font-size: var(--f-caption);
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 2px var(--sp-2);
}
.stored-effect-sheet { display: flex; flex-direction: column; gap: var(--sp-3); }
.stored-effect-detail { margin: 0; }
.stored-effect-controls-cap { margin-top: var(--sp-2); }
/* The destructive action is secondary: its own row, well below the primary. */
.stored-effect-delete { margin-top: var(--sp-4); color: var(--err); }
`,It=800,Lt=e=>e.decks.includes(0);function Rt(e){Pt();let t=document.createElement(`div`);t.className=`stored-effects`;let r=null,o=()=>{t.replaceChildren();let e=document.createElement(`div`);if(e.className=`device-detail-cap`,e.textContent=`Stored effects`,t.append(e),r===null){let e=document.createElement(`p`);e.className=`muted`,e.textContent=`Reading…`,t.append(e);return}let i=document.createElement(`p`);i.className=`muted stored-effects-usage`,i.textContent=r.effects.length===0?`None yet. Store one from the effect editor (Store on device).`:At(r),t.append(i);let a=document.createElement(`ul`);a.className=`stored-effects-list`;for(let e of r.effects){let t=document.createElement(`li`);t.className=`stored-effects-row`,t.dataset.effectId=e.effectId;let r=document.createElement(`button`);r.type=`button`,r.className=`stored-effects-open`,r.setAttribute(`aria-label`,`Open ${$(e)}`);let i=document.createElement(`div`);i.className=`stored-effects-text`;let o=document.createElement(`div`);o.className=`stored-effects-name`,o.textContent=$(e);let s=document.createElement(`div`);if(s.className=`muted stored-effects-detail`,s.textContent=kt(e),i.append(o,s),r.append(i),Lt(e)){let e=document.createElement(`span`);e.className=`stored-effects-badge`,e.textContent=`Playing`,r.append(e)}r.append(n(`chevron`)),r.addEventListener(`click`,()=>c(e.effectId)),t.append(r),a.append(t)}t.append(a)},s=async()=>{try{r=Ot(await e.listStoredEffects())}catch(e){i(Mt(e),{error:!0})}o()},c=t=>{let n=()=>r?.effects.find(e=>e.effectId===t),s=n();if(!s)return;let c=null,u=!1,d=!1,f=p($(s),{onClose:()=>{c!==null&&(clearTimeout(c),c=null,e.setUniforms(h.values(),!0))}});f.body.classList.add(`stored-effect-sheet`);let m=document.createElement(`div`);m.className=`uniform-panel stored-effects-uniforms`;let h=new bt(m,(t,n)=>{e.live.setUniform(t,n),c!==null&&clearTimeout(c),c=setTimeout(()=>{c=null,e.setUniforms(h.values(),!0)},It)}),g=()=>{let e=n();if(f.body.replaceChildren(),!e)return;let t=document.createElement(`p`);t.className=`muted stored-effect-detail`,t.textContent=kt(e),f.body.append(t);let r=Lt(e)&&d;if(f.body.append(l({label:r?`Playing on this device`:`Play on this device`,variant:r?`quiet`:`primary`,block:!0,icon:`play`,disabled:u||r,onClick:()=>void v()})),d){let e=document.createElement(`div`);e.className=`device-detail-cap stored-effect-controls-cap`,e.textContent=`Controls`,f.body.append(e,m)}let i=l({label:`Delete from device`,variant:`quiet`,block:!0,disabled:u,onClick:()=>void y()});i.classList.add(`stored-effect-delete`),f.body.append(i)},_=async e=>{if(!u){u=!0,g();try{await e()}catch(e){i(Mt(e),{error:!0})}finally{u=!1,g(),o()}}},v=()=>_(async()=>{await e.loadStoredEffect(t,0,!0);let a=await e.getEffectUniforms();h.setManifest(jt(a.manifest)),h.hydrate(a.current.map(e=>({slot:e.slot,value:e.value}))),d=!0,r=Ot(await e.listStoredEffects()),i(`Playing ${$(n()??{name:``,effectId:t})}`)}),y=async()=>{let i=n();await a({title:`Delete stored effect?`,message:`Remove “${i?$(i):t}” from the device? What is playing keeps playing.`,confirmLabel:`Delete`,danger:!0})&&(await _(async()=>{r=Ot(await e.deleteStoredEffect(t))}),n()||f.close())};g()};return o(),s(),t}var zt=null,Bt=1200,Vt=null;function Ht(){if(zt)return;let e=()=>{},t=()=>{},n=()=>{},r=p(`Devices`,{onClose:()=>{e(),t(),n(),zt=null,Vt=null}});zt=r;let i=()=>{r.body.innerHTML=``,r.body.append(Wt())};Vt=i,e=A.subscribe(i),t=k.subscribe(i),n=O.subscribe(i),O.refresh(),i(),Ut(r.body,()=>O.probeAllNow())}function Ut(e,t){let n=e.parentElement;if(!n)return;let r=document.createElement(`div`);r.className=`device-ptr`;let i=document.createElement(`div`);i.className=`device-ptr-spin`,r.append(i),n.insertBefore(r,e);let a=0,o=!1,s=!1,c=0,l=e=>{c=e,r.style.height=`${e}px`,i.style.opacity=`${Math.min(1,e/60)}`},u=()=>{r.classList.remove(`device-ptr--active`,`device-ptr--busy`,`device-ptr--done`),r.style.height=``,i.style.opacity=``,c=0,o=!1,s=!1};n.addEventListener(`touchstart`,e=>{s||(o=n.scrollTop<=0&&e.touches.length===1,a=e.touches[0].clientY)},{passive:!0}),n.addEventListener(`touchmove`,e=>{if(!o||s)return;if(n.scrollTop>0){l(0),o=!1;return}let t=e.touches[0].clientY-a;if(t<=0){l(0);return}e.preventDefault(),r.classList.add(`device-ptr--active`),l(Math.min(90,t*.5))},{passive:!1});let d=()=>{!o||s||(r.classList.remove(`device-ptr--active`),c>=60?(s=!0,r.classList.add(`device-ptr--busy`),r.style.height=`60px`,i.style.opacity=`1`,t().finally(()=>{r.classList.remove(`device-ptr--busy`),r.classList.add(`device-ptr--done`),window.setTimeout(u,240)})):u())};n.addEventListener(`touchend`,d),n.addEventListener(`touchcancel`,d)}function Wt(){let e=document.createElement(`div`),t=k.status,n=A.activeId(),a=A.list();if(t.certUrl){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--warn)`,n.style.marginBottom=`var(--sp-3)`;let r=document.createElement(`div`);r.className=`device-trust-text`,r.textContent=Yt(t.trustKind??`first`,A.active()?.label),r.style.marginBottom=`var(--sp-2)`;let i=l({label:t.trustKind===`again`?`Trust again & connect`:`Trust & connect`,onClick:()=>Xt(t.certUrl)}),a=l({label:`Connect over Bluetooth`,onClick:()=>Me()});n.append(r,i,a),e.append(n)}if(t.certChanged){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--err)`,n.style.marginBottom=`var(--sp-3)`;let r=document.createElement(`div`);r.textContent=t.certChanged.message,r.style.marginBottom=`var(--sp-2)`;let a=l({label:`I reset it — trust the new certificate`,onClick:()=>{k.retrustCert(),i(`Certificate re-trusted`)}}),o=l({label:`Disconnect`,onClick:()=>k.disconnect()});n.append(r,a,o),e.append(n)}if(t.error){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--err)`,n.style.color=`var(--err)`,n.style.marginBottom=`var(--sp-3)`,n.textContent=t.error,e.append(n)}if(a.length===0){let t=document.createElement(`div`);t.className=`device-empty`,t.textContent=`No devices yet. Add one to get started.`,e.append(t)}let o=new Map;for(let e of a)o.set(e.label,(o.get(e.label)??0)+1);ze(e,a,e=>e.folder,e=>Gt(e,e.id===n,t,O.isReachable(e.id),(o.get(e.label)??0)>1),{scope:`devices`});let s=k.client?.welcome;if(s&&((s.features??[]).includes(`ota`)||M(s))){let t=A.get(n??``)?.label||s.deviceName||`this device`,r=l({label:M(s)?`Update firmware — ${t} is in its updater`:`Update firmware`,icon:`chip`,...M(s)?{variant:`primary`}:{},block:!0,onClick:()=>void j(()=>import(`./flashSheet-C09VfkJ-.js`).then(e=>e.openFlashSheet()),__vite__mapDeps([10,2,11,12,13,14,15,16,5,17,8,4,3,6,18,19,7]),import.meta.url)});r.classList.add(`device-update-fw`),r.title=`Update ${t}'s firmware over Wi-Fi`,e.append(r)}let c=document.createElement(`div`);c.className=`device-add`;let u=document.createElement(`div`);u.className=`device-add-label`,u.textContent=`Add device…`;let d=document.createElement(`div`);return d.className=`device-add-row`,d.append(r(`bluetooth`,{title:`Add device (Bluetooth)`,onClick:()=>U(`ble`)}),r(`plug`,{title:`Connect over Bluetooth (offline)`,onClick:()=>Me()}),r(`link`,{title:`Enter address manually`,onClick:()=>U(`manual`)}),r(`chip`,{title:`Flash a new board (USB)`,onClick:()=>void j(()=>import(`./flashSheet-C09VfkJ-.js`).then(e=>e.openFlashSheet()),__vite__mapDeps([10,2,11,12,13,14,15,16,5,17,8,4,3,6,18,19,7]),import.meta.url)})),c.append(u,d),e.append(c),e}function Gt(e,t,n=k.status,i=!1,a=!1){let o=document.createElement(`div`);o.className=`device-row`;let s=t&&n.state===`connected`,c=document.createElement(`span`);c.className=`device-dot`,c.dataset.state=t?n.state:i?`reachable`:`offline`;let l=document.createElement(`div`);l.className=`device-info`;let u=document.createElement(`div`);u.className=`device-name`,u.textContent=e.label;let d=document.createElement(`div`);d.className=`device-url`;let f=t?Kt(n):i?`on this network · ${D(e)}`:D(e),p=a?T(e):``;d.textContent=p?`${f} · ${p}`:f,l.append(u,d);let m=document.createElement(`div`);if(m.className=`device-btns`,s)m.append(r(`plug-off`,{title:`Disconnect`,className:`device-disconnect`,onClick:()=>k.disconnect()}));else if(t){let e=r(`plug`,{title:`Connecting… (tap to cancel)`,className:`device-connecting`,onClick:()=>k.disconnect()}),t=typeof performance<`u`?performance.now():0;e.style.setProperty(`--conn-phase`,`-${t%Bt}ms`),m.append(e)}else if(i)m.append(r(`plug`,{title:`Connect`,className:`device-connect`,onClick:()=>k.connect(e.wssUrl,e.label)}));else if(ee(e.wssUrl)&&e.lanUrl){let t=e.lanUrl;m.append(r(`plug`,{title:`Connect over Wi-Fi (${Jt(t)})`,className:`device-connect`,onClick:()=>k.connect(t,e.label)}),r(`ble-search`,{title:`Find over Bluetooth`,onClick:()=>ke(e)}))}else m.append(r(`ble-search`,{title:`Find over Bluetooth`,onClick:()=>ke(e)}));return m.append(r(`more`,{title:`Options`,onClick:()=>qt(e)})),o.append(c,l,m),o}function Kt(e=k.status){let t=k.client;if(!t?.isConnected)return e.text;let n=t.clock.rttMs,r=Number.isFinite(n)?`${e.text} · ${Math.round(n)} ms RTT`:e.text,i=v(t.meshState).length;return t.meshAll&&i>0?`${r} · controls ${i+1} meshed fixtures`:r}function qt(e){let t=A.get(e.id)??e,a=_e(t),o=p(`Device`);o.body.className=`device-detail`;let s=A.activeId()===e.id&&(k.client?.isConnected??!1),c=t.label,l=(e,t)=>{let n=document.createElement(`div`);n.className=`device-detail-row`;let r=document.createElement(`span`);r.className=`device-detail-cap`,r.textContent=e;let i=document.createElement(`span`);return i.className=`device-detail-val metric`,i.textContent=t,n.append(r,i),n},u=(e,t)=>{if(!t.buildUrl)return l(e,t.build);let n=document.createElement(`div`);n.className=`device-detail-row`;let r=document.createElement(`span`);r.className=`device-detail-cap`,r.textContent=e;let i=document.createElement(`a`);return i.className=`device-detail-val metric about-link`,i.href=t.buildUrl,i.textContent=t.build,i.title=t.commit,i.target=`_blank`,i.rel=`noopener noreferrer`,n.append(r,i),n},d=document.createElement(`div`);d.className=`device-detail-field`;let m=document.createElement(`span`);m.className=`device-detail-cap`,m.textContent=`Display name (also the Bluetooth name)`;let h=document.createElement(`div`);h.className=`device-name-row`,d.append(m,h);let _=t=>{A.rename(e.id,t),s&&k.client?k.client.setDeviceName(t).then(t=>{A.applyWelcome(e.id,{mac:t.mac,deviceName:t.deviceName,fwGitCommit:t.fwGitCommit,fwGitDirty:t.fwGitDirty,fwVersion:t.fwVersion}),A.takePending(e.id),i(`Device renamed`)}).catch(()=>i(`Rename will apply on next connection`)):i(`Name saved — applies on next connection`)},v=()=>{let e=document.createElement(`span`);e.className=`device-name-val`,e.textContent=c;let t=r(`edit`,{title:`Rename`,onClick:()=>y()});h.replaceChildren(e,t)},y=()=>{let e=document.createElement(`input`);e.className=`sheet-input device-name-input`,e.value=c;let t=r(`save`,{title:`Save`,onClick:()=>i(!0)});t.addEventListener(`pointerdown`,e=>{e.preventDefault(),i(!0)});let n=!1,i=t=>{if(n)return;n=!0;let r=e.value.trim();t&&r&&r!==c&&(c=r,_(r)),v()};e.addEventListener(`blur`,()=>i(!1)),e.addEventListener(`keydown`,e=>{e.key===`Enter`?(e.preventDefault(),i(!0)):e.key===`Escape`&&(e.preventDefault(),i(!1))}),h.replaceChildren(e,t),e.focus(),e.select()};v();let b=document.createElement(`hr`);b.className=`device-detail-divider`;let x=f([{label:`Gamma`,icon:`gamma`,onClick:()=>{o.close(),location.hash=`#/settings/color-correction`}},{label:`Hardware`,icon:`chip`,onClick:()=>{o.close(),location.hash=`#/settings/hardware`}},{label:`Move`,icon:`folder`,onClick:()=>{o.close(),Fe({current:t.folder??``,existing:A.folders(),onPick:t=>A.setFolder(e.id,t)})}},{label:`Forget`,icon:`trash`,variant:`danger`,onClick:()=>{A.forget(e.id),o.close()}}]),C=k.client;if(s&&C&&(async()=>{if(!await E(C))return;let{calibrateFromDevice:e,deviceMaps:t}=await j(async()=>{let{calibrateFromDevice:e,deviceMaps:t}=await import(`./deviceMapCard-ggc-RE5v.js`).then(e=>e.i);return{calibrateFromDevice:e,deviceMaps:t}},__vite__mapDeps([20,5,19,15,16,17,8,2,4,3,6,18,14,7,21]),import.meta.url),r=await t.probe(C);if(r.kind!==`saved`&&r.kind!==`unsaved`)return;let i=document.createElement(`button`);i.type=`button`,i.className=`k-actiontile`,i.append(n(`camera`));let a=document.createElement(`span`);a.textContent=`Calibrate IMU`,i.append(a),i.addEventListener(`click`,()=>{i.disabled=!0,a.textContent=`Copying map…`,e(e=>{o.close(),location.hash=`#${e}`}).finally(()=>{i.disabled=!1,a.textContent=`Calibrate IMU`})}),x.insertBefore(i,x.lastElementChild)})(),o.body.append(d,x,b,l(`LAN address`,D(t)),l(`MAC address`,t.bleMac||`unknown (connect once)`),l(`Firmware version`,a.version),u(`Firmware build`,a),l(`Folder`,t.folder||`Ungrouped`)),s&&C&&(C.welcome?.features??[]).includes(`wifi_policy`)){let e=document.createElement(`div`);e.className=`device-detail-wifi`,e.textContent=`Wi-Fi: …`;let t=Ue(C,t=>{e.textContent=g(t),e.dataset.state=t.mode===`offline`?`offline`:t.state,e.dataset.otaPending=String(t.otaPending)}),n=document.createElement(`hr`);n.className=`device-detail-divider`,o.body.append(e,n,t)}if(s&&C&&S(C.welcome)){let e=document.createElement(`hr`);e.className=`device-detail-divider`,e.hidden=!0;let t=ht(C,{onShown:t=>e.hidden=!t,onChange:()=>Vt?.()});o.body.append(e,t)}if(s&&C&&Dt(C.welcome)){let e=document.createElement(`hr`);e.className=`device-detail-divider`,o.body.append(e,Rt(C))}if(s&&C&&se(C.welcome)){let e=document.createElement(`hr`);e.className=`device-detail-divider`,o.body.append(e,ft(C))}}function Jt(e){try{return new URL(e).host}catch{return e}}function Yt(e,t){let n=t||`This device`;return e===`again`?`Couldn't connect to ${n} over Wi-Fi. It serves one Wi-Fi connection at a time: if the Splanc agent, another phone or another browser tab is connected to it, close that and this reconnects by itself. If this browser forgot its certificate (or the device was reset), trust it again.`:`${n} uses a self-signed certificate — trust it once to connect. If its page then says the connection was refused, something else (the Splanc agent, another phone or browser tab) is connected to it: it serves one Wi-Fi connection at a time. Close that, or connect over Bluetooth.`}function Xt(e){let t=new URL(e).origin,n=k.client?.url??A.active()?.wssUrl??`wss://${new URL(e).host}/ws`;k.disconnect();let r=null,a=!1,o=null,s=e=>{e.origin===t&&e.data===`ledmapper-cert-ok`&&l(!0)},c=()=>{document.visibilityState===`visible`&&l()},l=(e=!1)=>{if(!a){a=!0,window.removeEventListener(`message`,s),document.removeEventListener(`visibilitychange`,c),o!==null&&window.clearInterval(o);try{r?.close()}catch{}window.setTimeout(()=>k.connect(n,void 0,{coldRetryLimit:6,...e?{trustedBefore:!0}:{}}),800),i(`Certificate trusted — connecting…`)}};if(window.addEventListener(`message`,s),document.addEventListener(`visibilitychange`,c),r=window.open(`about:blank`,`ledmapper-cert`,`width=420,height=560`),r===null){i(`Popup blocked — open the device page, accept the warning, then return`,{error:!0}),window.open(e,`_blank`,`noopener`);return}try{r.document.write(`<!doctype html><meta charset=utf-8><title>Certificate</title><body style='font:15px system-ui;padding:2rem;color:#333'>Preparing the device page…</body>`)}catch{}o=window.setInterval(()=>{let e=!1;try{e=r?.closed===!0}catch{}e&&l()},500),window.setTimeout(()=>{if(!a)try{r.location.href=e}catch{window.open(e,`_blank`,`noopener`)}},900)}function Zt(){let e=navigator;return/iP(hone|ad|od)/.test(e.userAgent)||e.platform===`MacIntel`&&(e.maxTouchPoints??0)>1}function Qt(e,t){let n=URL.createObjectURL(e),r=document.createElement(`a`);r.href=n,r.download=t,r.rel=`noopener`,r.style.display=`none`,document.body.appendChild(r),r.click(),r.remove(),setTimeout(()=>URL.revokeObjectURL(n),6e4)}async function $t(e,t,n){let r=new Blob([e],{type:n});if(Zt()&&typeof File<`u`&&typeof navigator.share==`function`){let e=new File([r],t,{type:n});if(navigator.canShare?.({files:[e]})??!1)try{await navigator.share({files:[e],title:t});return}catch(e){if(e instanceof DOMException&&e.name===`AbortError`)return}}Qt(r,t)}var en=class{worker;nextId=1;pending=new Map;statusListeners=new Set;lastStatus=null;constructor(){this.worker=new Worker(new URL(``+new URL(`compile-worker-BZ-VReks.js`,import.meta.url).href,``+import.meta.url),{type:`module`}),this.worker.onmessage=e=>{let t=e.data;if(t.kind===`status`){this.lastStatus=t.status;for(let e of this.statusListeners)e(t.status);return}let n=this.pending.get(t.id);n&&(this.pending.delete(t.id),t.kind===`disassemble`?n(t.text):n(t.result))}}onStatus(e){return this.statusListeners.add(e),()=>this.statusListeners.delete(e)}warm(){let e={id:this.nextId++,kind:`warm`};this.worker.postMessage(e)}compile(e){let t=this.nextId++,n={id:t,src:e};return new Promise(e=>{this.pending.set(t,e),this.worker.postMessage(n)})}disassemble(e){let t=this.nextId++,n={id:t,kind:`disassemble`,fxb:e};return new Promise(e=>{this.pending.set(t,e),this.worker.postMessage(n)})}dispose(){this.worker.terminate(),this.pending.clear(),this.statusListeners.clear()}};export{de as C,me as E,B as S,he as T,Ke as _,Mt as a,U as b,ct as c,Qe as d,Ze as f,qe as g,Je as h,Dt as i,Y as l,Ye as m,$t as n,bt as o,Xe as p,Ht as r,Z as s,en as t,ot as u,ze as v,pe as w,I as x,Fe as y};