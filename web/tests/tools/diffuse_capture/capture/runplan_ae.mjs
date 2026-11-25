// runplan_ae.mjs <tid> <plan.json> <outdir>
// Auto-exposure capture: per step, light the pattern with the camera in CONTINUOUS AE,
// let AE settle, grab "<name>_0.png"; then lock the camera at the exposure/ISO AE chose,
// blank the LEDs and grab "dark_<name>_0.png" (the matching dark frame), then back to AE.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const [tid, planPath, outdir] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
// One set_counting_pattern holds at most 32 blocks (the player refuses more; old
// firmware drew the first 32 silently): check the whole plan before capturing.
const over = plan.filter(s => s.blocks.length > 32).map(s => `${s.name} (${s.blocks.length})`);
if (over.length) { console.error('steps over 32 blocks:', over.join(', ')); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(x => x.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const ev = expr => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400))) : res(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
ws.onmessage = e => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
await new Promise(r => ws.onopen = r);
const grab = `(()=>{const v=window.__camv;const c=document.createElement("canvas");c.width=v.videoWidth;c.height=v.videoHeight;c.getContext("2d").drawImage(v,0,0);return c.toDataURL("image/png")})()`;
const save = (f, png) => writeFileSync(`${outdir}/${f}`, Buffer.from(png.split(',')[1], 'base64'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const track = `window.__camv.srcObject.getVideoTracks()[0]`;
const log = [];
for (const s of plan) {
  await ev(`${track}.applyConstraints({advanced:[{exposureMode:"continuous"}]}).then(()=>1)`);
  await ev(`__dc.setCountingPattern(${JSON.stringify(s.blocks)}, 0, "GRB").then(()=>1)`);
  await sleep(s.settleMs ?? 900);
  save(`${s.name}_0.png`, await ev(grab));
  const st = await ev(`(()=>{const s=${track}.getSettings();return {et:s.exposureTime,iso:s.iso}})()`);
  await ev(`${track}.applyConstraints({advanced:[{exposureMode:"manual",exposureTime:${st.et},iso:${st.iso}}]}).then(()=>1)`);
  await ev(`__dc.setCountingPattern([{start:0,count:250,rgb:[0,0,0]}], 0, "GRB").then(()=>1)`);
  await sleep(350);
  save(`dark_${s.name}_0.png`, await ev(grab));
  log.push({ name: s.name, exposure: 'ae', exposureTime: st.et, iso: st.iso, blocks: s.blocks });
}
await ev(`${track}.applyConstraints({advanced:[{exposureMode:"continuous"}]}).then(()=>1)`);
writeFileSync(`${outdir}/plan_done.json`, JSON.stringify(log));
console.log('done', plan.length); process.exit(0);
