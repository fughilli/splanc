const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./blePicker-BYnb9u3o.js","./capacitorImprov-CsIuRQr7.js","./assetBase-C7BP6CBI.js","./improv--Wah3iBc.js","./guard-D2g0Xd7k.js","./chunk-QTnfLwEv.js","./native-4IISorch.js","./kit-BZRlQmWH.js","./bleTransport-DAtJ-Ii2.js","./nativeBlePlayer-DlyMEqQ4.js","./flashSheet-N1GzxZmM.js","./webserial-BcCS38qm.js","./env-DizaJSfd.js","./firmwareRepo-CBMMuuvM.js","./otaUpdate-CSk3r2AD.js","./state-VJiFvB4b.js","./imuCalWriteback-CAb3qBN2.js","./imuExtrinsic-C3sWgyWW.js","./client-BhiLGUWW.js","./proto-Cut5LJRN.js","./deviceMapCard-Bw3leNpf.js","./mapview-DOAemO49.js"])))=>i.map(i=>d[i]);
import{n as e}from"./chunk-QTnfLwEv.js";import{_ as t,c as n,g as r,h as i,i as a,l as o,m as s,n as c,o as l,p as u,t as d,u as f}from"./kit-BZRlQmWH.js";import{n as p}from"./native-4IISorch.js";import{A as m,D as h,E as g,M as _,N as v,O as y,T as b,j as x,k as S,w as C}from"./client-BhiLGUWW.js";import{c as w,i as T,l as E,o as D,t as O,u as k}from"./state-VJiFvB4b.js";import{c as ee}from"./bleTransport-DAtJ-Ii2.js";import{n as A}from"./assetBase-C7BP6CBI.js";import{a as te,c as ne,l as re,s as ie,u as ae}from"./improv--Wah3iBc.js";import{i as j}from"./otaUpdate-CSk3r2AD.js";import{a as oe,i as se,l as M,o as ce,s as le,t as ue}from"./kiosk-BB4OdQTD.js";var de=`fughilli/splanc`,fe=`https://github.com/${de}`,pe={gitCommit:`e9e8ee91f758f46f75b599777ef22b1434f6f9a7`,gitCommitShort:`e9e8ee91`,gitDirty:!1,version:`0.0.0-dev`};function N(e){return`${fe}/commit/${e}`}function me(e,t){if(!e)return`unknown`;let n=e.slice(0,8);return t?`${n} (dirty)`:n}var he=`unknown (connect once)`;function ge(e){let t=e.fwGitCommit??``,n=t.length>0;return{version:e.fwVersion||he,build:n?me(t,e.fwGitDirty??!1):he,buildUrl:n?N(t):null,commit:t}}var _e=`ledmapper.wifi`,ve=`ledmapper.wifiList`,ye=`ledmapper.calibratedK`,be=`ledmapper.theme`,xe=`ledmapper.captureLedCount`,Se=`ledmapper.manualExposureCeilingMs`,Ce=`ledmapper.aiHintDismissed`,P=`ledmapper.diffuseCapture`,F=`ledmapper.diffuseParams`,I=`ledmapper.stripPriorOff`,L=.2,we=`ledmapper.minCameraDistM`,Te={anchorDensity:3,lcGain:1,threshold:.18,downscale:2,flipV:!1};function R(e,t,n,r){let i=typeof e==`number`?e:parseFloat(String(e));return Number.isFinite(i)?Math.min(n,Math.max(t,i)):r}function z(e,t){try{let n=localStorage.getItem(e);return n?JSON.parse(n):t}catch{return t}}function B(e,t){try{localStorage.setItem(e,JSON.stringify(t))}catch{}}var V={getWifi(){return z(_e,{ssid:``,password:``})},setWifi(e){B(_e,e)},getWifiList(){let e=z(ve,[]);if(Array.isArray(e)&&e.length>0)return e.filter(e=>e&&e.ssid);let t=this.getWifi();return t.ssid?[t]:[]},addWifi(e){if(!e.ssid)return;let t=this.getWifiList().filter(t=>t.ssid!==e.ssid);t.unshift(e),B(ve,t.slice(0,8)),this.setWifi(e)},getCalibratedK(){return z(ye,null)??void 0},getCaptureLedCount(){let e=localStorage.getItem(xe),t=e===null?NaN:parseInt(e,10);return Number.isFinite(t)&&t>=1?t:void 0},setCaptureLedCount(e){if(!(!Number.isFinite(e)||e<1))try{localStorage.setItem(xe,String(Math.round(e)))}catch{}},getManualExposureCeilingMs(){let e=localStorage.getItem(Se),t=e===null?NaN:parseFloat(e);return Number.isFinite(t)&&t>0?t:50},setManualExposureCeilingMs(e){if(!(!Number.isFinite(e)||e<=0))try{localStorage.setItem(Se,String(Math.round(e)))}catch{}},getMinCameraDistM(){try{let e=localStorage.getItem(we),t=e===null?NaN:parseFloat(e);return Number.isFinite(t)&&t>=0&&t<=5?t:L}catch{return L}},setMinCameraDistM(e){if(!(!Number.isFinite(e)||e<0||e>5))try{localStorage.setItem(we,String(e))}catch{}},getTheme(){return localStorage.getItem(be)===`light`?`light`:`dark`},setTheme(e){try{localStorage.setItem(be,e)}catch{}},getAiHintDismissed(){return localStorage.getItem(Ce)===`1`},setAiHintDismissed(){try{localStorage.setItem(Ce,`1`)}catch{}},getDiffuseEnabled(){return localStorage.getItem(P)===`1`},setDiffuseEnabled(e){try{e?localStorage.setItem(P,`1`):localStorage.removeItem(P)}catch{}},getDiffuseParams(){let e=z(F,{}),t=Te;return{anchorDensity:Math.round(R(e.anchorDensity,3,32,t.anchorDensity)),lcGain:R(e.lcGain,0,4,t.lcGain),threshold:R(e.threshold,.01,1,t.threshold),downscale:Math.round(R(e.downscale,1,8,t.downscale)),flipV:typeof e.flipV==`boolean`?e.flipV:t.flipV}},setDiffuseParams(e){B(F,{...this.getDiffuseParams(),...e})},getStripPrior(){try{return localStorage.getItem(I)!==`1`}catch{return!0}},setStripPrior(e){try{e?localStorage.removeItem(I):localStorage.setItem(I,`1`)}catch{}},resetDiffuseParams(){try{localStorage.removeItem(F)}catch{}}},H=null,U={get(){return H?{...H}:null},set(e){H={ssid:e.ssid,password:e.password}},clear(){H=null}};async function Ee(){if(p()){let{pickImprovDeviceNative:e}=await A(async()=>{let{pickImprovDeviceNative:e}=await import(`./blePicker-BYnb9u3o.js`);return{pickImprovDeviceNative:e}},__vite__mapDeps([0,1,2,3,4,5,6,7]),import.meta.url);return e()}return re()}function W(e,t,n={}){let r=null,i=!1,a=f(e===`ble`?`Add device over Bluetooth`:`Add device by address`,{onClose:()=>{r?r.abort():u&&!i&&Oe(u)}});a.body.className=`wifi-sheet`;let s=V.getWifiList(),l=n.creds??U.get()??s[0]??{ssid:``,password:``},u=n.device??null,d=document.createElement(`p`);d.className=`wifi-lead`,d.textContent=e===`ble`?`Choose the Wi-Fi network the device should join, then pick it in the Bluetooth chooser.`:`Choose the Wi-Fi network the device is on, then enter its address.`;let p=document.createElement(`div`);p.className=`wifi-picks`;let m=document.createElement(`input`);m.className=`sheet-input`,m.placeholder=`Wi-Fi network (SSID)`,m.setAttribute(`aria-label`,`Wi-Fi network (SSID)`),m.value=l.ssid,m.setAttribute(`autocomplete`,`off`),m.setAttribute(`autocapitalize`,`off`),m.setAttribute(`autocorrect`,`off`),m.setAttribute(`spellcheck`,`false`);let h=document.createElement(`input`);h.className=`sheet-input`,h.placeholder=`Wi-Fi password`,h.setAttribute(`aria-label`,`Wi-Fi password`),h.value=l.password;let g=o(h,{autocomplete:`new-password`,className:`sheet-pw`}),_=()=>({ssid:m.value.trim(),password:h.value}),v=()=>U.set({ssid:m.value,password:h.value});m.addEventListener(`input`,v),h.addEventListener(`input`,v);let y=()=>{p.replaceChildren();for(let e of V.getWifiList()){let t=document.createElement(`button`);t.type=`button`,t.className=`wifi-pick`,e.ssid===m.value&&t.classList.add(`wifi-pick--on`),t.textContent=e.ssid,t.addEventListener(`click`,()=>{m.value=e.ssid,h.value=e.password,v(),y()}),p.appendChild(t)}};y(),m.addEventListener(`input`,y);let b=document.createElement(`div`);b.className=`wifi-status metric`,b.setAttribute(`role`,`status`),b.setAttribute(`aria-live`,`polite`);let x=(e,t=`info`)=>{b.textContent=e,b.classList.toggle(`wifi-status--error`,t===`error`)},S=c({label:e===`ble`?`Scan for device`:`Enter address`,icon:e===`ble`?`bluetooth`:`link`,block:!0,onClick:()=>{let n=_();if(e===`manual`){n.ssid&&V.addWifi(n),a.close(),Me(),t?.();return}O(n,u)}}),C=e=>{let t=S.querySelector(`span`);t&&(t.textContent=e)},w=c({label:`Edit Wi-Fi details`,icon:`edit`,variant:`quiet`,block:!0,onClick:()=>r?.abort()});w.classList.add(`wifi-secondary`),w.hidden=!0;let T=c({label:`Choose a different device`,variant:`quiet`,block:!0,onClick:()=>{u&&Oe(u),u=null,T.hidden=!0,O(_(),null)}});T.classList.add(`wifi-secondary`),T.hidden=!0;let E=e=>{m.disabled=e,h.disabled=e;for(let t of p.querySelectorAll(`button`))t.disabled=e;S.hidden=e,w.hidden=!e,e&&(T.hidden=!0)},D=e=>{E(!1);let t=e instanceof te?e.kind:null;t===`cancelled`?x(`Stopped waiting. Edit the Wi-Fi details, then try again.`):x(t===`wrong-password`||t===`not-found`?G(e):t===`timeout`?`The device didn't join the network in time. Check the Wi-Fi details, then try again.`:`Setup failed: ${G(e)}`,`error`);let n=t===`not-found`?m:h;n.focus(),n.select(),u&&(C(`Try again`),T.hidden=!1)},O=async(e,n)=>{if(!n){S.disabled=!0;try{n=await Ee()}catch(e){K(e)||x(`Bluetooth: ${G(e)}`,`error`);return}finally{S.disabled=!1}u=n}if(!e.ssid){x(`Enter a Wi-Fi network name.`,`error`),m.focus();return}let o=new AbortController;r=o,E(!0),x(`Connecting…`);try{await ke(n,e,e=>x(e),o.signal),r=null,i=!0,a.close(),t?.()}catch(e){r=null,D(e)}};if(a.body.append(d),s.length>0){let e=document.createElement(`div`);e.className=`wifi-cap`,e.textContent=`Saved networks`,a.body.append(e,p)}a.body.append(m,g.el,b,S,w,T),n.error===void 0?m.focus():D(n.error)}function De(e,t){(async()=>{let n;try{n=await Ee()}catch(e){K(e)||r(`Bluetooth: ${G(e)}`,{error:!0});return}if(e?.bleId&&n.id&&n.id!==e.bleId&&!await i({title:`Different device?`,message:`The device you picked${n.name?` ("${n.name}")`:``} doesn't look like "${e.label}" — it's a different Bluetooth device. Setting it up will connect to it and may overwrite "${e.label}"'s name. Continue?`,confirmLabel:`Continue`,danger:!0}))return;let a=V.getWifiList()[0];if(!a||!a.ssid){r(`Pick a Wi-Fi network first`,{error:!0}),W(`ble`,t,{device:n});return}try{await ke(n,a,e=>r(e)),t?.()}catch(e){e instanceof te&&e.kind!==`device`?W(`ble`,t,{device:n,creds:a,error:e}):r(`Setup failed: ${G(e)}`,{error:!0})}})()}function Oe(e){try{e.gatt?.disconnect()}catch{}}async function ke(e,t,n,i){let a=await ne(e,t.ssid,t.password,n,{signal:i});V.addWifi(t),U.clear();let o=a.map(e=>ie(e)).find(e=>e!==null);if(o){n(`Bridge joined ${t.ssid} (${o}).`),r(`Bridge is on ${t.ssid}. Not paired yet? Open Live via bridge and enter the code on its screen.`);return}let s=a.map(e=>ae(e)).find(e=>e!==null);if(!s)throw Error(`device joined but sent no usable address (${a})`);n(`Provisioned at ${s} — connecting…`),O.connect(s),e.id&&k.setBleId(s,e.id),r(`Device provisioned`)}function Ae(e){(async()=>{let{requestBleDevice:t,bleSocketFactory:n,bleDeviceUrl:i,BLE_UPLOAD_CHUNK_BYTES:a}=await A(async()=>{let{requestBleDevice:e,bleSocketFactory:t,bleDeviceUrl:n,BLE_UPLOAD_CHUNK_BYTES:r}=await import(`./bleTransport-DAtJ-Ii2.js`).then(e=>e.s);return{requestBleDevice:e,bleSocketFactory:t,bleDeviceUrl:n,BLE_UPLOAD_CHUNK_BYTES:r}},__vite__mapDeps([8,5,2,4,3,6]),import.meta.url),o;try{o=p()?await je():await t()}catch(e){K(e)||r(`Bluetooth: ${G(e)}`,{error:!0});return}let s=o.name||`Bluetooth device`,c=i(o);r(`Connecting over Bluetooth…`),O.connect(c,s,{socketFactory:n(o),coldRetryLimit:6,uploadChunkBytes:a}),o.id&&k.setBleId(c,o.id),e?.()})()}async function je(){let[{loadNativeBle:e,nativeBleDevice:t},{pickNativeBleDevice:n}]=await Promise.all([A(()=>import(`./nativeBlePlayer-DlyMEqQ4.js`),__vite__mapDeps([9,2,8,5,4,3,6]),import.meta.url),A(()=>import(`./blePicker-BYnb9u3o.js`),__vite__mapDeps([0,1,2,3,4,5,6,7]),import.meta.url)]),r=await e();return n(async(e,n)=>t(r,e,n),{title:`Connect over Bluetooth`,prompt:`Tap the device to connect:`})}function Me(){let e=prompt(`Device address (wss://host:port):`,`wss://`);if(e){if(!/^wss?:\/\//.test(e)){r(`Address must start with ws:// or wss://`,{error:!0});return}O.connect(e)}}function G(e){return e instanceof Error?e.message:String(e)}function K(e){return e instanceof DOMException&&(e.name===`NotFoundError`||e.name===`AbortError`)}function Ne(e){let n=f(e.title??`Move to folder`);n.body.className=`folder-picker`;let r=t=>{n.close(),e.onPick(t)},i=document.createElement(`div`);i.className=`folder-list`;let a=(n,i,a)=>{let o=document.createElement(`button`);o.type=`button`,o.className=`folder-row`+(i===e.current?` folder-row--on`:``),o.append(t(a));let s=document.createElement(`span`);return s.textContent=n,o.appendChild(s),o.addEventListener(`click`,()=>r(i)),o};i.appendChild(a(`Ungrouped`,``,`close`));for(let t of e.existing)i.appendChild(a(t,t,`folder`));let o=document.createElement(`div`);o.className=`folder-new`;let s=document.createElement(`input`);s.className=`sheet-input`,s.placeholder=`New folder name…`;let l=()=>{let e=s.value.trim();e&&r(e)};s.addEventListener(`keydown`,e=>{e.key===`Enter`&&(e.preventDefault(),l())}),o.append(s,c({label:`Create`,onClick:l})),n.body.append(i,o)}var Pe=`ledmapper.foldersCollapsed`;function Fe(){try{let e=localStorage.getItem(Pe),t=e?JSON.parse(e):[];return new Set(Array.isArray(t)?t:[])}catch{return new Set}}function Ie(e){try{localStorage.setItem(Pe,JSON.stringify([...e]))}catch{}}function Le(e,n,r,i,a){let o=new Map,s=[];for(let e of n){let t=(r(e)??``).trim();if(t){let n=o.get(t)??[];n.push(e),o.set(t,n)}else s.push(e)}let c=o.size>0,l=Fe(),u=(n,r,o=!1)=>{let s=`${a.scope}:${n}`,c=l.has(s),u=document.createElement(`button`);u.type=`button`,u.className=`folder-header`+(o?` folder-header--muted`:``);let d=t(`chevron`);d.classList.add(`folder-chevron`),u.append(d),o||u.append(t(`folder`));let f=document.createElement(`span`);f.className=`folder-header-name`,f.textContent=n;let p=document.createElement(`span`);p.className=`folder-count`,p.textContent=String(r.length),u.append(f,p),e.appendChild(u);let m=[];for(let t of r){let n=i(t);m.push(n),e.appendChild(n)}let h=()=>{u.classList.toggle(`folder-header--collapsed`,c);for(let e of m)e.classList.toggle(`folder-hidden`,c)};h(),u.addEventListener(`click`,()=>{c=!c,c?l.add(s):l.delete(s),Ie(l),h()})};for(let e of[...o.keys()].sort((e,t)=>e.localeCompare(t)))u(e,o.get(e));if(s.length>0)if(c)u(`Ungrouped`,s,!0);else for(let t of s)e.appendChild(i(t))}var Re={auto:`Auto`,fixed:`Fixed`,manual:`Manual`,offline:`Offline`},ze={auto:`Rescans soon after losing the network, backing off to the cap and keeping that pace. Optionally slows down after a long absence (off unless you set the hours below).`,fixed:`Rescans at a steady interval while the network is missing.`,manual:`Never looks for the network on its own — only when you tap Rejoin now.`,offline:`Forward-deployed: Wi-Fi radio off, credentials kept. Change it over Bluetooth or the console.`},Be=[{key:`scanCapS`,label:`Longest wait between scans (s)`,min:10,max:86400,modes:[`auto`]},{key:`decayAfterH`,label:`Slow down after unseen for (h, 0 = off)`,min:0,max:8760,modes:[`auto`]},{key:`sparseIntervalS`,label:`Slowed scan interval (s)`,min:60,max:86400,modes:[`auto`]},{key:`intervalS`,label:`Scan interval (s)`,min:10,max:86400,modes:[`fixed`]}];function Ve(e,t){let n=document.createElement(`div`);n.className=`wifi-policy`;let o=null,u=`auto`,d=!1,f=new Map,p=e=>{o=e,u=e.mode,t?.(e),_()},_=()=>{n.replaceChildren(),f.clear();let e=document.createElement(`div`);if(e.className=`device-detail-cap wifi-policy-title`,e.textContent=`Wi-Fi rejoin`,n.append(e),!o){let e=document.createElement(`div`);e.className=`wifi-policy-status`,e.textContent=`Reading Wi-Fi settings…`,n.append(e);return}let t=document.createElement(`div`);t.className=`wifi-policy-status`;let r=o.scans>0&&o.state===`searching`?` · ${o.scans} scans`:``;t.textContent=h(o)+r,n.append(t),o.otaPending&&n.append(He(C));let i=document.createElement(`div`);i.className=`wifi-policy-modes`;for(let e of b)i.append(a({label:Re[e],on:e===u,onClick:()=>{u=e,_()}}));n.append(i);let s=document.createElement(`div`);s.className=`device-detail-cap`,s.textContent=ze[u],n.append(s);for(let e of Be){if(!e.modes.includes(u))continue;let t=l({label:e.label,type:`number`,value:String(o[e.key])});t.input.inputMode=`numeric`,t.input.min=String(e.min),t.input.max=String(e.max),f.set(e.key,t.input),n.append(t.el)}let p=document.createElement(`div`);p.className=`wifi-policy-btns`;let m=c({label:`Apply`,variant:`primary`,disabled:d,onClick:()=>void w()});p.append(m),u!==`offline`&&o.mode!==`offline`&&p.append(c({label:`Rejoin now`,variant:`quiet`,disabled:d,onClick:()=>void T()})),n.append(p)},v=async e=>{if(!d){d=!0,_();try{await e()}catch(e){r(`Wi-Fi settings: ${e instanceof Error?e.message:String(e)}`,{error:!0})}finally{d=!1,_()}}},x=async e=>await s({title:`Update awaiting confirmation`,message:`A firmware update is installed but not yet confirmed. Keep the device online until the update is confirmed, so its networking gets checked before the device leaves the network. Confirm the update first, while the device is still online, then switch to ${Re[e]}.`,choices:[{id:`stay`,label:`Stay online`,variant:`primary`},{id:`force`,label:e===`offline`?`Go offline anyway`:`Switch anyway`,variant:`danger`}]})===`force`?i({title:`Skip the update check?`,message:`Without a network the update is confirmed on rendering alone, so its Wi-Fi is never checked. If it later can't rejoin, recover the device over Bluetooth, the console or USB.`,confirmLabel:e===`offline`?`Go offline anyway`:`Switch anyway`,danger:!0}):!1,w=()=>v(async()=>{if(!o)return;let t={mode:u};for(let e of Be){let n=f.get(e.key);if(!n)continue;let i=y(n.value);if(i===null||i<e.min||i>e.max){r(`${e.label}: enter ${e.min}–${e.max}`,{error:!0});return}t[e.key]=i}let n=S(o.mode,u);if(n&&!await i({...n,confirmLabel:u===`offline`?`Go offline`:`Switch to manual`,danger:u===`offline`}))return;if(m(u)&&u!==o.mode&&o.otaPending){if(!await x(u))return;t.force=!0}let a=await e.setWifiPolicy(t);if(a.refused===`ota_pending`&&!t.force){if(p(a),!await x(u))return;a=await e.setWifiPolicy({...t,force:!0})}p(a),a.refused?r(`Not applied: ${a.refused===`ota_pending`?`an update is awaiting confirmation`:a.refused}`,{error:!0}):a.mode===`offline`?r(`Offline mode on — use Bluetooth or the console to change it`):r(`Wi-Fi settings saved`)}),T=()=>v(async()=>{let t=await e.setWifiPolicy({rejoinNow:!0});p(t),r(t.nextScanS>0?`Rejoining — next scan in ${g(t.nextScanS)}`:`Rejoining…`)});return _(),e.getWifiPolicy().then(p,e=>{n.replaceChildren();let t=document.createElement(`div`);t.className=`device-detail-cap`,t.textContent=`Wi-Fi settings unavailable (${e instanceof Error?e.message:String(e)})`,n.append(t)}),n}function He(e){let t=document.createElement(`div`);return t.className=`k-card wifi-policy-warn`,t.style.borderColor=`var(--warn)`,t.textContent=e,t}var Ue=`rope_start`;function We(e){let t=t=>Math.max(0,e.find(e=>e.channel===t)?.ledCount??0);return t(1)>0?t(0):0}function Ge(e,t){return{...e.uniforms,[Ue]:t}}var Ke=[{id:`pumpkin-candles`,name:`Pumpkin Candles`,emoji:`🕯️`,sliders:[`speed`,`warmth`],uniforms:{speed:1,warmth:.4},source:`// Jack-o'-lantern candles: warm orange flicker in patches, like candles inside pumpkins.
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
`}];function q(e){return Array.isArray(e)?e:[e]}function qe(e,t,n={}){let r=[];for(let i of e.sliders){if(r.length>=2)break;let a=t.find(e=>e.name===i);if(!a||a.width!==1||a.ui.kind!==`slider`)continue;let{min:o,max:s}=a.ui,c=e.uniforms[i],l=n[i]??(c===void 0?void 0:q(c)[0])??a.default[0]??o,u=a.ui.step>0?a.ui.step:(s-o)/100;r.push({name:i,slot:a.slot,min:o,max:s,step:u,value:Math.min(s,Math.max(o,l))})}return r}function Je(e,t,n={}){return t.map(t=>{let r=t.default.slice(),i=e.uniforms[t.name];i!==void 0&&q(i).length===t.width&&(r=q(i).slice());let a=n[t.name];return a!==void 0&&t.width===1&&(r=[a]),{slot:t.slot,value:r}})}function Ye(e){return`boo-${e.id}`}function Xe(e,t=Ke){let n=t.find(t=>Ye(t)===e||t.id===e);return n?`${n.emoji} ${n.name}`:e}var J=`splanc.kioskSecrets.v1`;function Y(){try{let e=localStorage.getItem(J),t=e?JSON.parse(e):{};return t&&typeof t==`object`?t:{}}catch{return{}}}function Ze(e){try{localStorage.setItem(J,JSON.stringify(e))}catch{}}function Qe(e=$e){return Array.from(e(16),e=>e.toString(16).padStart(2,`0`)).join(``)}function $e(e){let t=new Uint8Array(e);return crypto.getRandomValues(t),t}function X(e){return e.trim().toUpperCase()}function et(e){return e?Y()[X(e)]:void 0}function tt(e){let t=Y(),n=X(e),r=t[n];if(r)return r;let i=Qe();return t[n]=i,Ze(t),i}function nt(e,t){let n=Y();n[X(e)]=t,Ze(n)}var rt=e({kioskStore:()=>Z}),Z=new class{clock=new ue;listeners=new Set;revertListeners=new Set;bound=null;boundConnected=!1;unsubs=[];started=!1;start(){this.started||(this.started=!0,O.subscribe(()=>this.follow()),this.follow())}get active(){return this.clock.status?.enabled===!0}get status(){return this.clock.status}remaining(){return this.clock.remaining()}subscribe(e){return this.listeners.add(e),()=>this.listeners.delete(e)}onRevert(e){return this.revertListeners.add(e),()=>this.revertListeners.delete(e)}apply(e){let t=this.clock.sync(e);if(this.emit(),t)for(let t of this.revertListeners)t(e)}async refresh(){let e=this.bound;if(!(!e?.isConnected||!se(e.welcome)))try{let t=M(await e.getKioskStatus());t&&this.apply(t)}catch{}}emit(){for(let e of this.listeners)e()}follow(){let e=O.client,t=O.status.state===`connected`;if(!(e===this.bound&&t===this.boundConnected)){if(e!==this.bound){for(let e of this.unsubs)e();this.unsubs=[],this.clock.clear(),this.bound=e,e&&this.unsubs.push(e.onKioskStatus(e=>{let t=M(e);t&&this.apply(t)}),e.onActivity(()=>{this.clock.noteActivity(),this.emit()})),this.emit()}if(this.boundConnected=t,e&&t){let t=le(e.welcome);t?this.apply(t):this.refresh()}}}},it=!1;function at(){if(it||typeof document>`u`)return;it=!0;let e=document.createElement(`style`);e.textContent=ot,document.head.appendChild(e)}var ot=`
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
`;function st(e){let t=e?.code;return t===`kiosk_locked`?`the device is locked — unlock it first`:t===`kiosk_bad_secret`?`wrong owner secret (wait a couple of seconds before retrying)`:t===`kiosk_secret_required`?`the device needs an owner secret`:t===`kiosk_no_effect`?`nothing is playing to capture — start an effect first`:t===`kiosk_bad_config`?`the device rejected these settings`:e instanceof Error?e.message:String(e)}function ct(e){if(!e)return`Kiosk: reading…`;if(!e.enabled)return`Kiosk: off`;let t=[`Kiosk: on · idle ${oe(e.idleTimeoutS)}`];return t.push(e.hasAttract||e.attractName?`show: ${Xe(e.attractName)}`:`no attract show captured`),t.push(e.ownerUnlocked?`unlocked (owner)`:`locked`),t.join(` · `)}function lt(e){at();let t=document.createElement(`div`);t.className=`kiosk-section`;let n=e.welcome?.mac??``,a=Z.status,o=!1,s=a?.enabled??!1,d=!(a?.enabled??!1),f=null,p=e=>{let t=M(e);t&&(a=t,s=t.enabled,Z.apply(t),_())},m=async(e,t)=>{if(!o){o=!0,_();try{await t()}catch(t){r(`${e}: ${st(t)}`,{error:!0})}finally{o=!1,_()}}},h=()=>m(`Unlock`,async()=>{let t=et(n);if(!t){let e=prompt(`Owner secret for this device (from the phone that set up kiosk mode):`)?.trim();if(!e)return;t=e}let i=await e.kioskUnlock(t);if(!i.ownerUnlocked)throw Error(`wrong owner secret`);n&&nt(n,t),p(i),r(`Unlocked for this connection`)}),g=()=>m(`Kiosk settings`,async()=>{let t=Number(f?.value??120);if(!Number.isFinite(t)||t<10||t>86400){r(`Idle timeout: enter 10–86400 seconds`,{error:!0});return}if(!n)throw Error(`connect once so the device's identity is known`);let o=tt(n);if(a?.enabled&&!a.ownerUnlocked&&!(await e.kioskUnlock(o)).ownerUnlocked)throw Error(`this phone's owner secret doesn't match the device`);s&&!d&&!a?.hasAttract&&await i({title:`No attract show yet`,message:`Kiosk mode reverts to the attract show after the timeout. Capture what's playing now?`,confirmLabel:`Capture current look`,cancelLabel:`Leave as is`})&&(d=!0),p(await e.setKioskConfig(ce({enabled:s,idleTimeoutS:t,captureAttractFromCurrent:s&&d,ownerSecret:o}))),d=!1,r(s?`Kiosk mode on`:`Kiosk mode off`)});function _(){t.replaceChildren();let e=document.createElement(`div`);e.className=`device-detail-cap`,e.textContent=`Kiosk mode (public install)`;let i=document.createElement(`div`);i.className=`kiosk-status-line`,i.textContent=ct(a),t.append(e,i);let p=document.createElement(`div`);p.className=`kiosk-row`;let m=document.createElement(`label`);m.textContent=`Visitors can play; owner settings locked`;let v=u({on:s,label:`Kiosk mode`,onChange:e=>{s=e,e&&!a?.enabled&&(d=!0),_()}});p.append(m,v.el),t.append(p);let y=l({label:`Back to the show after (seconds idle)`,type:`number`,value:String(a?.idleTimeoutS??120)});y.input.inputMode=`numeric`,y.input.min=`10`,f=y.input,t.append(y.el);let b=document.createElement(`label`);b.className=`kiosk-row`;let x=document.createElement(`input`);x.type=`checkbox`,x.checked=d,x.addEventListener(`change`,()=>d=x.checked);let S=document.createElement(`span`);S.textContent=`Use the current effect, uniforms and brightness as the attract show`,b.append(x,S),t.append(b);let C=document.createElement(`div`);C.className=`kiosk-row`,C.append(c({label:`Apply`,variant:`primary`,disabled:o,onClick:()=>void g()})),a?.enabled&&!a.ownerUnlocked&&C.append(c({label:`Unlock`,variant:`quiet`,disabled:o,onClick:()=>void h()})),t.append(C);let w=et(n),T=document.createElement(`div`);T.className=`kiosk-secret`,T.textContent=w?`Owner secret (kept on this phone): ${w}`:`An owner secret is generated on this phone the first time you apply.`,t.append(T),w&&t.append(c({label:`Copy owner secret`,variant:`quiet`,onClick:()=>void navigator.clipboard?.writeText(w).then(()=>r(`Copied — keep it somewhere safe`),()=>r(`Couldn't copy`,{error:!0}))}));let E=document.createElement(`div`);E.className=`device-detail-cap`,E.textContent="Lost the secret? Run `kiosk off` on the device's USB serial console.",t.append(E)}return _(),e.getKioskStatus().then(p).catch(e=>{let n=t.querySelector(`.kiosk-status-line`);n&&(n.textContent=`Kiosk: couldn't read (${st(e)})`)}),t}var ut=!1;function dt(){if(ut||typeof document>`u`)return;ut=!0;let e=document.createElement(`style`);e.textContent=`
.mesh-section { display: flex; flex-direction: column; gap: 12px; }
.mesh-status-line { font-size: 0.875rem; color: var(--text-dim); }
.mesh-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mesh-row-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.mesh-row-title { font-size: 0.9375rem; }
.mesh-row-hint { font-size: 0.8125rem; color: var(--text-dim); }
`,document.head.append(e)}function ft(e,t={}){dt();let n=document.createElement(`div`);n.className=`mesh-section`,n.hidden=!0;let r=r=>{let i=v(r);if(n.replaceChildren(),i===null){n.hidden=!0,t.onShown?.(!1);return}n.hidden=!1,t.onShown?.(!0);let a=_(r).length,o=document.createElement(`div`);o.className=`device-detail-cap`,o.textContent=`Mesh`;let s=document.createElement(`div`);s.className=`mesh-status-line`,s.textContent=i;let c=document.createElement(`div`);c.className=`mesh-row`;let l=document.createElement(`div`);l.className=`mesh-row-text`;let d=document.createElement(`span`);d.className=`mesh-row-title`,d.id=`mesh-all-title`,d.textContent=`Control the whole mesh`;let f=document.createElement(`span`);f.className=`mesh-row-hint`,f.textContent=`Effect, slider, brightness and crossfade changes also go to the ${a} other fixture${a===1?``:`s`}, on the same frame. New effects reach only this fixture for now, unless they are very small.`,l.append(d,f);let p=u({on:e.meshAll,label:`Control the whole mesh`,onChange:n=>{e.setMeshAll(n),t.onChange?.(n)}});p.el.setAttribute(`aria-labelledby`,d.id),c.append(l,p.el),n.append(o,s,c)},i=()=>{n.hidden=!0,t.onShown?.(!1)};try{e.getMesh().then(r).catch(i)}catch{i()}return n}var Q=null,pt=1200,$=null;function mt(){if(Q)return;let e=()=>{},t=()=>{},n=()=>{},r=f(`Devices`,{onClose:()=>{e(),t(),n(),Q=null,$=null}});Q=r;let i=()=>{r.body.innerHTML=``,r.body.append(gt())};$=i,e=k.subscribe(i),t=O.subscribe(i),n=D.subscribe(i),D.refresh(),i(),ht(r.body,()=>D.probeAllNow())}function ht(e,t){let n=e.parentElement;if(!n)return;let r=document.createElement(`div`);r.className=`device-ptr`;let i=document.createElement(`div`);i.className=`device-ptr-spin`,r.append(i),n.insertBefore(r,e);let a=0,o=!1,s=!1,c=0,l=e=>{c=e,r.style.height=`${e}px`,i.style.opacity=`${Math.min(1,e/60)}`},u=()=>{r.classList.remove(`device-ptr--active`,`device-ptr--busy`,`device-ptr--done`),r.style.height=``,i.style.opacity=``,c=0,o=!1,s=!1};n.addEventListener(`touchstart`,e=>{s||(o=n.scrollTop<=0&&e.touches.length===1,a=e.touches[0].clientY)},{passive:!0}),n.addEventListener(`touchmove`,e=>{if(!o||s)return;if(n.scrollTop>0){l(0),o=!1;return}let t=e.touches[0].clientY-a;if(t<=0){l(0);return}e.preventDefault(),r.classList.add(`device-ptr--active`),l(Math.min(90,t*.5))},{passive:!1});let d=()=>{!o||s||(r.classList.remove(`device-ptr--active`),c>=60?(s=!0,r.classList.add(`device-ptr--busy`),r.style.height=`60px`,i.style.opacity=`1`,t().finally(()=>{r.classList.remove(`device-ptr--busy`),r.classList.add(`device-ptr--done`),window.setTimeout(u,240)})):u())};n.addEventListener(`touchend`,d),n.addEventListener(`touchcancel`,d)}function gt(){let e=document.createElement(`div`),t=O.status,i=k.activeId(),a=k.list();if(t.certUrl){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--warn)`,n.style.marginBottom=`var(--sp-3)`;let r=document.createElement(`div`);r.className=`device-trust-text`,r.textContent=xt(t.trustKind??`first`,k.active()?.label),r.style.marginBottom=`var(--sp-2)`;let i=c({label:t.trustKind===`again`?`Trust again & connect`:`Trust & connect`,onClick:()=>St(t.certUrl)}),a=c({label:`Connect over Bluetooth`,onClick:()=>Ae()});n.append(r,i,a),e.append(n)}if(t.certChanged){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--err)`,n.style.marginBottom=`var(--sp-3)`;let i=document.createElement(`div`);i.textContent=t.certChanged.message,i.style.marginBottom=`var(--sp-2)`;let a=c({label:`I reset it — trust the new certificate`,onClick:()=>{O.retrustCert(),r(`Certificate re-trusted`)}}),o=c({label:`Disconnect`,onClick:()=>O.disconnect()});n.append(i,a,o),e.append(n)}if(t.error){let n=document.createElement(`div`);n.className=`k-card`,n.style.borderColor=`var(--err)`,n.style.color=`var(--err)`,n.style.marginBottom=`var(--sp-3)`,n.textContent=t.error,e.append(n)}if(a.length===0){let t=document.createElement(`div`);t.className=`device-empty`,t.textContent=`No devices yet. Add one to get started.`,e.append(t)}let o=new Map;for(let e of a)o.set(e.label,(o.get(e.label)??0)+1);Le(e,a,e=>e.folder,e=>_t(e,e.id===i,t,D.isReachable(e.id),(o.get(e.label)??0)>1),{scope:`devices`});let s=O.client?.welcome;if(s&&((s.features??[]).includes(`ota`)||j(s))){let t=k.get(i??``)?.label||s.deviceName||`this device`,n=c({label:j(s)?`Update firmware — ${t} is in its updater`:`Update firmware`,icon:`chip`,...j(s)?{variant:`primary`}:{},block:!0,onClick:()=>void A(()=>import(`./flashSheet-N1GzxZmM.js`).then(e=>e.openFlashSheet()),__vite__mapDeps([10,2,11,12,13,14,15,16,5,17,8,4,3,6,18,19,7]),import.meta.url)});n.classList.add(`device-update-fw`),n.title=`Update ${t}'s firmware over Wi-Fi`,e.append(n)}let l=document.createElement(`div`);l.className=`device-add`;let u=document.createElement(`div`);u.className=`device-add-label`,u.textContent=`Add device…`;let d=document.createElement(`div`);return d.className=`device-add-row`,d.append(n(`bluetooth`,{title:`Add device (Bluetooth)`,onClick:()=>W(`ble`)}),n(`plug`,{title:`Connect over Bluetooth (offline)`,onClick:()=>Ae()}),n(`link`,{title:`Enter address manually`,onClick:()=>W(`manual`)}),n(`chip`,{title:`Flash a new board (USB)`,onClick:()=>void A(()=>import(`./flashSheet-N1GzxZmM.js`).then(e=>e.openFlashSheet()),__vite__mapDeps([10,2,11,12,13,14,15,16,5,17,8,4,3,6,18,19,7]),import.meta.url)})),l.append(u,d),e.append(l),e}function _t(e,t,r=O.status,i=!1,a=!1){let o=document.createElement(`div`);o.className=`device-row`;let s=t&&r.state===`connected`,c=document.createElement(`span`);c.className=`device-dot`,c.dataset.state=t?r.state:i?`reachable`:`offline`;let l=document.createElement(`div`);l.className=`device-info`;let u=document.createElement(`div`);u.className=`device-name`,u.textContent=e.label;let d=document.createElement(`div`);d.className=`device-url`;let f=t?vt(r):i?`on this network · ${E(e)}`:E(e),p=a?w(e):``;d.textContent=p?`${f} · ${p}`:f,l.append(u,d);let m=document.createElement(`div`);if(m.className=`device-btns`,s)m.append(n(`plug-off`,{title:`Disconnect`,className:`device-disconnect`,onClick:()=>O.disconnect()}));else if(t){let e=n(`plug`,{title:`Connecting… (tap to cancel)`,className:`device-connecting`,onClick:()=>O.disconnect()}),t=typeof performance<`u`?performance.now():0;e.style.setProperty(`--conn-phase`,`-${t%pt}ms`),m.append(e)}else if(i)m.append(n(`plug`,{title:`Connect`,className:`device-connect`,onClick:()=>O.connect(e.wssUrl,e.label)}));else if(ee(e.wssUrl)&&e.lanUrl){let t=e.lanUrl;m.append(n(`plug`,{title:`Connect over Wi-Fi (${bt(t)})`,className:`device-connect`,onClick:()=>O.connect(t,e.label)}),n(`ble-search`,{title:`Find over Bluetooth`,onClick:()=>De(e)}))}else m.append(n(`ble-search`,{title:`Find over Bluetooth`,onClick:()=>De(e)}));return m.append(n(`more`,{title:`Options`,onClick:()=>yt(e)})),o.append(c,l,m),o}function vt(e=O.status){let t=O.client;if(!t?.isConnected)return e.text;let n=t.clock.rttMs,r=Number.isFinite(n)?`${e.text} · ${Math.round(n)} ms RTT`:e.text,i=_(t.meshState).length;return t.meshAll&&i>0?`${r} · controls ${i+1} meshed fixtures`:r}function yt(e){let i=k.get(e.id)??e,a=ge(i),o=f(`Device`);o.body.className=`device-detail`;let s=k.activeId()===e.id&&(O.client?.isConnected??!1),c=i.label,l=(e,t)=>{let n=document.createElement(`div`);n.className=`device-detail-row`;let r=document.createElement(`span`);r.className=`device-detail-cap`,r.textContent=e;let i=document.createElement(`span`);return i.className=`device-detail-val metric`,i.textContent=t,n.append(r,i),n},u=(e,t)=>{if(!t.buildUrl)return l(e,t.build);let n=document.createElement(`div`);n.className=`device-detail-row`;let r=document.createElement(`span`);r.className=`device-detail-cap`,r.textContent=e;let i=document.createElement(`a`);return i.className=`device-detail-val metric about-link`,i.href=t.buildUrl,i.textContent=t.build,i.title=t.commit,i.target=`_blank`,i.rel=`noopener noreferrer`,n.append(r,i),n},p=document.createElement(`div`);p.className=`device-detail-field`;let m=document.createElement(`span`);m.className=`device-detail-cap`,m.textContent=`Display name (also the Bluetooth name)`;let g=document.createElement(`div`);g.className=`device-name-row`,p.append(m,g);let _=t=>{k.rename(e.id,t),s&&O.client?O.client.setDeviceName(t).then(t=>{k.applyWelcome(e.id,{mac:t.mac,deviceName:t.deviceName,fwGitCommit:t.fwGitCommit,fwGitDirty:t.fwGitDirty,fwVersion:t.fwVersion}),k.takePending(e.id),r(`Device renamed`)}).catch(()=>r(`Rename will apply on next connection`)):r(`Name saved — applies on next connection`)},v=()=>{let e=document.createElement(`span`);e.className=`device-name-val`,e.textContent=c;let t=n(`edit`,{title:`Rename`,onClick:()=>y()});g.replaceChildren(e,t)},y=()=>{let e=document.createElement(`input`);e.className=`sheet-input device-name-input`,e.value=c;let t=n(`save`,{title:`Save`,onClick:()=>i(!0)});t.addEventListener(`pointerdown`,e=>{e.preventDefault(),i(!0)});let r=!1,i=t=>{if(r)return;r=!0;let n=e.value.trim();t&&n&&n!==c&&(c=n,_(n)),v()};e.addEventListener(`blur`,()=>i(!1)),e.addEventListener(`keydown`,e=>{e.key===`Enter`?(e.preventDefault(),i(!0)):e.key===`Escape`&&(e.preventDefault(),i(!1))}),g.replaceChildren(e,t),e.focus(),e.select()};v();let b=document.createElement(`hr`);b.className=`device-detail-divider`;let S=d([{label:`Gamma`,icon:`gamma`,onClick:()=>{o.close(),location.hash=`#/settings/color-correction`}},{label:`Hardware`,icon:`chip`,onClick:()=>{o.close(),location.hash=`#/settings/hardware`}},{label:`Move`,icon:`folder`,onClick:()=>{o.close(),Ne({current:i.folder??``,existing:k.folders(),onPick:t=>k.setFolder(e.id,t)})}},{label:`Forget`,icon:`trash`,variant:`danger`,onClick:()=>{k.forget(e.id),o.close()}}]),C=O.client;if(s&&C&&(async()=>{if(!await T(C))return;let{calibrateFromDevice:e,deviceMaps:n}=await A(async()=>{let{calibrateFromDevice:e,deviceMaps:t}=await import(`./deviceMapCard-Bw3leNpf.js`).then(e=>e.i);return{calibrateFromDevice:e,deviceMaps:t}},__vite__mapDeps([20,5,19,15,16,17,8,2,4,3,6,18,14,7,21]),import.meta.url),r=await n.probe(C);if(r.kind!==`saved`&&r.kind!==`unsaved`)return;let i=document.createElement(`button`);i.type=`button`,i.className=`k-actiontile`,i.append(t(`camera`));let a=document.createElement(`span`);a.textContent=`Calibrate IMU`,i.append(a),i.addEventListener(`click`,()=>{i.disabled=!0,a.textContent=`Copying map…`,e(e=>{o.close(),location.hash=`#${e}`}).finally(()=>{i.disabled=!1,a.textContent=`Calibrate IMU`})}),S.insertBefore(i,S.lastElementChild)})(),o.body.append(p,S,b,l(`LAN address`,E(i)),l(`MAC address`,i.bleMac||`unknown (connect once)`),l(`Firmware version`,a.version),u(`Firmware build`,a),l(`Folder`,i.folder||`Ungrouped`)),s&&C&&(C.welcome?.features??[]).includes(`wifi_policy`)){let e=document.createElement(`div`);e.className=`device-detail-wifi`,e.textContent=`Wi-Fi: …`;let t=Ve(C,t=>{e.textContent=h(t),e.dataset.state=t.mode===`offline`?`offline`:t.state,e.dataset.otaPending=String(t.otaPending)}),n=document.createElement(`hr`);n.className=`device-detail-divider`,o.body.append(e,n,t)}if(s&&C&&x(C.welcome)){let e=document.createElement(`hr`);e.className=`device-detail-divider`,e.hidden=!0;let t=ft(C,{onShown:t=>e.hidden=!t,onChange:()=>$?.()});o.body.append(e,t)}if(s&&C&&se(C.welcome)){let e=document.createElement(`hr`);e.className=`device-detail-divider`,o.body.append(e,lt(C))}}function bt(e){try{return new URL(e).host}catch{return e}}function xt(e,t){let n=t||`This device`;return e===`again`?`Couldn't connect to ${n} over Wi-Fi. It serves one Wi-Fi connection at a time: if the Splanc agent, another phone or another browser tab is connected to it, close that and this reconnects by itself. If this browser forgot its certificate (or the device was reset), trust it again.`:`${n} uses a self-signed certificate — trust it once to connect. If its page then says the connection was refused, something else (the Splanc agent, another phone or browser tab) is connected to it: it serves one Wi-Fi connection at a time. Close that, or connect over Bluetooth.`}function St(e){let t=new URL(e).origin,n=O.client?.url??k.active()?.wssUrl??`wss://${new URL(e).host}/ws`;O.disconnect();let i=null,a=!1,o=null,s=e=>{e.origin===t&&e.data===`ledmapper-cert-ok`&&l(!0)},c=()=>{document.visibilityState===`visible`&&l()},l=(e=!1)=>{if(!a){a=!0,window.removeEventListener(`message`,s),document.removeEventListener(`visibilitychange`,c),o!==null&&window.clearInterval(o);try{i?.close()}catch{}window.setTimeout(()=>O.connect(n,void 0,{coldRetryLimit:6,...e?{trustedBefore:!0}:{}}),800),r(`Certificate trusted — connecting…`)}};if(window.addEventListener(`message`,s),document.addEventListener(`visibilitychange`,c),i=window.open(`about:blank`,`ledmapper-cert`,`width=420,height=560`),i===null){r(`Popup blocked — open the device page, accept the warning, then return`,{error:!0}),window.open(e,`_blank`,`noopener`);return}try{i.document.write(`<!doctype html><meta charset=utf-8><title>Certificate</title><body style='font:15px system-ui;padding:2rem;color:#333'>Preparing the device page…</body>`)}catch{}o=window.setInterval(()=>{let e=!1;try{e=i?.closed===!0}catch{}e&&l()},500),window.setTimeout(()=>{if(!a)try{i.location.href=e}catch{window.open(e,`_blank`,`noopener`)}},900)}function Ct(){let e=navigator;return/iP(hone|ad|od)/.test(e.userAgent)||e.platform===`MacIntel`&&(e.maxTouchPoints??0)>1}function wt(e,t){let n=URL.createObjectURL(e),r=document.createElement(`a`);r.href=n,r.download=t,r.rel=`noopener`,r.style.display=`none`,document.body.appendChild(r),r.click(),r.remove(),setTimeout(()=>URL.revokeObjectURL(n),6e4)}async function Tt(e,t,n){let r=new Blob([e],{type:n});if(Ct()&&typeof File<`u`&&typeof navigator.share==`function`){let e=new File([r],t,{type:n});if(navigator.canShare?.({files:[e]})??!1)try{await navigator.share({files:[e],title:t});return}catch(e){if(e instanceof DOMException&&e.name===`AbortError`)return}}wt(r,t)}var Et=class{worker;nextId=1;pending=new Map;statusListeners=new Set;lastStatus=null;constructor(){this.worker=new Worker(new URL(``+new URL(`compile-worker-BZ-VReks.js`,import.meta.url).href,``+import.meta.url),{type:`module`}),this.worker.onmessage=e=>{let t=e.data;if(t.kind===`status`){this.lastStatus=t.status;for(let e of this.statusListeners)e(t.status);return}let n=this.pending.get(t.id);n&&(this.pending.delete(t.id),t.kind===`disassemble`?n(t.text):n(t.result))}}onStatus(e){return this.statusListeners.add(e),()=>this.statusListeners.delete(e)}warm(){let e={id:this.nextId++,kind:`warm`};this.worker.postMessage(e)}compile(e){let t=this.nextId++,n={id:t,src:e};return new Promise(e=>{this.pending.set(t,e),this.worker.postMessage(n)})}disassemble(e){let t=this.nextId++,n={id:t,kind:`disassemble`,fxb:e};return new Promise(e=>{this.pending.set(t,e),this.worker.postMessage(n)})}dispose(){this.worker.terminate(),this.pending.clear(),this.statusListeners.clear()}};export{N as S,L as _,Z as a,pe as b,Ye as c,Ke as d,Ge as f,W as g,Ne as h,at as i,Je as l,Le as m,Tt as n,rt as o,We as p,mt as r,Xe as s,Et as t,qe as u,V as v,me as x,de as y};