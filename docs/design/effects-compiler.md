# Design: Effects compiler (editor + wasm compile + AI generation)

Status: **proposed**. Companion to
[`effects-runtime.md`](effects-runtime.md), which owns the language, the VM/ISA,
the `.fxb` bytecode format, and the uniform manifest. **This doc does not
redesign any of that** — it consumes those artifacts. Where this doc says
"compiler," "manifest," or "preview VM," the authoritative definitions live in
`effects-runtime.md`. This doc covers the three surfaces that sit *on top of* the
runtime:

1. the **editor** in the phone webapp (highlighting, diagnostics, autocomplete,
   compile-on-idle → live uniform panel + `MapView` preview hot-reload),
2. the **wasm compile pipeline** (`fx_compiler` Rust crate → `fx_compiler_web`
   bindings; its API surface and how it plugs into the editor and the preview),
3. **AI generation with Claude** (system-prompt design, request flow, the
   static-site key-handling problem, and the grounding/auto-repair loop).

Scope note: the deployed webapp is a **static Cloudflare Pages site** (see
`web/BUILD.bazel` `:deploy_cloudflare` — bundle + wasm only, no server, no
secrets). Every design choice here respects that: compilation and preview run
entirely client-side in wasm; the *only* thing that needs a server is the
Anthropic API key, and §4 is dedicated to that constraint.

---

## Goal

Give a user — on a phone, offline from any device — a fast loop to write, or
*ask Claude to write*, an effect and see it running on their own captured map
within a second, before anything is pushed to hardware. Concretely:

- Type in a code editor with syntax highlighting for the GLSL-ish language, get
  **inline red squiggles** with the compiler's real error messages, and
  autocomplete for built-ins, contexts (`led.*`, `imu.*`), and the user's own
  declared uniforms/state/functions.
- On every idle pause, the source is compiled **in-browser** to `.fxb`; on
  success the uniform panel and the `MapView` preview **hot-reload** without
  losing animation state where possible.
- Describe an effect in English; Claude returns a script; it is compiled and
  previewed automatically; if it doesn't compile, the diagnostics are fed back
  to Claude to repair it — the user watches it converge.

Non-goals: the on-device execution path, the protocol arms, and performance
counters (owned by `effects-runtime.md` and the perf-monitoring doc). This doc
stops at "a validated `.fxb` + manifest exists in the workspace and previews
correctly"; handoff to `submit_effect` is out of scope here.

---

## Editor UX

### Editor library: CodeMirror 6

`effects-runtime.md` §Webapp-integration says "start with a `<textarea>` +
compile-on-idle; upgrade to CodeMirror later." This doc specifies that upgrade
and treats CodeMirror 6 as the target. Rationale:

- **Mobile-first.** CM6 has first-class touch/virtual-keyboard support, which
  Monaco does not — this is a phone app.
- **Small + tree-shakeable.** CM6 is modular (`@codemirror/state`, `/view`,
  `/language`, `/lint`, `/autocomplete`), so the editor adds tens of KB, not the
  megabytes Monaco pulls in. It bundles cleanly through the existing Vite
  `:dist` build with no worker-file gymnastics.
- **The three extension points we need are the CM6 primitives:** a
  `StreamLanguage`/Lezer grammar for highlighting, the **`linter`** facility for
  diagnostics, and **`autocompletion`** with a custom `CompletionSource`. All
  three consume plain data we already produce from the compiler.

Add it to the pnpm workspace (`web/package.json`) and to `TYPE_DEPS`/`SRCS` in
`web/BUILD.bazel` like any other TS dep; no new Bazel rule needed (it is not
wasm). New code lives under `web/src/effects/editor/`.

### Syntax highlighting

Define the language once as a lightweight grammar over the token set fixed by
`effects-runtime.md`:

- keywords: `uniform state void vec2 vec3 vec4 float int bool if else for return`
- context idents: `time dt frame led imu` (+ member access `led.pos`, `led.idx`,
  `led.seg`, `led.s`, `led.branch`, `imu.accel`, `imu.gyro`)
- built-in fns: `sin cos tan abs floor ceil fract mod min max clamp mix step
  smoothstep length distance dot cross normalize pow exp log sqrt sign hash11
  hash31 hsv2rgb palette_lookup`
- literals, comments (`//`, `/* */`), operators, the uniform-range syntax
  (`: 0.0 .. 5.0 = 1.0`, `: color`, `: {"a","b"}`).

