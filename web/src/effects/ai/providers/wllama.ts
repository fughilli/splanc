/**
 * In-browser CPU provider (wllama = llama.cpp compiled to WASM).
 *
 * This is the PHONE-friendly on-device path. Unlike the WebGPU provider
 * (providers/webllm.ts), inference runs on the CPU in wllama's Web Worker(s) and
 * NEVER touches the display GPU — so it can't starve/hang a mobile GPU driver the
 * way a big WebGPU compute burst does (the "black blocks + freeze" failure on
 * phones). The trade-off is speed: it's a small model (1–3B GGUF) at a few
 * tokens/sec, but the device stays fully responsive.
 *
 * wllama is loaded LAZILY from a CDN (pinned) so it adds no npm/lockfile
 * dependency and nothing to the base bundle — fetched only when this provider is
 * actually used, exactly like the web-llm provider. Its wasm binaries come from
 * the same CDN via wllama's own `wasm-from-cdn` asset map.
 *
 * Threads: wllama defaults to floor(hardwareConcurrency / 2), already leaving CPU
 * headroom for the UI (the same instinct as pocketpal-ai's 80%-of-cores cap). We
 * only force single-thread when the page isn't cross-origin-isolated (no
 * SharedArrayBuffer → multi-thread wasm is unavailable anyway).
 *
 * Tools: wllama has no native function-calling, so tool use is a TEXT PROTOCOL —
 * we describe the tools in the system prompt, ask the model to emit
 * `<tool_call>{json}</tool_call>`, and parse those back into neutral tool_use
 * blocks. Reliable only on models trained for that convention, so tools are
 * advertised (capabilities.tools) ONLY for an allow-list; other models degrade to
 * plain chat. The translation + parsing here is pure and unit-tested
 * (web/tests/wllamaProvider.test.ts); the wllama runtime call is browser/CPU-only
 * and validated on-device.
 */

import type {
  AiProvider,
  ChatMessage,
  ContentBlock,
  SendOptions,
  SendResult,
  ToolDef,
  WllamaConfig,
} from "../provider";

/** Pinned wllama release loaded from the CDN (see module docstring). A `string`
 * type keeps tsc from trying to resolve the CDN URL as a local module. */
const WLLAMA_VERSION = "3.7.0";
const CDN_BASE: string = `https://esm.run/@wllama/wllama@${WLLAMA_VERSION}`;

// -- minimal shapes of the parts of wllama we touch --------------------------

interface WllamaInstance {
  loadModelFromUrl(url: string, params?: Record<string, unknown>): Promise<void>;
  createChatCompletion(opts: Record<string, unknown>): Promise<ChatCompletionResponse>;
  isModelLoaded(): boolean;
  exit(): Promise<void>;
}
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}
interface WllamaModule {
  Wllama: new (assets: unknown, config?: Record<string, unknown>) => WllamaInstance;
}

// =============================================================================
// Tool text-protocol (pure — unit-tested). wllama can't do native tool calls, so
// we teach a small instruct model the `<tool_call>` / `<tool_response>`
// convention (Hermes / Qwen-2.5 style) in the prompt and parse it back out.
// =============================================================================

/** Models whose chat template + training reliably emit the `<tool_call>` JSON
 * convention. Matched loosely on the GGUF filename/URL (models are arbitrary HF
 * URLs here, unlike web-llm's fixed catalog). Everything else → plain chat. */
export function wllamaModelSupportsTools(modelUrlOrId: string): boolean {
  const s = modelUrlOrId.toLowerCase();
  const isInstruct = s.includes("instruct") || s.includes("hermes");
  return isInstruct && (s.includes("qwen2.5") || s.includes("qwen3") || s.includes("hermes"));
}

/** The system-prompt addendum describing the advertised tools + the wire
 * convention the model must follow to call them. */
export function formatToolInstructions(tools: readonly ToolDef[]): string {
  const specs = tools
    .map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.input_schema)}`)
    .join("\n");
  return (
    `\n\n# Tools\n` +
    `You can call tools. To call one, emit a line of exactly this form (and nothing else on that line):\n` +
    `<tool_call>{"name": "<tool>", "arguments": { ... }}</tool_call>\n` +
    `You may call multiple tools by emitting multiple such lines. After a tool runs you'll get a ` +
    `<tool_response> with its result; continue until the task is done, then reply normally.\n\n` +
    `Available tools:\n${specs}`
  );
}

/** Serialize one neutral message's content to the flat string wllama's chat
 * template consumes. Assistant tool_use → `<tool_call>` lines; user tool_result
 * → `<tool_response>` blocks; images are dropped (this path has no vision). */
export function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      parts.push(`<tool_call>${JSON.stringify({ name: b.name, arguments: b.input })}</tool_call>`);
    } else if (b.type === "tool_result") {
      const text = b.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      parts.push(`<tool_response>${text || "(no text output)"}</tool_response>`);
    }
  }
  return parts.join("\n");
}

/** Build the wllama `messages` array from the neutral history + system prompt. */
export function messagesToWllama(
  system: string,
  messages: ChatMessage[],
): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [{ role: "system", content: system }];
  for (const m of messages) out.push({ role: m.role, content: contentToText(m.content) });
  return out;
}

/** Extract `<tool_call>{...}</tool_call>` blocks from generated text, returning
 * the parsed calls plus the prose with those blocks removed. Tolerant of
 * whitespace and of malformed JSON (a call that won't parse is skipped). */
