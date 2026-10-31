import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { clientKey, createDemoRelay, DEMO_LIMITS, DEMO_TOOLS, DEMO_MODELS, RELAY_PATHS } from '../_worker.js';
const url = 'https://splanc.pages.dev/api/demo-ai/chat/completions';
const env = { OPENROUTER_API_KEY: 'unit-test-secret' };
const tool = { type: 'function', function: { name: 'set_script', description: 'Edit an effect', parameters: { type: 'object' } } };
const body = { messages: [{ role: 'user', content: 'Make this rainbow' }], tools: [tool] };
const req = (payload = body, init = {}) => new Request(url, { method: 'POST', headers: { origin: 'https://splanc.io', 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify(payload), ...init });
const success = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] });
const failure = (status, metadata, headers) => Response.json({ error: { code: status, metadata } }, { status, headers });
const abortable = (_, init) => new Promise((resolve, reject) => {
  if (init.signal.aborted) reject(new Error('abort'));
  else init.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
});

test('only approved origins, methods and headers; GET reports no credentials', async () => {
  const relay = createDemoRelay({ fetchImpl: () => assert.fail('no inference') });
  for (const origin of ['https://evil.example', 'https://splanc.io.evil.example', 'null']) {
    const r = await relay(req(body, { headers: { origin } }), env);
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  const options = await relay(new Request(url, { method: 'OPTIONS', headers: { origin: 'https://splanc.io' } }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), 'https://splanc.io');
  const status = await relay(new Request(url, { headers: { origin: 'https://splanc.io' } }), env);
  assert.deepEqual(await status.json(), { configured: true, models: DEMO_MODELS });
  assert.equal((await relay(req(body, { method: 'PUT' }), env)).status, 405);
  assert.equal((await relay(req(), {})).status, 503);
});

test('locks upstream/model/price/output and preserves tool/image history', async () => {
  let sent;
  const relay = createDemoRelay({ fetchImpl: async (target, init) => { sent = { target, init, body: JSON.parse(init.body) }; return success(); } });
  const payload = { ...body, max_tokens: 8000, messages: [
    { role: 'system', content: 'You are an effect editor' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'capture_preview', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'Rendered' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
  ] };
  const result = await relay(req(payload), env);
  assert.equal(result.status, 200);
  assert.equal(sent.target, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, 'Bearer unit-test-secret');
  assert.equal(sent.init.redirect, 'manual');
  assert.equal(sent.body.model, DEMO_MODELS[0]);
  assert.equal(sent.body.max_tokens, 4000);
  // Claude leads, capped at its list price (USD per million tokens).
  assert.equal(sent.body.model, 'anthropic/claude-sonnet-5.5');
  assert.deepEqual(sent.body.provider.max_price, { prompt: 2, completion: 10, request: 0, image: 0 });
  assert.deepEqual(sent.body.messages, payload.messages);
  assert.equal(sent.body.stream, false);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(!(await result.text()).includes('unit-test-secret'));
});

test('rejects request overrides, arbitrary tools, remote image URLs, malformed JSON and oversized bytes', async () => {
  const relay = createDemoRelay({ limits: { ...DEMO_LIMITS, clientPerMinute: 100, clientPerHour: 100 },
    fetchImpl: () => assert.fail('invalid input must not reach provider') });
  for (const payload of [
    { ...body, model: 'paid' }, { ...body, provider: {} }, { ...body, stream: true },
    { ...body, max_tokens: -1 }, { ...body, messages: [] },
    { ...body, tools: [{ ...tool, function: { ...tool.function, name: 'exec' } }] },
    { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] },
  ]) assert.equal((await relay(req(payload), env)).status, 400);
  assert.equal((await relay(req(body, { body: '{' }), env)).status, 400);
  assert.equal((await relay(req(body, { body: 'x'.repeat(2 * 1024 * 1024 + 1) }), env)).status, 413);
  assert.equal((await relay(req(body, { headers: { origin: 'https://splanc.io', 'content-type': 'text/plain' } }), env)).status, 415);
});

test('availability failures fall through every model in order', async () => {
  const models = [];
  const relay = createDemoRelay({ fetchImpl: async (_, init) => {
    models.push(JSON.parse(init.body).model);
    return models.length === DEMO_MODELS.length ? success() : failure(models.length === 1 ? 503 : 404);
  } });
  assert.equal((await relay(req(), env)).status, 200);
  assert.deepEqual(models, DEMO_MODELS);
});

test('identified provider 429 falls back, platform/ambiguous quotas stop and preserve retry guidance', async () => {
  let calls = 0;
  const relay = createDemoRelay({ fetchImpl: async () => ++calls === 1 ? failure(429, { provider_name: 'provider', provider_code: 429 }) : success() });
  assert.equal((await relay(req(), env)).status, 200); assert.equal(calls, 2);
  for (const metadata of [undefined, { provider_name: 'provider' }]) {
    let count = 0;
    const limited = createDemoRelay({ fetchImpl: async () => { count++; return failure(429, metadata, { 'retry-after': '3600' }); } });
    const r = await limited(req(), env);
    assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '3600'); assert.equal(count, 1);
  }
});

