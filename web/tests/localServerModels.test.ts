/**
 * Local-server model workflow (FUG-87, docs/design/on-device-models.md "Two
 * on-device paths" §1): run the editor's AI on a model served by a local
 * OpenAI-compatible runtime (Ollama / LM Studio / llama.cpp / vLLM) — no cloud
 * account, nothing leaving the user's machine. This suite pins what the design
 * doc promises for that path, through the REAL tool-use loop and provider:
 * the same set_script loop the cloud model runs, aimed at the configured base
 * URL; the vision toggle gating the capture_preview tool (a text-only model is
 * never sent images); listing the server's models (`/v1/models`); and pulling a
 * model into Ollama with streamed progress (native `/api/pull` at the server
 * root). The server is a fake `fetch`.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { chatTurn, type ChatHooks } from "../src/effects/ai/generate";
import { getAiConfig, updateAiConfig, type OpenAiConfig } from "../src/effects/ai/provider";
import { listOpenAiModels, pullOllamaModel, type PullProgress } from "../src/effects/ai/providers/openaiCompat";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const realFetch = globalThis.fetch;
let sent: Sent[] = [];
let replies: (() => Response)[] = [];
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  sent = [];
  replies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request to ${String(input)}`);
    return next();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BASE = "http://localhost:11434/v1";
const SOURCE = "void update() {}\nvec3 shade(Led l) { return vec3(1.0, 0.0, 0.0); }";

function useLocal(local: Partial<OpenAiConfig>): void {
  updateAiConfig({ kind: "local", local: { ...getAiConfig().local, baseUrl: BASE, key: "", model: "qwen2.5-coder:7b", vision: false, ...local } });
}

function hooks(extra: Partial<ChatHooks> = {}): ChatHooks {
  return {
    onSetScript: async () => "Compile result: ok",
    onCapturePreview: async () => "data:image/png;base64,AAAA",
    ...extra,
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  json({
    choices: [
      {
        message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: "tool_calls",
      },
    ],
  });
const say = (content: string) => json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });

test("a model on a local OpenAI-compatible server drives the editor's tool loop with no cloud account [rr:PR-8]", async () => {
  useLocal({});
  replies = [toolCall("call_1", "set_script", { summary: "make it red", source: SOURCE }), say("Done — it's red.")];

  const applied: string[] = [];
  const final = await chatTurn(
    [{ role: "user", content: "make it red" }],
    hooks({
      onSetScript: async (source) => {
        applied.push(source);
        return "Compile result: ok";
      },
    }),
  );

  assert.equal(final, "Done — it's red.");
  assert.deepEqual(applied, [SOURCE], "the local model's script reached the editor");
  // Every request went to the configured local server's chat endpoint, keyless.
  assert.deepEqual(
    sent.map((s) => [s.method, s.url]),
    [
      ["POST", `${BASE}/chat/completions`],
      ["POST", `${BASE}/chat/completions`],
    ],
  );
  for (const s of sent) assert.equal(s.headers["authorization"], undefined);
  const first = sent[0]!.body!;
  assert.equal(first["model"], "qwen2.5-coder:7b");
  assert.equal((first["messages"] as { role: string }[])[0]!.role, "system");
  assert.deepEqual(
    (first["tools"] as { function: { name: string } }[]).map((t) => t.function.name),
    ["set_script"],
  );
  // The compile result was fed back as the tool's answer in round 2.
  assert.deepEqual((sent[1]!.body!["messages"] as unknown[]).slice(-2), [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "set_script", arguments: JSON.stringify({ summary: "make it red", source: SOURCE }) } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "Compile result: ok" },
  ]);
});

test("only a vision-enabled local model may look at the live preview; a text-only one is never sent images [rr:PR-8]", async () => {
  // Text-only (the default): capture_preview is not even offered.
  useLocal({ vision: false });
  replies = [say("ok")];
  await chatTurn([{ role: "user", content: "how does it look?" }], hooks());
  const offered = (sent[0]!.body!["tools"] as { function: { name: string } }[]).map((t) => t.function.name);
  assert.ok(!offered.includes("capture_preview"), `offered ${offered.join(",")}`);

  // Vision on: the model may call capture_preview and receives the PNG.
  sent = [];
  useLocal({ vision: true });
  replies = [toolCall("call_9", "capture_preview", {}), say("Looks good.")];
  let captured = 0;
  assert.equal(
    await chatTurn(
      [{ role: "user", content: "how does it look?" }],
      hooks({
        onCapturePreview: async () => {
          captured++;
          return "data:image/png;base64,UE5H";
        },
      }),
    ),
    "Looks good.",
  );
  assert.equal(captured, 1);
  assert.ok((sent[0]!.body!["tools"] as { function: { name: string } }[]).some((t) => t.function.name === "capture_preview"));
  assert.deepEqual((sent[1]!.body!["messages"] as unknown[]).slice(-2), [
    { role: "tool", tool_call_id: "call_9", content: "Live preview rendered:" },
    {
      role: "user",
      content: [
        { type: "text", text: "Rendered preview:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,UE5H" } },
      ],
    },
  ]);
});

test("the app lists a local server's models and pulls one into Ollama with streamed progress [rr:PR-8]", async () => {
  const cfg: OpenAiConfig = { baseUrl: `${BASE}/`, key: "", model: "", vision: false };
  replies = [json({ data: [{ id: "qwen2.5:7b" }, { id: "llama3.1:8b" }, { object: "junk" }] })];
  assert.deepEqual(await listOpenAiModels(cfg), ["llama3.1:8b", "qwen2.5:7b"]);
  assert.deepEqual(sent[0]!.url, `${BASE}/models`);

  // Ollama streams NDJSON progress; chunk it mid-line to exercise the buffering.
  const ndjson =
    '{"status":"pulling manifest"}\n' +
    '{"status":"pulling 6a0746a1ec1a","digest":"sha256:6a07","total":200,"completed":50}\n' +
    '{"status":"pulling 6a0746a1ec1a","digest":"sha256:6a07","total":200,"completed":200}\n' +
    '{"status":"success"}\n';
  const bytes = new TextEncoder().encode(ndjson);
  replies = [
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < bytes.length; i += 23) c.enqueue(bytes.slice(i, i + 23));
            c.close();
          },
        }),
        { status: 200 },
      ),
  ];
  const progress: PullProgress[] = [];
  const name = "hf.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M";
  await pullOllamaModel(cfg, name, (p) => progress.push(p));
  // Ollama's native API lives at the server root, not under the OpenAI /v1 prefix.
  assert.equal(sent[1]!.url, "http://localhost:11434/api/pull");
  assert.deepEqual(sent[1]!.body, { name, stream: true });
  assert.deepEqual(progress, [
    { status: "pulling manifest", completed: undefined, total: undefined },
    { status: "pulling 6a0746a1ec1a", completed: 50, total: 200 },
    { status: "pulling 6a0746a1ec1a", completed: 200, total: 200 },
    { status: "success", completed: undefined, total: undefined },
  ]);

  // A pull the server rejects surfaces Ollama's own error.
  replies = [() => new Response('{"error":"pull model manifest: file does not exist"}\n', { status: 200 })];
  await assert.rejects(pullOllamaModel(cfg, "nope:latest", () => undefined), /file does not exist/);
});
