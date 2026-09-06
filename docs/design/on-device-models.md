# Design: On-device / local models for the AI features (FUG-87)

Status: **proposed**. Companion to
[`effects-compiler.md`](effects-compiler.md) §"AI generation", which owns the
system prompt, the tool-use loop (`set_script` / `capture_preview` / MIDI /
perf), and the static-site, no-proxy constraint. This doc does not redesign any
of that — it generalizes *where the model runs*.

## Goal

Today the editor's AI features — NL→effect generation and MIDI remapping — talk
to one backend: Anthropic's cloud Messages API (BYO key, direct browser CORS).
FUG-87 adds the ability to **download and run models on your own device**, à la
[pocketpal-ai](https://github.com/a-ghorbani/pocketpal-ai): grab a model from
HuggingFace (or another hub) and drive the exact same features with no cloud
account and no data leaving the device.

The deployed webapp is a static site with no server (`effects-compiler.md` §4).
Every option here honors that: inference happens either in the browser or on a
server the *user* runs; the webapp only ever makes client-side `fetch`/GPU calls.

## Three categories (the top-level choice)

The user picks one of three categories (`AiConfig.kind`):

- **Cloud** — a vendor sub-selection (`CloudVendor`): Anthropic, OpenAI, Gemini,
  Grok, OpenRouter, or Custom, each with its own key + model. Anthropic uses its
  native Messages API; every other vendor reuses the OpenAI-compatible client
  pointed at that vendor's fixed endpoint (user-set for Custom). This is `kind:
  "cloud"`.
- **Local server (OpenAI-compatible)** — `kind: "local"`.
- **In-browser (WebGPU)** — `kind: "webllm"`.

The two on-device paths below are the point of the ticket; the cloud category is
the always-available default (and now spans more than Anthropic).

## Two on-device paths (and the cloud default)

"On-device" means different things on different hardware:

1. **Local OpenAI-compatible server** — Ollama, LM Studio, llama.cpp's
   `server`, vLLM, etc. The user installs one of these, pulls a GGUF from
   HuggingFace, and points the app at its base URL (e.g. Ollama's
   `http://localhost:11434/v1`). This is the most capable path (bigger models,
   CPU/GPU, mature tool-calling) and covers "and others" in the ticket. The app
   can also *pull* a model into Ollama with a progress bar — the
   download-from-HuggingFace experience — via Ollama's native `/api/pull`.

