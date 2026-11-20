// Tail console/log/exceptions of a Chrome page over CDP into stdout (one line per event).
const id = process.argv[2];
const list = await (await fetch('http://localhost:9222/json/list')).json();
const t = list.find(x => x.id === id);
if (!t) { console.error('target not found'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let n = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++n, method, params }));
const ts = () => new Date().toISOString().slice(11, 23);
const fmt = a => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value))
  : (a.preview ? JSON.stringify(Object.fromEntries((a.preview.properties || []).map(p => [p.name, p.value]))) : (a.description ?? a.type));
ws.onopen = () => { send('Runtime.enable'); send('Log.enable'); console.log(ts(), 'ATTACHED', t.url); };
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled') console.log(ts(), m.params.type.toUpperCase(), m.params.args.map(fmt).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; console.log(ts(), 'EXCEPTION', d.exception?.description ?? d.text); }
  else if (m.method === 'Log.entryAdded') console.log(ts(), 'LOG', m.params.entry.level, m.params.entry.source, m.params.entry.text, m.params.entry.url ?? '');
};
ws.onclose = () => { console.log(ts(), 'DETACHED'); process.exit(0); };
