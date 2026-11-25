// runplan.mjs <tid> <plan.json> <outdir>
// plan: [{name, exposure (0..1 | null = keep), blocks:[{start,count,rgb}], frames, settleMs}]
// For each step: set exposure (if changed), set counting pattern (GRB), wait, grab N full-res PNGs.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const [tid, planPath, outdir] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
// One set_counting_pattern holds at most 32 blocks (the player refuses more; old
// firmware drew the first 32 silently): check the whole plan before capturing.
const over = plan.filter(s => s.blocks.length > 32).map(s => `${s.name} (${s.blocks.length})`);
if (over.length) { console.error('steps over 32 blocks:', over.join(', ')); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(x => x.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 1 << 28 });
let id = 0; const pend = new Map();
const ev = expr => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400))) : res(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
ws.onmessage = e => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
await new Promise(r => ws.onopen = r);
const grabExpr = `(()=>{const v=window.__camv;const c=document.createElement("canvas");c.width=v.videoWidth;c.height=v.videoHeight;c.getContext("2d").drawImage(v,0,0);return c.toDataURL("image/png")})()`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastExp = null; const log = [];
for (const s of plan) {
  if (s.exposure != null && s.exposure !== lastExp) { const et = await ev(`__setExp(${s.exposure})`); lastExp = s.exposure; await sleep(600); s.exposureTime = et; }
  await ev(`__dc.setCountingPattern(${JSON.stringify(s.blocks)}, 0, "GRB").then(()=>1)`);
  await sleep(s.settleMs ?? 180);
  for (let k = 0; k < (s.frames ?? 1); k++) {
    const png = await ev(grabExpr);
    writeFileSync(`${outdir}/${s.name}_${k}.png`, Buffer.from(png.split(',')[1], 'base64'));
    if (k + 1 < (s.frames ?? 1)) await sleep(40);
  }
  log.push({ name: s.name, exposure: lastExp, exposureTime: s.exposureTime, blocks: s.blocks });
}
writeFileSync(`${outdir}/plan_done.json`, JSON.stringify(log));
console.log('done', plan.length, 'steps'); process.exit(0);
