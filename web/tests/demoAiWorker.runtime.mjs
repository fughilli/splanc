// Run with MINIFLARE_MODULE pointing to the pinned Miniflare installation.
// No real API key or upstream requests are used.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { Miniflare } = await import(pathToFileURL(process.env.MINIFLARE_MODULE).href);
const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const success = { choices: [{ message: { role: 'assistant', content: 'Synthetic success' }, finish_reason: 'stop' }] };
async function run(label, script, upstream, expected, expectedCalls, expectedCode) {
  let calls = 0;
  const runtime = new Miniflare({ modules: true, script, compatibilityDate: '2026-08-06',
    bindings: { OPENROUTER_API_KEY: 'synthetic-runtime-key' },
    outboundService: request => {
      assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
      const response = upstream[Math.min(calls++, upstream.length - 1)];
      return Response.json(response.body ?? success, { status: response.status, headers: response.headers });
    },
  });
  try {
    const response = await runtime.dispatchFetch('https://splanc.pages.dev/api/demo-ai/chat/completions', {
      method: 'POST', headers: { origin: 'https://splanc.io', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic probe' }] }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, label);
    assert.equal(calls, expectedCalls, label);
    if (expectedCode) assert.equal(body.error.code, expectedCode, label);
    else assert.equal(body.choices[0].message.content, 'Synthetic success', label);
    console.log(JSON.stringify({ label, status: response.status, outboundCalls: calls }));
  } finally { await runtime.dispose(); }
}
await run('old redirect mode fails before dispatch', source.replace('redirect: "manual", signal: attempt.signal', 'redirect: "error", signal: attempt.signal'), [{status:200}], 503, 0, 'models_unavailable');
await run('supported mode completes', source, [{status:200}], 200, 1);
await run('redirect never receives credentials', source, [{status:302,headers:{location:'https://untrusted.invalid/'}}], 503, 1, 'upstream_redirect');
await run('typed provider limit falls back', source, [
  {status:429,body:{error:{code:429,metadata:{provider_name:'Example',provider_code:'rate_limited',error_type:'rate_limit_exceeded'}}}},
  {status:200},
], 200, 2);
await run('shared quota stops', source, [{status:429,body:{error:{code:429,metadata:{provider_name:'Example',provider_code:'rate_limited',headers:{'X-RateLimit-Remaining':'0'}}}}}], 429, 1, 'rate_limited');