2. **In-browser WebGPU** — [web-llm](https://github.com/mlc-ai/web-llm) (MLC).
   Weights are fetched from HuggingFace on first use and cached in the browser;
   inference runs on the GPU with nothing installed and nothing leaving the
   device. This is the truest pocketpal analog. It is best-effort: it needs
   WebGPU and a first-run download (hundreds of MB to a few GB).

   **Tool-calling is per-model.** web-llm only implements function calling for a
   fixed, *enumerated* allow-list (specific Hermes-2-Pro + Hermes-3-8B builds); it
   *throws* for any other model when `tools` is present — even Hermes-3-Llama-3.2-3B
   is unsupported, so a name heuristic is wrong. `webllm.modelSupportsTools(id)` is
   therefore the exact set, and it gates the provider's `tools` capability — a
   non-tool model is never sent tools (no crash) and the loop degrades to plain
   chat. Additionally, web-llm's Hermes function-calling path injects its own
   system prompt and *rejects a custom one*, so when sending tools the provider
   omits the system role and folds our system prompt into the first user turn.
   Because a chat-only model can't author effects or map MIDI, the model browser
   defaults to a **"Tool-calling only" filter**, badges tool-capable models, and
   warns when a non-tool model is selected. To run an arbitrary HuggingFace GGUF
   instead, use the local-server (Ollama) path, which pulls any
   `hf.co/user/repo:quant` reference.

## Architecture: a thin provider interface

The tool-use loop already speaks a neutral, Anthropic-shaped representation:
messages are content blocks (`text` / `tool_use` / `tool_result`, with images),
tools are `{name, description, input_schema}`. That representation is expressive
enough to drive every backend, so we keep it as the internal wire format and
translate at each provider's edge.

```
                       ┌──────────────────────────────┐
   editor chatTurn ──▶ │ activeProvider().send(msgs,   │
   (unchanged loop)    │        {system, tools})       │
                       └──────────────┬───────────────┘
                                      │  AiProvider
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                              ▼
   anthropic.ts                 openaiCompat.ts                  webllm.ts
  (passthrough +            (neutral ⇄ OpenAI wire;          (web-llm engine,
   cache prefix)            /chat/completions; model          OpenAI-shaped API,
                            list; Ollama pull)                lazy CDN import)
```

- **`provider.ts`** — the neutral types (`ChatMessage`, `ContentBlock`,
  `ToolDef`), `ProviderCapabilities` (`tools`, `vision`), the `AiProvider`
  interface (`send(messages, {system, tools, signal})`), and the localStorage
  **config** (which provider is active + each provider's settings). It migrates
  the legacy single-key storage (`ledmapper.anthropicKey`) so existing users are
  unaffected, and mirrors the Anthropic key back to it so a downgrade still
  works.

- **`providers/anthropic.ts`** — the cloud default, extracted verbatim (BYO key,
  `anthropic-dangerous-direct-browser-access`, cacheable system prefix,
  `thinking: adaptive`). Capabilities: tools + vision.

- **`providers/openaiCompat.ts`** — translates the neutral blocks to/from the
  OpenAI `/chat/completions` shape (assistant `tool_calls`, `tool` messages,
  vision via `image_url`), calls the server, and exposes `listOpenAiModels`
  (`/v1/models`) and `pullOllamaModel` (streamed `/api/pull` progress). The
  translators are pure and unit-tested (`web/tests/openaiProvider.test.ts`).
  Capabilities: tools always; vision is a per-model config toggle.

- **`providers/webllm.ts`** — drives web-llm's OpenAI-shaped
  `chat.completions.create`, reusing the same translators. web-llm is imported
  **lazily from a CDN ESM URL**, so it adds no npm/lockfile dependency and no
  weight to the base bundle — it's fetched only when the user selects this
  provider. Inference runs in a **Web Worker** (`CreateWebWorkerMLCEngine` over a
  blob module worker) so GPU compile/inference don't stutter the main-thread UI
  (falls back to the main-thread engine if unavailable). Capabilities: tools
  (per-model, see below); vision off (prebuilt models are text-only).

`generate.ts` keeps its public surface (`chatTurn`, `editorContext`,
`getApiKey`/`setApiKey` back-compat) and just routes through `activeProvider()`.

### Graceful degradation

The loop advertises only tools the active provider can fulfill: the vision
`capture_preview` tool is withheld when `capabilities.vision` is false (so no
image blocks are ever produced for a text-only model), and all tools are
withheld if a provider ever reports no tool-calling. Everything else — the
compile-result feedback, MIDI mapping, perf estimation — is provider-agnostic.

## UX

A single **AI settings** screen (`#/settings/ai`) replaces the old Anthropic-key
sheet as the setup surface (the editor ⋯ menu and the effects-browser hint now
route here):

- pick the provider (Anthropic / Local server / In-browser);
- Anthropic: key + model;
- Local server: base URL, optional key, model (free-text + a "List" button that
  reads `/v1/models`), a vision toggle, and an Ollama "Download a model" field
  with a progress bar;
- Cloud: a vendor picker + that vendor's API key + model (a "List" button reads
  `/v1/models` for the OpenAI-compatible vendors; Anthropic has no such
  endpoint). Text inputs persist without rebuilding the panel so typing keeps
  focus.
- In-browser: a WebGPU support check and a **model manager** — cards from
  web-llm's prebuilt (HuggingFace-hosted MLC) list with a HuggingFace link and
  VRAM / low-resource / "Tools" badges, a search box, and a "Tool-calling only"
  filter (default on). An **"Add"** field pins a model by id (validated against
  the catalog). Each chip has a **download** control (↓ → inline progress bar →
  green ✓, with a red trash to delete, confirm-gated) and a **load** control
  (`</>`: gray → shimmer while (un)loading → yellow when loaded); a warning
  shows when the active model can't tool-call. Download caches weights without
  keeping the model on the GPU; load/unload toggles the active engine. A
  **"Context window (tokens)"** field sets web-llm's `context_window_size` — its
  per-model default (often 4096) is too small for our grounded prompts
  (`ContextWindowSizeExceededError`); default 8192, applied on the next load.

The effects-browser first-run hint and the editor gating now check
`isAiConfigured()` (any provider ready) rather than "has an Anthropic key," so a
user on a local/in-browser model isn't nagged and is sent to `#/settings/ai`
when nothing is configured yet.

## Why not bundle web-llm?

Bundling web-llm would add a large dependency and megabytes to every load, most
of it unused (the cloud/local-server users never touch it). A lazy CDN import
keeps the base bundle unchanged and only pays the cost for users who opt into
in-browser inference. The trade-off is a runtime fetch of the library on first
in-browser use; the model weights are a far larger first-run download anyway,
and both are then cached. A future change could vendor web-llm behind the same
`AiProvider` seam if a fully offline first-run is desired.

## Testing

- `web/tests/openaiProvider.test.ts` — the neutral ⇄ OpenAI translation
  (system prefix, assistant `tool_calls`, `tool_result` → `tool` messages, image
  folding + ordering, tool-call parsing, `finish_reason` mapping, URL helpers).
- `web/tests/aiProvider.test.ts` — config defaults, tolerant merge of stored /
  partial config, and the `isAiConfigured` gate per provider.
- `web/tests/webllmProvider.test.ts` — the per-model tool-calling gate
  (`modelSupportsTools`) is an exact allow-list (incl. the reported
  Hermes-3-Llama-3.2-3B rejection), so we never send `tools` to a model web-llm
  can't tool-call for.
- `web/tests/chatStore.test.ts` — chat persistence sanitization: preview images
  are stripped before saving, and history is trimmed only at safe round
  boundaries (never begins on a dangling tool result).

## Chat persistence

The editor's AI chat is persisted per effect (`store/chatStore.ts`,
localStorage): both the API `history` (so the model continues where it left off)
and the visible `transcript` (so the log redraws). It's restored on mount and
saved after every turn; only the chat pane's **"New chat"** button clears it.
Captured preview images are stripped before saving, and history is trimmed at
round boundaries to bound storage without corrupting the conversation. "New chat"
lives in the editor's ⋯ overflow menu (not a chat-pane header).

Note: the OpenAI translation emits `content: ""` (never `null`) for
tool-calls-only assistant turns — web-llm rejects `null` ("assistant's message
should have string content"), and OpenAI accepts `""` alongside `tool_calls`.

The network paths (server `fetch`, Ollama pull, the CDN import + GPU init) are
browser/runtime-only and are exercised manually against a real Ollama / WebGPU
browser; the translation and config logic that gates correctness is unit-tested.