test('auth, payment, input failures and refusal are not retried; upstream errors are not leaked', async () => {
  for (const status of [400, 401, 403, 422]) {
    let calls = 0;
    const relay = createDemoRelay({ fetchImpl: async () => { calls++; return failure(status, { raw: 'unit-test-secret' }); } });
    const r = await relay(req(), env);
    // A paid model's 400 (key guardrail) falls through; the first free model's is terminal.
    assert.equal(calls, status === 400 ? 3 : 1); assert.ok(!(await r.text()).includes('unit-test-secret'));
  }
  let calls = 0;
  const relay = createDemoRelay({ fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { role: 'assistant', refusal: 'No' }, finish_reason: 'content_filter' }] }); } });
  assert.equal((await relay(req(), env)).status, 422); assert.equal(calls, 1);
});

test('HTTP200 errors, empty/malformed/truncated/unknown tool outputs cannot become successful edits', async () => {
  for (const json of [{}, { choices: [{ message: { role: 'assistant', content: '' } }] },
    { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'exec', arguments: '{}' } }] } }] },
    { error: { code: 503, message: 'oops' } },
  ]) {
    let calls = 0;
    const relay = createDemoRelay({ fetchImpl: async () => { calls++; return Response.json(json); } });
    assert.equal((await relay(req(), env)).status, 503); assert.equal(calls, DEMO_MODELS.length);
  }
  const relay = createDemoRelay({ fetchImpl: async () => Response.json({ error: { code: 429 } }) });
  assert.equal((await relay(req(), env)).status, 429);
});

test('valid tool output is preserved; only requested tools may execute', async () => {
  const call = { id: 't1', type: 'function', function: { name: 'set_script', arguments: '{"source":"code"}' } };
  const relay = createDemoRelay({ fetchImpl: async () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] }) });
  const r = await relay(req(), env);
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).choices[0].message.tool_calls, [call]);
  assert.equal((await relay(req({ ...body, tools: [] }), env)).status, 503);
});

test('attempt deadline falls back; total deadline and cancellation stop the chain', async () => {
  let calls = 0;
  const relay = createDemoRelay({ attemptMs: 10, totalMs: 200, fetchImpl: async (...args) => ++calls === 1 ? abortable(...args) : success() });
  assert.equal((await relay(req(), env)).status, 200); assert.equal(calls, 2);
  calls = 0;
  const total = createDemoRelay({ attemptMs: 100, totalMs: 10, fetchImpl: (...args) => { calls++; return abortable(...args); } });
  assert.equal((await total(req(), env)).status, 504); assert.equal(calls, 1);
  calls = 0;
  const controller = new AbortController();
  const cancel = createDemoRelay({ fetchImpl: (...args) => { calls++; setTimeout(() => controller.abort(), 5); return abortable(...args); } });
  assert.equal((await cancel(req(body, { signal: controller.signal }), env)).status, 499); assert.equal(calls, 1);
  assert.equal((await cancel(req(body, { signal: controller.signal }), env)).status, 499); assert.equal(calls, 1);
});