export function parseToolCalls(text: string): {
  calls: { name: string; input: Record<string, unknown> }[];
  text: string;
} {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]!) as { name?: unknown; arguments?: unknown };
      if (typeof obj.name === "string") {
        const input =
          obj.arguments && typeof obj.arguments === "object"
            ? (obj.arguments as Record<string, unknown>)
            : {};
        calls.push({ name: obj.name, input });
      }
    } catch {
      // malformed tool call — skip it (the prose still shows through)
    }
  }
  const prose = text.replace(re, "").trim();
  return { calls, text: prose };
}

// =============================================================================
// Engine lifecycle (module-level, reused across turns).
// =============================================================================

let modulePromise: Promise<WllamaModule> | null = null;
let engine: WllamaInstance | null = null;
let engineModel = "";
let engineCtx = 0;

async function loadModule(): Promise<WllamaModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = (await import(/* @vite-ignore */ CDN_BASE)) as unknown as WllamaModule;
      return mod;
    })();
  }
  return modulePromise;
}

/** Cross-origin-isolated pages get SharedArrayBuffer → wllama can multi-thread;
 * otherwise force single-thread (multi-thread wasm can't load anyway). */
function threadCount(configured: number): number | undefined {
  const isolated = typeof globalThis !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1; // no SAB → single-thread
  if (configured > 0) return configured;
  return undefined; // let wllama pick floor(hardwareConcurrency / 2)
}

/** True when the browser can run wllama at all (WebAssembly present). */
export function isWllamaSupported(): boolean {
  return typeof WebAssembly !== "undefined";
}

/** Load `model` (a GGUF URL) into the engine if not already the active one. */
export async function loadWllamaModel(
  model: string,
  nCtx: number,
  nThreads: number,
): Promise<void> {
  if (engine && engineModel === model && engineCtx === nCtx && engine.isModelLoaded()) return;
  await unloadWllamaModel();
  const { Wllama } = await loadModule();
  // wllama's CDN asset map lives in a sibling ESM file; import lazily so it's not
  // resolved until we actually construct an engine.
  const assets = ((await import(/* @vite-ignore */ `${CDN_BASE}/esm/wasm-from-cdn.js`)) as { default: unknown }).default;
  const inst = new Wllama(assets);
  const threads = threadCount(nThreads);
  await inst.loadModelFromUrl(model, {
    n_ctx: nCtx,
    ...(threads !== undefined ? { n_threads: threads } : {}),
  });
  engine = inst;
  engineModel = model;
  engineCtx = nCtx;
}

/** Free the loaded model + worker(s). */
export async function unloadWllamaModel(): Promise<void> {
  if (engine) {
    try {
      await engine.exit();
    } catch {
      // best-effort
    }
  }
  engine = null;
  engineModel = "";
  engineCtx = 0;
}

/** Build an in-browser CPU (wllama) provider from its config. */
export function makeWllamaProvider(cfg: WllamaConfig): AiProvider {
  return {
    id: "wllama",
    // Tools only for models that reliably emit the text convention; no vision.
    capabilities: { tools: wllamaModelSupportsTools(cfg.model), vision: false },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.model.trim()) {
        throw new Error("no in-browser CPU model selected (pick one in AI settings)");
      }
      if (!isWllamaSupported()) throw new Error("WebAssembly is not available in this browser");
      const useTools = opts.tools.length > 0 && wllamaModelSupportsTools(cfg.model);
      const system = useTools ? opts.system + formatToolInstructions(opts.tools) : opts.system;
      await loadWllamaModel(cfg.model, cfg.contextWindowSize, cfg.nThreads);
      if (!engine) throw new Error("in-browser CPU model failed to load");

      let full = "";
      const onData = (chunk: unknown): void => {
        // wllama's ChatCompletionChunk is OpenAI-shaped; be tolerant of the exact
        // field so a version nudge doesn't silently drop the stream.
        const c = chunk as {
          choices?: { delta?: { content?: string } }[];
          currentText?: string;
        };
        const delta = c.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          full += delta;
          opts.stream?.onText?.(delta);
        } else if (typeof c.currentText === "string" && c.currentText.length > full.length) {
          const d = c.currentText.slice(full.length);
          full = c.currentText;
          opts.stream?.onText?.(d);
        }
      };

      const resp = await engine.createChatCompletion({
        messages: messagesToWllama(system, messages),
        n_predict: opts.maxTokens ?? 2048,
        stream: true,
        onData,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      });
      // stream:true + onData resolves to void; if a build returned the response
      // object instead, fall back to its content so we never lose the reply.
      if (!full && resp?.choices?.[0]?.message?.content) full = resp.choices[0].message.content;

      if (!useTools) {
        return { content: [{ type: "text", text: full }], stop_reason: "end_turn" };
      }
      const { calls, text } = parseToolCalls(full);
      const content: ContentBlock[] = [];
      if (text) content.push({ type: "text", text });
      for (const [i, call] of calls.entries()) {
        content.push({ type: "tool_use", id: `wllama_${i}`, name: call.name, input: call.input });
      }
      return { content, stop_reason: calls.length > 0 ? "tool_use" : "end_turn" };
    },
    async warmUp(system: string): Promise<void> {
      try {
        if (!cfg.model.trim() || !isWllamaSupported()) return;
        await loadWllamaModel(cfg.model, cfg.contextWindowSize, cfg.nThreads);
        if (!engine) return;
        // Prime the prefill with the system prompt (1 token). CPU-only, so this is
        // safe to run at boot even on a phone — it never touches the GPU.
        await engine.createChatCompletion({
          messages: [{ role: "user", content: system }],
          n_predict: 1,
          stream: false,
        });
      } catch {
        // warm-up is a pure optimization — never throw.
      }
    },
  };
}
