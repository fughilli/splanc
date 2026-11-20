import { writeFileSync } from 'node:fs';
const [tid, bid, out] = process.argv.slice(2);
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(x => x.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl);
const expr = `(async()=>{const db=await new Promise((r,j)=>{const q=indexedDB.open("ledmapper-capturebundles");q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const b=await new Promise(r=>{const q=db.transaction("bundles").objectStore("bundles").get(${JSON.stringify(bid)});q.onsuccess=()=>r(q.result)});return JSON.stringify(b)})()`;
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { writeFileSync(out, m.result.result.value); console.log(out, m.result.result.value.length); process.exit(0); } };