test('rate budgets recover after the window; optional edge limiter fails closed', async () => {
  let now = 100000;
  const relay = createDemoRelay({ now: () => now, fetchImpl: async () => success() });
  for (let i = 0; i < DEMO_LIMITS.clientPerMinute; i++) assert.equal((await relay(req(), env)).status, 200);
  const limited1 = await relay(req(), env);
  assert.equal(limited1.status, 429);
  assert.equal((await limited1.json()).error.code, 'client_rate_limited');
  assert.ok(Number(limited1.headers.get('retry-after')) <= 60);
  now += 60001;
  assert.equal((await relay(req(), env)).status, 200);
  const limited = { ...env, AI_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await relay(req(), limited)).status, 429);
  limited.AI_RATE_LIMITER.limit = async () => { throw Error('offline'); };
  assert.equal((await relay(req(), limited)).status, 503);
});

test('sized for a ~1000/day shared key: per-client hourly cap, global per-minute cap', async () => {
  let now = 100000;
  const relay = createDemoRelay({ now: () => now, fetchImpl: async () => success() });
  const from = ip => req(body, { headers: { origin: 'https://splanc.io', 'content-type': 'application/json', 'cf-connecting-ip': ip } });
  // One visitor: 30 requests in an hour (6/minute), then told to wait for the hour.
  let ok = 0;
  for (let minute = 0; minute < 10; minute++, now += 60001) {
    for (let i = 0; i < DEMO_LIMITS.clientPerMinute; i++) if ((await relay(from('9.9.9.9'), env)).status === 200) ok++;
  }
  assert.equal(ok, DEMO_LIMITS.clientPerHour);
  const hourly = await relay(from('9.9.9.9'), env);
  assert.equal(hourly.status, 429);
  assert.equal((await hourly.json()).error.code, 'client_hourly_limit');
  assert.ok(Number(hourly.headers.get('retry-after')) > 60);
  now += 3600001;
  assert.equal((await relay(from('9.9.9.9'), env)).status, 200);
  // A crowd: the isolate stops at the upstream free per-minute cap, as demo_busy.
  now += 60001;
  let crowd = 0;
  for (let i = 0; i < 40; i++) if ((await relay(from(`10.0.0.${i}`), env)).status === 200) crowd++;
  assert.equal(crowd, DEMO_LIMITS.perMinute);
  const busy = await relay(from('10.0.1.1'), env);
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, 'demo_busy');
});

