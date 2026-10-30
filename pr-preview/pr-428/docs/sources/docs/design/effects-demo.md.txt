# Website effects playground

Status, 2026-10-19: the guided workspace is live through the website's Meet
Splanc scene links. All three entry links, editable scene copies, the three core
panes and all eight tour steps passed a production browser check. The configured
relay successfully used MiniMax to edit an effect, compile it and request preview
images. Its concluding response then timed out; complete live vision-loop
validation remains pending. Mocked tests are not model-quality results.

## Entry and layout

The Meet Splanc scene's Try it link adds `?workspace=demo` to the hash route:
`#/effects/edit/<scene-effect-id>?workspace=demo`. A built-in scene is duplicated
into an editable local effect and the route is replaced with that copy's ID.
Reload keeps the same copy. The original scene, camera and uniform defaults are
preserved. Ordinary effect links keep the existing customizable workspace.

The link selects the `effects-demo` preset in the existing FxLayout dock engine.
On desktop, Preview is the center, Uniforms the left dock, AI chat the right dock,
and Code/MIDI/Video/Device/Disassembly occupy the bottom tab group. On phones,
Preview, Uniforms and AI chat are initially fronted in the existing top/center/
bottom regions; the tool tabs share the center region. All normal move, resize,
hide and recall controls work. There is no demo-specific renderer or locked pane.
The preset uses a temporary persistence scope, leaving the visitor's normal saved
layout intact. Existing configured AI providers are respected; the free provider
is the unconfigured demo's default only.

The lower-left invitation starts a short local tour of Preview, Uniforms, AI chat,
Code, MIDI, Video, Device and Disassembly. Done, Skip and Escape reset the preset
(Code selected on desktop; Preview, Uniforms and AI chat fronted on phones). Navigating away disposes the overlay and
invitation. The general app tour is not prompted over this demo tour.

## Free model research

