// grab.mjs <tid> <outdir> <prefix> <n> <gapMs>: grab n full-res PNG frames from the capture <video>.
import { writeFileSync, mkdirSync } from 'node:fs';
const [tid, outdir, prefix, n = '1', gap = '0'] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(x => x.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const ev = expr => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); };
await new Promise(r => ws.onopen = r);
const expr = `(()=>{const v=(window.__camv||document.querySelector("video"));const c=document.createElement("canvas");c.width=v.videoWidth;c.height=v.videoHeight;c.getContext("2d").drawImage(v,0,0);return {t:performance.now(),png:c.toDataURL("image/png")}})()`;
for (let k = 0; k < +n; k++) {
  const r = (await ev(expr)).result.value;
  const f = `${outdir}/${prefix}_${String(k).padStart(3, '0')}.png`;
  writeFileSync(f, Buffer.from(r.png.split(',')[1], 'base64'));
  if (+gap) await new Promise(r => setTimeout(r, +gap));
}
console.log('grabbed', n, prefix); process.exit(0);