test('IPv6 visitors are keyed by /64 so rotating privacy addresses share one budget', async () => {
  assert.equal(clientKey('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(clientKey('2001:DB8:AA:BB::9'), '2001:db8:aa:bb::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('1.2.3.4'), '1.2.3.4');
  assert.equal(clientKey(null), 'unknown');
  const relay = createDemoRelay({ fetchImpl: async () => success() });
  const from = ip => req(body, { headers: { origin: 'https://splanc.io', 'content-type': 'application/json', 'cf-connecting-ip': ip } });
  for (let i = 0; i < DEMO_LIMITS.clientPerMinute; i++) assert.equal((await relay(from(`2001:db8:aa:bb::${i + 1}`), env)).status, 200);
  assert.equal((await relay(from('2001:db8:aa:bb:ffff::1'), env)).status, 429);
  assert.equal((await relay(from('2001:db8:aa:cc::1'), env)).status, 200);
});

test('the iOS app origin is allowed; lookalikes are not', async () => {
  const relay = createDemoRelay({ fetchImpl: async () => success() });
  const ok = await relay(req(body, { headers: { origin: 'capacitor://localhost', 'content-type': 'application/json' } }), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  for (const origin of ['capacitor://evil', 'http://localhost', 'capacitor://localhost.evil.example']) {
    assert.equal((await relay(req(body, { headers: { origin, 'content-type': 'application/json' } }), env)).status, 403, origin);
  }
});

test('static assets and existing worker routes remain separate', async () => {
  const r = await worker.fetch(new Request('https://ledmapper.pages.dev/anything'), { ASSETS: { fetch: async () => new Response('static') } });
  assert.equal(await r.text(), 'static');
  const gh = await worker.fetch(new Request('https://splanc.pages.dev/gh-asset?url=https://evil.example'), {});
  assert.equal(gh.status, 400);
});

test('splanc.pages.dev is retired: app paths 301 to splanc.io/app, agent files to the root, APIs stay', async () => {
  const noAssets = { ASSETS: { fetch: async () => assert.fail('retired origin must not serve the app') } };
  const loc = async (u) => {
    const r = await worker.fetch(new Request(u), noAssets);
    assert.equal(r.status, 301, u);
    return r.headers.get('location');
  };
  assert.equal(await loc('https://splanc.pages.dev/'), 'https://splanc.io/app/');
  assert.equal(await loc('https://splanc.pages.dev/effects.html?x=1#y'), 'https://splanc.io/app/effects.html?x=1');
  assert.equal(await loc('https://splanc.pages.dev/?url=wss://10.0.0.5/ws'), 'https://splanc.io/app/?url=wss://10.0.0.5/ws');
  assert.equal(await loc('https://splanc.pages.dev/fx-vm/fx_vm_wasm_pkg_bg.wasm'), 'https://splanc.io/app/fx-vm/fx_vm_wasm_pkg_bg.wasm');
  assert.equal(await loc('https://abc123.splanc.pages.dev/user-guide/'), 'https://splanc.io/app/user-guide/');
  assert.equal(await loc('https://splanc.pages.dev/AGENTS.md'), 'https://splanc.io/AGENTS.md');
  assert.equal(await loc('https://splanc.pages.dev/agent/latest.json'), 'https://splanc.io/agent/latest.json');
  assert.equal(await loc('https://splanc.pages.dev/.well-known/mcp/server.json'), 'https://splanc.io/.well-known/mcp/server.json');
  // An installed PWA's service worker is replaced by one that unregisters itself.
  const sw = await worker.fetch(new Request('https://splanc.pages.dev/sw.js'), noAssets);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(await sw.text(), /registration\.unregister\(\)/);
  // The API routes keep answering on the retired host.
  const gh = await worker.fetch(new Request('https://splanc.pages.dev/gh-asset?url=https://evil.example'), noAssets);
  assert.equal(gh.status, 400);
  const demo = await worker.fetch(new Request(url, { headers: { origin: 'https://splanc.io' } }), { ...noAssets, ...env });
  assert.equal(demo.status, 200);
  // Look-alike hosts are not retired.
  const other = await worker.fetch(new Request('https://notsplanc.pages.dev/'), { ASSETS: { fetch: async () => new Response('static') } });
  assert.equal(await other.text(), 'static');
});


test('deadline cancels a stalled upload and releases its stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const request = req(body, { body: stream, duplex: 'half' });
  const relay = createDemoRelay({ totalMs: 10, fetchImpl: () => assert.fail('upload incomplete') });
  assert.equal((await relay(request, env)).status, 504);
  assert.equal(cancelled, true);
});

// Cloudflare Workers rejects redirect:error synchronously, unlike Node fetch.
test('uses a Workers-compatible redirect mode and rejects every redirect without forwarding credentials', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const relay = createDemoRelay({ fetchImpl: async (url, init) => {
      calls++;
      if (init.redirect === 'error') throw new TypeError('Unsupported redirect mode');
      assert.equal(init.redirect, 'manual');
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Do not accept redirect body'},finish_reason:'stop'}]}), { status, headers: { location: 'https://untrusted.invalid' } });
    } });
    const response = await relay(req(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error:{code:'upstream_redirect'}});
    assert.equal(calls, 1);
  }
});