Checked against the live [OpenRouter catalog](https://openrouter.ai/api/v1/models)
on 2026-10-19. Shortlist for evaluation, **not an inference benchmark result**:

| Model | Reason to evaluate | Current catalog capabilities |
| --- | --- | --- |
| [MiniMax M3.1 Flash free](https://openrouter.ai/minimax/minimax-m3.1-flash:free) | Coding and agentic work; candidate primary | Tools, image input, 1M context; zero prompt/completion price |
| [Nemotron 3.5 Super VL free](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free) | Visual reasoning and tool use for inspecting the effect | Tools, image input, 1M context; zero prompt/completion price |
| [Gemma 4 31B free](https://openrouter.ai/google/gemma-4-31b-it:free) | Different model family with native functions and vision | Tools, image input, 262K context; zero prompt/completion price |

These models would preserve the complete edit/compile/preview tool loop through a
fallback. Poolside Laguna S 2.1 is a promising coding alternative but lacks image
input. Inkling is capable, but its free research endpoint explicitly logs usage
for model improvement and disallows confidential/personal information. NVIDIA's
free endpoint also states logging/improvement terms and prohibits confidential
or personal data. Free does not mean private or guaranteed available: the public
demo needs clear provider disclosure and suitable handling of its inputs. The
model allowlist must be revalidated before activation.

[Gemini's free API tier](https://ai.google.dev/gemini-api/docs/pricing) is another
option, but needs a separate server key and has its own data-use and quota terms.
The app's existing local WebGPU/CPU providers need model downloads and compatible
hardware, making them poor no-setup defaults for this public demo.

## Approved relay

Use the existing Cloudflare Pages worker at splanc.pages.dev; GitHub Pages cannot
hold a server-side secret. Store `OPENROUTER_API_KEY` only as a server secret, not
in Vite variables, localStorage, source or a static build. The planned endpoint is
`/api/demo-ai/chat/completions`, used by the prepared client. No credential is sent
from a visitor's browser. The request includes chat messages, effect code,
compile/tool results and preview images only when capture_preview is requested.

The relay fixes exactly three `:free` model IDs server-side, prohibit paid
fallbacks and arbitrary upstream URLs, bound request/output sizes and execution
time, allow only the effect tool names, restrict browser origins, and apply rate
limits. Bounds: 2 MiB request/response, 128 messages, five known tool names,
4,000 output tokens, 30 seconds per provider and 70 seconds overall (45/100
before the Acid Mode change below). The
[model catalog](https://openrouter.ai/api/v1/models) reports MiniMax's default
reasoning effort as `max`; the interactive relay explicitly uses its supported
`low` setting. Nemotron and Gemma disable optional reasoning. This retains the
same free models and budgets while avoiding the default deep-reasoning latency.
A response whose headers arrive but whose body stalls is classified as a timeout,
not malformed JSON. Price caps
cover input, output, requests and images at zero. Inline preview images only;
remote image URLs and visitor-supplied routing overrides are rejected.

The local burst guard (`DEMO_LIMITS`) allows 6 requests/minute and 30/hour per
client, two concurrent requests per client, eight concurrent and 20
requests/minute/isolate. A client is its IPv4 address or the /64 of its IPv6
address. It is not a distributed quota;
bind `AI_RATE_LIMITER` for Cloudflare edge rate enforcement. The OpenRouter account
still enforces its shared free allowance. Client IPs are kept only in the short
in-memory limiter window; no prompts, keys or responses are logged by this worker.
Optional `DEMO_DEV_ORIGIN` permits one explicit development origin, never a
wildcard. GET on the relay returns configuration presence and the fixed model
list without making an inference call or exposing the key.

Retry only availability failures; stop on bad input, authentication
failure, user cancellation or shared platform quota exhaustion. Honor upstream
retry guidance. Do not rotate keys to bypass quotas. See the official
[fallback guide](https://openrouter.ai/docs/guides/routing/model-fallbacks) and
[rate-limit reference](https://openrouter.ai/docs/api/reference/limits).

Model fallback protects against an individual model/provider outage. Three models
on one OpenRouter account still share its free allowance and the platform itself.
The UI must report a depleted allowance honestly and preserve Code/Uniforms and
BYOK access. Do not promise unlimited free AI or use a paid model silently.

## Release verification

- Provider, quota, timeout, cancelled-request, malformed-response, invalid-origin
  and free-only relay checks pass locally. A regression explicitly rejects 3xx
  responses and uses the redirect mode supported by Cloudflare Workers.
- Full app Test CI passed on the merged workspace revision, with 194 tests and a
  complete matching compiler/VM artifact. A web-only deployment published it to
  Cloudflare and GitHub Pages without releasing firmware or TestFlight builds.
- The production endpoint confirms configuration presence. The live MiniMax loop
  performed set_script (6.9 s), compiled successfully, then capture_preview (1.5 s).
  A second preview request took 42.7 s; the subsequent body reads hit the two
  45-second deadlines, and Gemma was provider-rate-limited. Low reasoning is now
  explicit and aborted response bodies are diagnosed correctly. A final live
  edit/compile/preview/conclusion check remains required.
- The website update preserves automatic app/agent release tracking while requiring
  a tested app revision containing this demo. Newer compatible releases should
  supersede that baseline. Three individual models have not been benchmarked.
- Cloudflare behavior is documented in its
  [Request API](https://developers.cloudflare.com/workers/runtime-apis/request/).

## Validation completed locally

- Website production build and lint passed.
- App production build and TypeScript check passed. The local preview uses the
  compiler/VM from the successful Test artifact for its exact base revision,
  ed33e4bdf0f6fe250da94f1edbd5e456ff1ec50e (run 39318684746).
- Thirty focused provider/config/tour unit tests passed, including the new demo
  client tests with synthetic responses and no external model calls.
- Chromium and WebKit, each at 1440×900 and 390×844: core pane visibility during
  all eight tour steps, Done/Skip/Escape reset, saved-layout preservation,
  editable scene copies, reload persistence, keyboard tab navigation and
  navigation cleanup passed with no page errors.
- Both browsers passed a mocked set_script → native WASM compile → capture_preview
  → assistant reply interaction. These are UI/protocol checks, not model-quality
  or live relay validation.
- Desktop and phone screenshots were actually viewed; the tab strip and core
  pane dimensions were corrected during review. Logs/screenshots are local-only
  under .ledmapper, not committed generated artifacts.

## Relay-only operational updates

The deployed browser reached OpenRouter after the redirect fix, but returned a
429. Its shared/platform vs provider scope was not distinguishable in the old
sanitation. Provider fallback now accepts OpenRouter's documented typed
`rate_limited`/`rate_limit_exceeded` and explicit legacy provider error metadata.
Exhausted platform headers or an OpenRouter limit source still stop the chain;
ambiguous limits stop too. No key rotation or paid fallback is used.

`Deploy tested web app` has an optional `worker_only` mode. It retains the entire
successful main Test artifact, requires the diff from that artifact to contain
only the Worker, its tests, this document and the deployment workflow, runs Node
regressions and pinned Miniflare/workerd checks, then replaces only `_worker.js`.
It records distinct static/worker source revisions in `worker-deployment.json`.
The static app and its compiler/VM stay matched; GitHub Pages is not republished
for this mode. Any app, native source or dependency change requires a full build.


## Tour visibility and bounded previews

The invitation uses larger bold text, a gold border and one smooth highlight every
six seconds. It stays still during hover/focus and under reduced-motion preferences.
Finishing or skipping the tour resets the same normal dock preset.

The free demo previously resent every full-resolution PNG on every tool round,
which could exceed the relay's 2 MiB request cap after a few captures. Captures are
now JPEG, at most 960 pixels on the longest edge and 256 KiB of encoded text. Only
the latest image is sent; earlier image entries become textual markers. Existing chat persistence already removes image pixels on save, so
refreshing retains the text/tool history without resending old large images. Tool-call
IDs, results, code and chat text are retained, and saved history is not mutated.
The capture waits for the refreshed frame before encoding. Other configured
providers keep their full-resolution capture path. Oversized text histories are
caught before sending with guidance to use New chat; server limits stay intact.

Regression evidence: six synthetic 700 KB preview images previously exceeded
4 MB; the filtered request retains one image below 1 MB and all tool pairs. A
real desktop browser at device pixel ratio 3 completed a mocked seven-request
edit/five-preview/conclusion flow: requests remained below 223 KB and the current
JPEG under 196 KB. This verifies transport and local compilation, not model output.

## Acid Mode on the free relay (Halloween 2026)

Acid Mode (`#/acid`) uses this relay whenever no AI provider is configured, so a
stranger at a kiosk install can tap the mic and speak with zero setup.
`#/acid?play=1` (from the kiosk play mode) adds a short Halloween persona
(`web/src/effects/ai/acidPersona.ts`) for a fixture with an LED curtain on CH0
and a rope on CH1, with unknown counts and possibly no map.

**Quota sizing.** The key has OpenRouter credit, so free models allow about 1000
requests/day and about 20/minute, shared by every visitor at both stoops.
- Per isolate: 20 requests/minute, the upstream per-minute cap.
- Per client: 6/minute and 30/hour, so one phone uses at most a few percent of a
  day. A 429 carries `retry-after` and a code: `demo_busy` (everyone),
  `client_rate_limited` or `client_hourly_limit` (this visitor).
- The client shows "The AI is busy right now — try one of the spooky presets!"
  for a 429, a 503, a 504 or its own 60-second deadline.

**Fewer requests per prompt.** In play mode:
- Each ask sends one user turn with the last good effect, and no history.
- The prompt is the compact DSL spec plus the persona, about 9 KB.
- Output is capped at 2,500 tokens.
- Only `set_script` is advertised.
- An accepted `set_script` ends the turn: its summary is the reply, so there is
  no closing request. A refused script gets at most two repairs (three requests).

**Tools.** The relay allowlist stays at five tools. The client filters instead:
- `measure_on_device` and `file_bug` are offered only with a configured
  provider. An anonymous visitor must not file GitHub issues on the owner's
  repo, and on-device measuring adds rounds.
- Play mode also drops `capture_preview`, the MIDI tools and
  `estimate_performance`. The local upload guard runs the estimate itself, so
  the model does not spend a round on it.

**Never dark.** In play mode an effect reaches the fixture only if all of these hold:
- it compiles;
- a throwaway preview over about 2 s is not all black;
- its estimated C6 cost for 600 LEDs or more is below 2× the frame budget. Below
  that it only lags, and lag beats a cut-out.

If any check fails, the tool result says why and the fixture keeps the last good
effect.

**Origins and order.**
- `capacitor://localhost` (the iOS app's page origin) is allowed. Origin is a
  hotlink guard, not authentication.
- Nemotron now leads the fallback order. In the 2026-10-29 live check it answered
  every play-mode request in 1.7–2.5 s, after one 19 s cold start, and three of
  the four outputs compiled.

