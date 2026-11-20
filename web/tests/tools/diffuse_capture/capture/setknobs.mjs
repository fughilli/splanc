// setknobs.mjs <tid> <brightPct> <exposure01>: manual override + set sliders (fires 'change' like a user).
const [tid, b, x] = process.argv.slice(2);
const t = (await (await fetch('http://localhost:9222/json/list')).json()).find(z => z.id === tid);
const ws = new WebSocket(t.webSocketDebuggerUrl);
const expr = `(()=>{
  const btn=[...document.querySelectorAll("button")].find(e=>/Manual override/.test(e.textContent)); if(btn) btn.click();
  const [bs,es]=document.querySelectorAll("input[type=range]");
  for (const [el,v] of [[bs,${JSON.stringify(b)}],[es,${JSON.stringify(x)}]]) { el.value=v; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); }
  return {b:bs.value,x:es.value,mode:[...document.querySelectorAll("button")].find(e=>/servo|override/i.test(e.textContent))?.textContent.trim()};
})()`;
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result.result.value ?? m.result)); process.exit(0); } };