test('documented typed and legacy provider capacity errors use another model', async () => {
  for (const metadata of [
    {provider_name:'Example',error_type:'rate_limit_exceeded',provider_code:'rate_limited'},
    {provider_name:'Example',provider_code:'rate_limit_exceeded'},
    {provider_name:'Example',raw:'temporarily rate limited upstream'},
  ]) {
    let calls=0;
    const relay=createDemoRelay({fetchImpl:async()=>++calls===1 ? Response.json({error:{code:429,message:'Provider returned error',metadata}},{status:429}) : success()});
    assert.equal((await relay(req(),env)).status,200);
    assert.equal(calls,2);
  }
});
test('platform quota overrides provider metadata and never rotates models', async () => {
  for (const extra of [
    {headers:{'X-RateLimit-Remaining':'0','Retry-After':'300'}},
    {limit_source:'openrouter_free_daily'},
  ]) {
    let calls=0;
    const relay=createDemoRelay({fetchImpl:async()=>{calls++;return failure(429,{provider_name:'Example',provider_code:'rate_limited',...extra});}});
    const response=await relay(req(),env);
    assert.equal(response.status,429);assert.equal(calls,1);
    assert.deepEqual(await response.json(),{error:{code:'rate_limited',scope:'platform'}});
  }
});

test('exhausted fallback diagnostics expose only fixed models, status and safe outcomes', async () => {
  const relay=createDemoRelay({fetchImpl:async()=>failure(503,{raw:'private upstream payload'})});
  const response=await relay(req(),env);
  const body=await response.json();
  assert.deepEqual(body,{error:{code:'models_unavailable'},attempts:DEMO_MODELS.map(model=>({model,outcome:'upstream_error',status:503}))});
  assert(!JSON.stringify(body).includes('private upstream payload'));
  assert(!JSON.stringify(body).includes(env.OPENROUTER_API_KEY));
});

test('provider transport fields are discarded while validated tool calls remain usable', async () => {
  const call={id:'call_1',type:'function',function:{name:'set_script',arguments:'{"source":"blue"}'}};
  const relay=createDemoRelay({fetchImpl:async()=>Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{...call,index:0,function:{...call.function,transport_metadata:'discard'}}]}}]})});
  const response=await relay(req(),env);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).choices[0].message.tool_calls,[call]);
});

test('nullable tool-call field is normal on a plain assistant reply', async () => {
  const relay=createDemoRelay({fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Done',tool_calls:null}}]})});
  const response=await relay(req(),env);
  assert.equal(response.status,200);
  assert.equal((await response.json()).choices[0].message.content,'Done');
});


test('interactive reasoning policy survives fallback without raising token or price caps', async () => {
  const sent=[];
  const relay=createDemoRelay({fetchImpl:async(_,init)=>{sent.push(JSON.parse(init.body));return failure(503,{});}});
  assert.equal((await relay(req(),env)).status,503);
  assert.deepEqual(sent.map(x=>x.reasoning),[{effort:'low'},{effort:'low'},{enabled:false},{effort:'low'},{enabled:false}]);
  assert(sent.every(x=>x.max_tokens===4000));
  // Paid models never above their list price; every free fallback stays zero-priced.
  assert.deepEqual(sent.slice(0,2).map(x=>x.provider.max_price),[{prompt:2,completion:10,request:0,image:0},{prompt:0.1,completion:0.5,request:0,image:0}]);
  assert(sent.slice(2).every(x=>x.model.endsWith(':free')&&Object.values(x.provider.max_price).every(price=>price===0)));
});

test('200 headers followed by a stalled body report timeout and cancel each stream', async () => {
  let cancelled=0;
  const relay=createDemoRelay({attemptMs:10,totalMs:1000,fetchImpl:async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new TextEncoder().encode(' '));},cancel(){cancelled++;},
  }),{headers:{'content-type':'application/json'}})});
  const response=await relay(req(),env);
  assert.equal(response.status,503);
  assert.equal(cancelled,DEMO_MODELS.length);
  const result=await response.json();
  assert.deepEqual(result.attempts,DEMO_MODELS.map(model=>({model,outcome:'timeout'})));
});

