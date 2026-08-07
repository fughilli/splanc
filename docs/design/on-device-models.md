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

## Two on-device paths (and one cloud default)

We keep Anthropic as the default and add two local paths, because "on-device"
means different things on different hardware:

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
   WebGPU and a first-run download (hundreds of MB to a few GB), and small
   models do tool-calling less reliably than the cloud model.

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
  provider. Capabilities: tools; vision off (prebuilt models are text-only).

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
- In-browser: a WebGPU support check, a model picker (from web-llm's prebuilt
  list), and a "Download / load model" button with init progress.

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

The network paths (server `fetch`, Ollama pull, the CDN import + GPU init) are
browser/runtime-only and are exercised manually against a real Ollama / WebGPU
browser; the translation and config logic that gates correctness is unit-tested.
