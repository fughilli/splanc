import assert from "node:assert/strict";
import { test } from "node:test";
import { latestDemoPreview, makeDemoProvider } from "../src/effects/ai/providers/demo";

test("demo assistant carries tool history, images and abort signal without client credentials", async () => {
  const old = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://demo.invalid/chat");
    // The provider combines the caller's signal with its own deadline: a caller
    // abort must still cancel the request.
    assert.equal(init?.signal?.aborted, false);
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, undefined);
    assert.equal(body.max_tokens, 4000);
    assert.equal(body.messages[0].content, "Effect instructions");
    assert.equal(body.messages[2].role, "tool");
    assert.equal(body.messages[3].content[1].image_url.url, "data:image/png;base64,YQ==");
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", tool_calls: [{id:"edit",type:"function",function:{name:"set_script",arguments:'{"source":"new source"}'}}],
    } }] });
  };
  try {
    const result = await makeDemoProvider("https://demo.invalid/chat").send([
      {role:"assistant",content:[{type:"tool_use",id:"capture",name:"capture_preview",input:{}}]},
      {role:"user",content:[{type:"tool_result",tool_use_id:"capture",content:[{type:"image",source:{type:"base64",media_type:"image/png",data:"YQ=="}}]}]},
    ], {system:"Effect instructions",tools:[],signal:controller.signal,maxTokens:10000});
    assert.equal(result.stop_reason, "tool_use");
    assert.deepEqual(result.content, [{type:"tool_use",id:"edit",name:"set_script",input:{source:"new source"}}]);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = old; }
});

test("quota and unconfigured relay errors remain actionable and do not auto-retry", async () => {
  const old = globalThis.fetch;
  try {
    for (const [status, pattern] of [[429,/shared allowance/], [503,/temporarily unavailable/]] as const) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response("", {status}); };
      await assert.rejects(makeDemoProvider().send([], {system:"",tools:[]}), pattern);
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = old; }
});

test("malformed success cannot be mistaken for a completed AI turn", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "unavailable" });
  try { await assert.rejects(makeDemoProvider().send([], {system:"",tools:[]}), /incomplete response/); }
  finally { globalThis.fetch = old; }
});


test("repeated screenshots keep only the newest pixels without altering tool history", () => {
  const image = "data:image/png;base64," + "A".repeat(700000);
  const messages = Array.from({ length: 6 }, (_, i) => [
    { role: "assistant" as const, content: "", tool_calls: [{ id: `capture${i}`, type: "function" as const, function: { name: "capture_preview", arguments: "{}" } }] },
    { role: "tool" as const, tool_call_id: `capture${i}`, content: "Rendered preview" },
    { role: "user" as const, content: [{ type: "text" as const, text: `Frame ${i}` }, { type: "image_url" as const, image_url: { url: image } }] },
  ]).flat();
  assert(JSON.stringify(messages).length > 2 * 1024 * 1024);
  const result = latestDemoPreview(messages);
  assert(JSON.stringify(result).length < 1024 * 1024);
  assert.equal(result.filter(m => Array.isArray(m.content) && m.content.some(c => c.type === "image_url")).length, 1);
  assert.deepEqual(result.filter(m => m.role !== "user"), messages.filter(m => m.role !== "user"));
  assert.deepEqual(result.at(-1), messages.at(-1));
  assert.equal(messages.filter(m => Array.isArray(m.content) && m.content.some(c => c.type === "image_url")).length, 6, "does not mutate saved history");
});

test("oversize UTF-8 text is caught before sending; 413 explains how to continue", async () => {
  const old = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("", {status:413}); };
    await assert.rejects(makeDemoProvider().send([{role:"user",content:"🌈".repeat(550000)}], {system:"",tools:[]}), /Start a new chat/);
    assert.equal(calls, 0);
    await assert.rejects(makeDemoProvider().send([{role:"user",content:"hello"}], {system:"",tools:[]}), /your effect is saved/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = old; }
});
