/**
 * Self-serve tier, "OpenAI-compatible endpoint" (docs/design/ai-tiers.md):
 * the existing provider (providers/openaiCompat.ts — Ollama / LM Studio /
 * llama.cpp server / any /v1 URL) against a fake server on a real local port:
 * request shape (URL join, bearer key only when set, tools), the tool-call
 * round trip back into neutral blocks, model listing, and error surfacing.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { listOpenAiModels, makeOpenAiProvider } from "../src/effects/ai/providers/openaiCompat";

let server: Server;
let base = "";
const seen: { url: string; auth: string | undefined; body: Record<string, unknown> | null }[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString()));
    req.on("end", () => resolve(s));
  });
}

before(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "qwen2.5:7b" }, { id: "llama3.1:8b" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      if (body?.["model"] === "broken") {
        res.statusCode = 500;
        res.end('{"error":"model crashed"}');
        return;
      }
      const msgs = body?.["messages"] as { role: string }[];
      const hasToolResult = msgs.some((m) => m.role === "tool");
      res.end(
        JSON.stringify({
          choices: [
            hasToolResult
              ? { message: { role: "assistant", content: "Compiled. Enjoy." }, finish_reason: "stop" }
              : {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      { id: "c1", type: "function", function: { name: "set_script", arguments: '{"summary":"s","source":"vec3 shade(){return vec3(1.0);}"}' } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});

after(() => {
  server.close();
});

const tools = [{ name: "set_script", description: "d", input_schema: { type: "object" } }];

test("tool call round trip against a fake OpenAI-compatible server", async () => {
  seen.length = 0;
  const p = makeOpenAiProvider({ baseUrl: base, key: "", model: "qwen2.5:7b", vision: false });
  const r1 = await p.send([{ role: "user", content: "red" }], { system: "SYS", tools });
  assert.equal(r1.stop_reason, "tool_use");
  assert.deepEqual(r1.content, [
    { type: "tool_use", id: "c1", name: "set_script", input: { summary: "s", source: "vec3 shade(){return vec3(1.0);}" } },
  ]);
  assert.equal(seen[0]!.url, "/v1/chat/completions", "trailing slash on the base URL is tolerated");
  assert.equal(seen[0]!.auth, undefined, "no key → no Authorization header (local servers)");
  assert.equal((seen[0]!.body!["tools"] as unknown[]).length, 1);

  const r2 = await p.send(
    [
      { role: "user", content: "red" },
      { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "Compiled OK" }] }] },
    ],
    { system: "SYS", tools },
  );
  assert.deepEqual(r2, { content: [{ type: "text", text: "Compiled. Enjoy." }], stop_reason: "end_turn" });
  const sent = seen[1]!.body!["messages"] as { role: string; tool_call_id?: string }[];
  assert.deepEqual(sent.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(sent[3]!.tool_call_id, "c1");
});

test("a key is sent as a bearer token; models list; server errors surface", async () => {
  seen.length = 0;
  const cfg = { baseUrl: base, key: "sk-local", model: "broken", vision: false };
  assert.deepEqual(await listOpenAiModels(cfg), ["llama3.1:8b", "qwen2.5:7b"]);
  assert.equal(seen[0]!.auth, "Bearer sk-local");
  await assert.rejects(makeOpenAiProvider(cfg).send([{ role: "user", content: "x" }], { system: "", tools: [] }), /500/);
});