test('splanc.pages.dev forwards the cloud relay paths to the RELAY binding, URL unchanged', async () => {
  const seen = [];
  const env = {
    RELAY: { fetch: async (req) => { seen.push(req.url); return new Response('relay'); } },
    ASSETS: { fetch: async () => assert.fail('relay paths must not reach the static site') },
  };
  for (const p of RELAY_PATHS) {
    const r = await worker.fetch(new Request(`https://splanc.pages.dev${p}?id=x`), env);
    assert.equal(await r.text(), 'relay', p);
  }
  assert.equal(seen[0], 'https://splanc.pages.dev/mcp?id=x');
  assert.equal(await (await worker.fetch(new Request('https://splanc.pages.dev/mcp/'), env)).text(), 'relay');

  // The site keeps its root, its other .well-known files and the APIs.
  const loc = async (u) => (await worker.fetch(new Request(u), env)).headers.get('location');
  assert.equal(await loc('https://splanc.pages.dev/'), 'https://splanc.io/app/');
  assert.equal(await loc('https://splanc.pages.dev/.well-known/mcp/server.json'), 'https://splanc.io/.well-known/mcp/server.json');
  assert.equal(await loc('https://splanc.pages.dev/mcpx'), 'https://splanc.io/app/mcpx');
  // Previews and other projects have no binding: they never forward.
  assert.equal(await loc('https://abc123.splanc.pages.dev/mcp'), 'https://splanc.io/app/mcp');
  const other = await worker.fetch(new Request('https://ledmapper.pages.dev/mcp'), { ASSETS: { fetch: async () => new Response('static') } });
  assert.equal(await other.text(), 'static');
  // A missing binding is a clear 503, not the app.
  const unbound = await worker.fetch(new Request('https://splanc.pages.dev/mcp'), { ASSETS: env.ASSETS });
  assert.equal(unbound.status, 503);
});

test('tool allowlist is exactly the five effect tools (acidFreeAi.test.ts pins the app side)', () => {
  assert.deepEqual([...DEMO_TOOLS].sort(), ['capture_preview', 'estimate_performance', 'list_midi_controls', 'set_midi_mapping', 'set_script']);
  assert.ok(!DEMO_TOOLS.has('file_bug') && !DEMO_TOOLS.has('measure_on_device'));
});

test('out of credit (402) on the paid models falls through to the free ones; 402 on a free model stops', async () => {
  const tried=[];
  const relay=createDemoRelay({fetchImpl:async(_,init)=>{const {model}=JSON.parse(init.body);tried.push(model);
    return model.endsWith(':free')?Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Done'}}]}):failure(402,{});}});
  const r=await relay(req(),env);
  assert.equal(r.status,200);
  assert.equal((await r.json()).model,'nvidia/nemotron-3.5-super-vl:free');
  assert.deepEqual(tried,['anthropic/claude-sonnet-5.5','anthropic/claude-haiku-5.5','nvidia/nemotron-3.5-super-vl:free']);
  let calls=0;
  const broke=createDemoRelay({fetchImpl:async(_,init)=>{calls++;return failure(402,{});}});
  assert.equal((await broke(req(),env)).status,503);
  assert.equal(calls,3,'paid models skipped, then the first free model\'s 402 is terminal');
});

test('a paid model the key rejects (400) falls through to the free ones', async () => {
  const seen=[];
  const relay=createDemoRelay({fetchImpl:async(_,init)=>{const {model}=JSON.parse(init.body);seen.push(model);
    return model.endsWith(':free')?Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Done'}}]}):failure(400,{});}});
  const r=await relay(req(),env);
  assert.equal(r.status,200);
  assert.deepEqual(seen,DEMO_MODELS.slice(0,3));
});