Start with a `StreamLanguage` tokenizer (a few dozen lines, trivial to keep in
sync with the token list) and only invest in a full Lezer grammar if we want
structural features (bracket matching across `for`, folding). The keyword/
built-in lists are the **same arrays** used by autocomplete and by the AI system
prompt — define them in **one shared module** (`editor/lang-spec.ts`) so the
highlighter, the completion source, the AI prompt, and any docs never drift.

### Inline diagnostics from the compiler

The compiler is the single source of truth for correctness — the editor does
**no** semantic checking of its own. Wire CM6's `linter` to the wasm compiler:

- A `linter` source is an async function `(view) => Diagnostic[]`. It runs the
  same `compile(src)` call used for preview (debounced; see below) and maps the
  returned `diagnostics[]` (see §Compile pipeline for the shape) onto CM6
  `Diagnostic` objects: `{from, to, severity, message, source}`.
- The compiler returns **byte or line/col spans**; CM6 wants absolute document
  offsets. `fx_compiler` therefore emits `{start:{line,col}, end:{line,col}}`
  per diagnostic (0-based line, UTF-16 col to match JS string indexing — see
  §Open questions on encoding), and the editor converts via
  `view.state.doc.line(n).from + col`.
- Severities: `error` (red squiggle, blocks preview reload), `warning` (yellow;
  e.g. "uniform declared but never read", "for-loop trip count near the
  instruction budget"), `info` (hints). Only `error`-free compiles update the
  preview.
- A compact **status line** under the editor mirrors the first error
  (`line 12: unknown built-in 'noise' — did you mean 'hash11'?`) and a
  green "compiled · 214 ops · 6 uniforms" on success, so the state is legible on
  a small screen without hovering a squiggle.

Because the same `compile()` result drives both the linter and the preview, a
squiggle and a stale preview can never disagree — they came from one call
(§Compile pipeline caches it).

### Autocomplete

A CM6 `CompletionSource` returns completions from two sources, merged:

1. **Static** — built-ins, types, keywords, context members. Each carries a
   `type` (`function`/`keyword`/`variable`), a one-line `detail` (signature,
   e.g. `clamp(x, lo, hi)`), and an `info` doc string. This list is generated
   from `lang-spec.ts` (same array as the highlighter), so adding a built-in in
   the runtime is a one-line change that lights up highlighting + autocomplete +
   the AI prompt together.
2. **Dynamic (document symbols)** — the user's declared `uniform`/`state` names
   and `float f(...)` functions. Cheapest correct source: the compiler already
   parses these. `fx_compiler` returns a `symbols[]` list (name, kind, type,
   signature) on every compile — even a *failed* one, as long as the
   declarations parsed — and the completion source reads it. This means
   autocomplete for `speed`/`width`/`phase` works the instant they're declared,
   with no separate JS parser to maintain.

Trigger on identifier characters and after `.` (for `led.`/`imu.` members). No
network, no latency — all local.

### Compile-on-idle → live uniform panel + preview hot-reload

The editor drives a small state machine on a **debounced idle** (≈250–400 ms
after the last keystroke; tuned so a fast typist isn't recompiling mid-word):

```
edit → (idle) → compile(src) in wasm
   ├─ diagnostics → linter repaints squiggles + status line   [always]
   └─ if no errors:
        ├─ manifest → reconcile uniform panel (see below)
        └─ bytecode → preview VM hot-swap (see below)
```

**Uniform panel reconciliation.** The panel is generated from the manifest
(`ui_kind` ∈ slider/color/toggle/dropdown — rendered by the *same* generic
component `effects-runtime.md` calls for, replacing today's hard-coded knobs in
`web/src/effects/main.ts`). On recompile we **diff** the new manifest against the
old: a uniform with the same name+type+range keeps its current live value; a
changed range re-clamps; new uniforms appear at their default; removed ones drop
out. So tweaking `shade()` while a slider sits at 0.7 doesn't reset that slider.

**Preview hot-reload.** The preview runs the runtime's wasm VM (`fx_vm_web`, per
`effects-runtime.md`) over the current map's LED positions each rAF tick,
writing `MapView.setLedColors()` (the existing sink used by `sim.ts` today).
On a clean recompile we hand the VM the new bytecode + manifest and, per the
runtime's guidance, **preserve `state` where the state layout is unchanged**
(same `state` declarations → keep the integrators/phases running; changed layout
→ reset). Uniform values flow live into the VM every frame from the panel, so
dragging a slider is instant and needs no recompile — identical to how
`set_uniforms` will behave on-device (one manifest, two consumers).

This is the whole point of sharing the VM: the offline preview and the on-device
render cannot drift, and the same manifest drives sliders in both places.

---

## Compile pipeline (wasm API)

### Crate → wasm, exactly like `pulse`/`solver`

`effects-runtime.md` defines `//fx_compiler` (Rust: lexer/parser/typecheck/
codegen + manifest extraction). This doc pins its wasm packaging to the pattern
already proven twice in this repo (`firmware/pulse/BUILD.bazel`,
`solver/BUILD.bazel`):

- `rust_library(name = "fx_compiler")` — the pure compiler, host-testable.
- `rust_shared_library(name = "fx_compiler_wasm", srcs = ["bin/wasm_lib.rs"])` —
  a thin `#[wasm_bindgen]` cdylib over `:fx_compiler` + `@crates//:wasm-bindgen`.
- `rust_wasm_bindgen(name = "fx_compiler_wasm_pkg", target = "web", ...)` — JS
  glue + `.wasm` via the platform transition.
- `opt_files(...)` + `copy_to_directory(name = "fx_compiler_web", ...)` stripping
  the pkg prefix, so it deploys as a self-contained runfiles directory served at
  `/fx-compiler/` — mirroring how `pulse_web` is served at `/pulse/` and
  `solver_web` at `/solver/`.
- Add `//fx_compiler:fx_compiler_web` to the `data` of `web/:serve` **and**
  `web/:deploy_cloudflare` (next to `pulse_web`/`solver_web`) so it ships to
  Cloudflare Pages as a static asset. Same for `//fx_vm:fx_vm_web` (the preview
  VM, owned by the runtime doc) if not already listed.

### JS loading

Load lazily and cache the module promise, exactly like `loadPulseWasm()` in
`web/src/effects/sim.ts`:

```ts
// web/src/effects/compiler.ts  (sketch — mirrors sim.ts:loadPulseWasm)
let modP: Promise<FxCompilerModule> | null = null;
export function loadFxCompiler(base = "/fx-compiler"): Promise<FxCompilerModule> {
  if (!modP) modP = (async () => {
    const mod = await import(/* @vite-ignore */ `${base}/fx_compiler_wasm_pkg.js`);
    await mod.default(`${base}/fx_compiler_wasm_pkg_bg.wasm`);
    return mod;
  })();
  return modP;
}
```

**Worker or main thread?** The compiler runs on the **main thread**. Unlike the
VIO solver (which runs seconds-long solves in a worker — `web/src/solver/`), a
compile of a small shader is sub-millisecond-to-low-milliseconds; a debounced
main-thread call is simpler and avoids the postMessage/transfer plumbing. If
profiling ever shows the compile janking the rAF loop on a slow phone, moving it
behind a worker is a mechanical change (adopt the solver's `command()` pattern)
and does not affect the API below.

### API surface

One primary export. Input is source text; output is everything the editor and
preview need, in one call:

```ts
interface FxDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;                 // human-readable, matches the CLI/host tests
  start: { line: number; col: number };  // 0-based; col is UTF-16 units
  end:   { line: number; col: number };
  code?: string;                   // stable id, e.g. "E_UNKNOWN_BUILTIN"
}
interface FxSymbol {
  name: string;
  kind: "uniform" | "state" | "function" | "param" | "local";
  ty: string;                      // "float" | "vec3" | ...
  signature?: string;              // for functions: "float f(float x)"
}
interface FxCompileResult {
  ok: boolean;                     // true iff no error-severity diagnostics
  bytecode?: Uint8Array;           // the .fxb container; present iff ok
  manifest?: UniformManifest;      // shape defined by effects-runtime.md
  symbols: FxSymbol[];             // best-effort; populated even when !ok
  diagnostics: FxDiagnostic[];
  stats?: { ops: number; consts: number; codeBytes: number; maxStack: number };
}

// wasm-bindgen exports (from bin/wasm_lib.rs):
function compile(src: string): FxCompileResult;   // returns a JS object (serde-wasm-bindgen)
```

Notes:

- **`bytecode` is the exact `.fxb`** defined by `effects-runtime.md` (magic
  `FXB1`, manifest, consts, entry offsets, code). No JS-side reassembly — the
  editor treats it as an opaque `Uint8Array` to hand to the preview VM and,
  later, to `submit_effect`. This guarantees preview and device consume byte-
  identical artifacts.
- **`manifest`** is the runtime's uniform manifest — the doc owning it defines
  the fields (`name, type, ui_kind, min, max, step, default|options`). The
  compiler is the only thing that produces it; the editor and preview never
  synthesize one.
- The result is **cached** by the editor keyed on source text, so the linter and
  the preview trigger share one compile per idle tick (no double work).
- `stats` feeds the status line ("214 ops") and later the offline perf estimate
  (perf-monitoring doc). Optional here.
- Errors in the compiler are returned as diagnostics, **never thrown** — a
  malformed program is normal input. wasm-bindgen panics (a real bug) surface as
  a thrown exception the editor shows as an internal-error toast.

### How it plugs in

- **Editor**: `linter` source and preview trigger both call `compile()` (via the
  cached wrapper) on idle. `symbols` → autocomplete. `diagnostics` → squiggles.
- **Preview VM**: on `ok`, `bytecode` + `manifest` go to `fx_vm_web`
  (runtime-owned) as described in §Editor. The compiler and the VM are separate
  wasm modules (`fx_compiler_web`, `fx_vm_web`) loaded independently, matching
  the runtime doc's crate split (`fx_compiler` vs `fx_vm`).

---

## AI generation (Claude)

The AI feature turns an English prompt into a valid, previewing effect. It is a
straight **Messages API** call to Claude, grounded by our compiler.

### Model & request shape

- **Model: `claude-opus-4-8`** (current Opus; strong at code synthesis and at
  self-repair from compiler feedback). The model id is a config constant, not
  hard-coded at call sites, so it is swappable.
- Use **structured output** so the reply is machine-parseable without brittle
  prose scraping: `output_config: { format: { type: "json_schema", schema } }`
  with a schema of `{ script: string, notes: string }`. (Do **not** use an
  assistant-prefill to force JSON — prefills 400 on Opus 4.8.)
- `thinking: { type: "adaptive" }` — let the model reason about the spatial math
  when the prompt is non-trivial; omit or drop to `effort: "low"` for quick
  tweaks.
- `max_tokens` ~4000 (scripts are small); stream if we want to show the code
  arriving live in the editor.
- **Prompt caching**: the system prompt (§below) is large and *frozen* — mark it
  with `cache_control: {type:"ephemeral"}` so the repair loop and repeated
  generations pay the cached rate. Keep the volatile per-request content (the
  user's ask, the current script, compiler diagnostics) in the `messages`, after
  the cached system prefix.

Request skeleton (executed by the proxy in §4, or the browser in the BYO-key
fallback):

```jsonc
{
  "model": "claude-opus-4-8",
  "max_tokens": 4000,
  "thinking": { "type": "adaptive" },
  "system": [{ "type": "text", "text": "<the effects system prompt>",
              "cache_control": { "type": "ephemeral" } }],
  "output_config": { "format": { "type": "json_schema",
    "schema": { "type": "object", "additionalProperties": false,
      "properties": { "script": {"type":"string"}, "notes": {"type":"string"} },
      "required": ["script", "notes"] } } },
  "messages": [ { "role": "user", "content": "<user ask, or repair turn>" } ]
}
```

### System prompt design

The system prompt is the contract that makes the model emit **valid** scripts. It
is assembled from the same `lang-spec.ts` data that drives highlighting/
autocomplete, so it can never describe a built-in the compiler doesn't have. It
contains:

1. **Role + hard constraints.** "You write effects for an LED-mapping runtime.
   Output only a program in the language below. It must compile with the provided
   grammar and built-ins — no other functions, no imports, no host APIs." State
   the hard limits from `effects-runtime.md`: two entry points `update()` (once/
   frame) and `shade(Led led) -> vec3` (per-LED, returns linear RGB 0..1); no
   recursion; `for` loops must have compile-time-bounded trip counts (there is a
   per-frame instruction budget); values are `f32`.
2. **The type system & contexts.** `float/vec2/3/4/int/bool`; the global reads
   (`time`, `dt`, `frame`), `led.*` (`pos` in a gravity-leveled, unit-ish box;
   `idx`, `count`, `seg`, `s`, `branch`), `imu.*` when present.
3. **The full built-in list**, generated verbatim from `lang-spec.ts` with
   signatures — so the model has an exact, current vocabulary.
4. **The uniform syntax**, with the UI-kind grammar:
   `uniform float speed : 0.0 .. 5.0 = 1.0;` (slider), `: color` (picker),
   `: {"fire","ice"}` (dropdown), plain `= false` (toggle). Instruct it to
   **expose the interesting parameters as uniforms with sensible ranges** so the
   user gets live controls — this is a product requirement, not just legality.
5. **`state` usage** — persistent vars written by `update()`, read-only in
   `shade()`; for phases/integrators.
6. **Two or three worked examples** (a moving band, a spatial gradient, a
   spawny pulse) — the canonical shader in `effects-runtime.md` is one. Few-shot
   examples do more for validity than any amount of prose.
7. **A repair instruction**: "If you are given a previous script and compiler
   diagnostics, return a corrected script that fixes every error; change as
   little else as possible."

This prompt is authored as a checked-in asset
(`web/src/effects/ai/system-prompt.ts`, with the built-in table interpolated
from `lang-spec.ts` at build time) so it stays in lockstep with the compiler and
is reviewable.

### Request/response flow & hot-reload

```
user types an ask ("gentle blue breathing along the trunk")
   → build request (system prompt cached + user ask)
   → Claude → { script, notes }
   → put `script` into the CodeMirror doc (replacing/creating the effect)
   → this fires the normal compile-on-idle path:
        compile(script) → diagnostics + manifest + bytecode
   → on ok: uniform panel + MapView preview hot-reload (same path as hand-edits)
   → `notes` shown as a one-line caption ("added a `speed` and `hue` uniform")
```

The AI path deliberately **reuses the editor's existing compile→preview
machinery** — a generated script is just text dropped into the editor. Nothing
about preview/hot-reload is AI-specific.

**Iterate-on-prompt loop.** The generated script stays fully editable; a
follow-up ask ("slower, and make it pulse from the base") sends a new turn that
includes the *current* script as context, so the model refines rather than
starts over. This is a short multi-turn conversation kept in the workspace: each
turn appends `{role:"user", ...}` and the returned `{role:"assistant", ...}`,
preserving the cached system prefix.

### Grounding / validation / auto-repair

The compiler is the ground truth; the model does not get the last word.

```
generate → compile
  ├─ ok            → preview it, done
  └─ has errors    → auto-repair turn:
        send { previous script, the FxDiagnostic[] (message + line:col + code) }
        → Claude returns a corrected script → compile again
        → repeat up to N times (N=2–3), then stop and surface the errors + the
          best attempt for the user to fix by hand.
```

- The **exact same diagnostics** the editor shows the user are what the model
  receives — one representation, no separate "AI error format." Feeding
  `line:col` + the human message + the stable `code` gives the model precise,
  actionable signal.
- A hard cap on repair rounds bounds cost/latency and prevents loops; the user
  always ends with either a compiling effect or an editable script + visible
  errors.
- The loop is *cheap* because the system prompt is cached: each repair turn only
  re-bills the small delta (script + diagnostics).
- Optional stronger grounding later: also feed back **warnings** (unused uniform,
  loop near the budget) so the model tightens the script, and the offline
  perf-estimate (perf-monitoring doc) so it can be told "this is too heavy at 256
  LEDs, simplify."

### Key handling on a static site (the hard constraint)

The app is served as **static files from Cloudflare Pages** — there is no
server-side runtime in the deploy (`web/:deploy_cloudflare` publishes the bundle
+ wasm only) and therefore **nowhere to hold an Anthropic API key**. Shipping a
key in the static bundle would leak it to every visitor. Two options:

**Option A — Cloudflare Worker proxy (recommended default).**
A tiny Worker (separate from Pages, same account) holds the Anthropic key as a
Worker **secret** (`wrangler secret put ANTHROPIC_API_KEY`) and is the only thing
that ever sees it. The webapp calls the Worker; the Worker calls Anthropic.

- Flow: `app → POST https://<worker>/generate {ask, script?, diagnostics?}` →
  Worker builds the Messages request (system prompt, schema, model) and calls
  `https://api.anthropic.com/v1/messages` with `x-api-key: <secret>` and
  `anthropic-version: 2023-06-01` → returns `{script, notes}` (or streams). The
  **browser never holds the key**, and the system prompt/schema live server-side
  where they can't be tampered with.
- Security: the Worker is the trust boundary. It must (1) restrict CORS to the
  app's origin(s); (2) **rate-limit / abuse-guard** (per-IP token bucket via
  Workers KV or Durable Objects, a request-size cap, and a monthly spend ceiling)
  since it is an open, unauthenticated endpoint fronting a paid API; (3)
  constrain the request it forwards — the Worker owns `model`, `system`, and the
  output schema, accepting only the user's `ask`/`script`/`diagnostics` fields,
  so a caller can't turn it into a general-purpose Claude proxy; (4) optionally
  gate with a lightweight app token or Cloudflare Turnstile if abuse appears.
- This adds one small Worker to deploy but keeps the *app* fully static and
  keyless. It also centralizes the system prompt and model choice (change the
  prompt without reshipping the app).

**Option B — user-supplied key (BYO), stored locally.**
The user pastes their own Anthropic key into a settings field; it is stored in
`localStorage` and the browser calls the Messages API directly.

- Pros: zero backend, truly static, no shared spend.
- Cons: (1) the key sits in `localStorage`, readable by any script on the
  origin — acceptable only for a single-user, self-hosted-style deployment, not
  a public one; (2) browser→Anthropic CORS and preflight must be allowed
  by the API for direct calls; (3) each user needs their own Anthropic account.
  Directly exposing a key in a shared static site is exactly what we must avoid,
  so BYO is only safe as a *personal* key the user knowingly supplies.

**Recommendation: Option A (Worker proxy) as the default shipped path**, with
Option B available as a fallback/config for self-hosters who'd rather run
keyless-of-us with their own key. The app detects which is configured
(a Worker URL vs. a stored key) and routes accordingly; the compile/preview/
repair logic above is identical in both cases — only the transport differs.

Everything else in this doc — compile, preview, diagnostics, auto-repair — runs
client-side regardless of A or B, so the AI feature degrades gracefully: with no
Worker and no key, the editor and preview still work fully; only generation is
disabled.

---

## Hot-reload preview (summary)

Consolidating the preview contract that both hand-edits and AI generation share:

- Source of truth is `compile(src)`. On an error-free result, the editor:
  1. reconciles the uniform panel against the new manifest (keep live values for
     unchanged uniforms; default new ones; re-clamp changed ranges),
  2. hands `bytecode` + `manifest` to `fx_vm_web`, preserving VM `state` when the
     state layout is unchanged, resetting it otherwise,
  3. keeps the rAF loop running: each tick the VM renders over the current map's
     LED positions and writes `MapView.setLedColors()`; uniform-panel values are
     pushed into the VM every frame (no recompile to tune).
- Works with **no device connected** and on **any captured map** — the same map
  data path the current `effects/main.ts` preview uses. When a device *is*
  connected, the identical manifest values also drive `set_uniforms`, so what the
  user previews is what the device shows.

---

## Open questions

- **Diagnostic column encoding.** CodeMirror indexes in UTF-16 code units; Rust
  strings are UTF-8/byte. The API above specifies UTF-16 cols to make the JS
  mapping trivial, which pushes a UTF-8↔UTF-16 conversion into `fx_compiler`.
  Alternative: emit byte offsets and convert in JS. Pick one and pin it in the
  wasm binding tests; effects source is usually ASCII so it rarely bites, but the
  off-by-N is real for any non-ASCII comment/string.
- **Compiler on main thread vs. worker.** Default main-thread (§Compile
  pipeline); revisit if compile latency janks the preview on low-end phones.
- **AI transport default per deployment.** Ship the Worker proxy for the public
  Cloudflare Pages site; is BYO-key even exposed there, or only in self-host
  builds? (Leaning: expose BYO as an opt-in "advanced" setting, Worker as the
  default.)
- **Repair round cap N** and whether to also feed warnings/perf estimates into
  the repair turn — tune against real prompts once the compiler exists.
- **Streaming the AI script into the editor.** Nice UX (code appears live) but
  means compiling partial/invalid source mid-stream; simplest v1 is to wait for
  the full `{script}` then drop it in. Revisit if the wait feels long.
- **Worker abuse hardening depth.** Start with CORS + per-IP rate limit + spend
  ceiling; add Turnstile/app-token only if the open endpoint is actually abused.
- **System-prompt size vs. cache economics.** The built-in table + few-shot
  examples make a sizable frozen prefix; confirm it clears the model's minimum
  cacheable prefix so caching actually engages across repair turns.
