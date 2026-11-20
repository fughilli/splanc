// Find the app's device client (has setCountingPattern) via CDP queryObjects; pin it as window.__dc.
const tid = process.argv[2];
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(x => x.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const call = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = e => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
await new Promise(r => ws.onopen = r);
const proto = await call('Runtime.evaluate', { expression: 'Object.prototype' });
const q = await call('Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId });
const r = await call('Runtime.callFunctionOn', {
  objectId: q.result.objects.objectId, returnByValue: true,
  functionDeclaration: `function(){ const cs = this.filter(o => { try { return typeof o.setCountingPattern === 'function' && !Object.prototype.hasOwnProperty.call(o,'setCountingPattern'); } catch { return false; } });
    window.__dcs = cs; window.__dc = cs[0];
    return { n: this.length, found: cs.length, info: cs.map(c => { try { return { url: c.url ?? c.wsUrl ?? null, open: c.sock ? c.sock.readyState : null, keys: Object.keys(c).slice(0,12) }; } catch(e) { return String(e); } }) }; }` });
console.log(JSON.stringify(r.result.result.value ?? r.result, null, 1)); process.exit(0);
