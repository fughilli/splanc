const [tid, url] = process.argv.slice(2);
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(x => x.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl);
ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: 'Network.setCacheDisabled', params: { cacheDisabled: true } })); ws.send(JSON.stringify({ id: 0, method: 'Network.enable' })); ws.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url } })); };
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 2) setTimeout(() => process.exit(0), 8000); };
