const [id, expr] = process.argv.slice(2);
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(x => x.id === id);
const ws = new WebSocket(t.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result.result?.value ?? m.result, null, 1)); ws.close(); process.exit(0); } };
