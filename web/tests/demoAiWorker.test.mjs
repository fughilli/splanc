import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createDemoRelay, FREE_DEMO_MODELS, RELAY_PATHS } from '../_worker.js';
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
  assert.deepEqual(await status.json(), { configured: true, models: FREE_DEMO_MODELS });
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
  assert.equal(sent.body.model, FREE_DEMO_MODELS[0]);
  assert.equal(sent.body.max_tokens, 4000);
  assert.deepEqual(sent.body.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.deepEqual(sent.body.messages, payload.messages);
  assert.equal(sent.body.stream, false);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(!(await result.text()).includes('unit-test-secret'));
});

test('rejects request overrides, arbitrary tools, remote image URLs, malformed JSON and oversized bytes', async () => {
  const relay = createDemoRelay({ fetchImpl: () => assert.fail('invalid input must not reach provider') });
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

test('availability failures fall through all three free models in order', async () => {
  const models = [];
  const relay = createDemoRelay({ fetchImpl: async (_, init) => {
    models.push(JSON.parse(init.body).model);
    return models.length === 3 ? success() : failure(models.length === 1 ? 503 : 404);
  } });
  assert.equal((await relay(req(), env)).status, 200);
  assert.deepEqual(models, FREE_DEMO_MODELS);
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
  for (const status of [400, 401, 402, 403, 422]) {
    let calls = 0;
    const relay = createDemoRelay({ fetchImpl: async () => { calls++; return failure(status, { raw: 'unit-test-secret' }); } });
    const r = await relay(req(), env);
    assert.equal(calls, 1); assert.ok(!(await r.text()).includes('unit-test-secret'));
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
    assert.equal((await relay(req(), env)).status, 503); assert.equal(calls, 3);
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
  for (let i = 0; i < 24; i++) assert.equal((await relay(req(), env)).status, 200);
  assert.equal((await relay(req(), env)).status, 429);
  now += 60001;
  assert.equal((await relay(req(), env)).status, 200);
  const limited = { ...env, AI_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await relay(req(), limited)).status, 429);
  limited.AI_RATE_LIMITER.limit = async () => { throw Error('offline'); };
  assert.equal((await relay(req(), limited)).status, 503);
});

test('static assets and existing worker routes remain separate', async () => {
  const r = await worker.fetch(new Request('https://ledmapper.pages.dev/anything'), { ASSETS: { fetch: async () => new Response('static') } });
  assert.equal(await r.text(), 'static');
  const gh = await worker.fetch(new Request('https://splanc.pages.dev/gh-asset?url=https://evil.example'), {});
  assert.equal(gh.status, 400);
});

test('gh-asset accepts splanc release URLs under either owner (repo transfer), nothing else', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return new Response('tar'); };
  try {
    for (const owner of ['Studio-Fug', 'fughilli']) {
      const asset = `https://github.com/${owner}/splanc/releases/download/firmware-v1.0.0/esp32c6-ota-1.0.0.tar`;
      const r = await worker.fetch(new Request(`https://splanc.pages.dev/gh-asset?url=${encodeURIComponent(asset)}`), {});
      assert.equal(r.status, 200, owner);
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
    }
    for (const bad of ['https://github.com/someone/splanc/releases/download/x.tar',
                       'https://github.com/Studio-Fug/other/releases/download/x.tar']) {
      const r = await worker.fetch(new Request(`https://splanc.pages.dev/gh-asset?url=${encodeURIComponent(bad)}`), {});
      assert.equal(r.status, 400, bad);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 2);
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
  assert.deepEqual(body,{error:{code:'models_unavailable'},attempts:FREE_DEMO_MODELS.map(model=>({model,outcome:'upstream_error',status:503}))});
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
  assert.deepEqual(sent.map(x=>x.reasoning),[{effort:'low'},{enabled:false},{enabled:false}]);
  assert(sent.every(x=>x.max_tokens===4000));
  assert(sent.every(x=>Object.values(x.provider.max_price).every(price=>price===0)));
});

test('200 headers followed by a stalled body report timeout and cancel each stream', async () => {
  let cancelled=0;
  const relay=createDemoRelay({attemptMs:10,totalMs:1000,fetchImpl:async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new TextEncoder().encode(' '));},cancel(){cancelled++;},
  }),{headers:{'content-type':'application/json'}})});
  const response=await relay(req(),env);
  assert.equal(response.status,503);
  assert.equal(cancelled,3);
  const result=await response.json();
  assert.deepEqual(result.attempts,FREE_DEMO_MODELS.map(model=>({model,outcome:'timeout'})));
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
