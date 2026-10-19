# Website effects playground

Status, 2026-10-19: the operator explicitly approved the OpenRouter visitor-data
flow and confirmed `OPENROUTER_API_KEY` is installed on Cloudflare. The isolated
branch contains the layout, tour, client and tested worker implementation. Live
inference and production deployment are still pending; mocked checks are not
model-quality results.

## Entry and layout

The Meet Splanc scene's Try it link adds `?workspace=demo` to the hash route:
`#/effects/edit/<scene-effect-id>?workspace=demo`. A built-in scene is duplicated
into an editable local effect and the route is replaced with that copy's ID.
Reload keeps the same copy. The original scene, camera and uniform defaults are
preserved. Ordinary effect links keep the existing customizable workspace.

Desktop: Preview and Uniforms above Code/tools and AI chat. Phone: Preview,
Uniforms and AI chat stay stacked, with an expandable tools section underneath.
The three core panes cannot be hidden or put behind another tab in this preset.
Normal saved docks are neither loaded nor overwritten. Existing configured AI
providers are respected; the free provider is the unconfigured demo's
default only.

The lower-left invitation starts a short local tour of Preview, Uniforms, AI chat,
Code, MIDI, Video, Device and Disassembly. Done, Skip and Escape reset the preset
(Code selected; phone tools collapsed). Navigating away disposes the overlay and
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
4,000 output tokens, 45 seconds per provider and 100 seconds overall. Price caps
cover input, output, requests and images at zero. Inline preview images only;
remote image URLs and visitor-supplied routing overrides are rejected.

The local burst guard allows 24 requests/minute/IP, two concurrent requests/IP,
eight concurrent and 120 requests/minute/isolate. It is not a distributed quota;
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

## Release gates

- Complete and test the approved worker implementation, including quota, timeout,
  cancelled-request, malformed-response, invalid-origin and free-only safeguards.
- Configure the production secret, then measure the three models on representative
  Splanc edits, compile success and latency. No live model evaluations yet.
- Publish a complete tested app artifact with matching compiler/VM WASM. Update
  splanc.io's APP_REVISION pin only after that build succeeds. The existing pin is
  still the released app-v1.4.0; the website link change alone cannot enable this.
- Deploy the worker and verify the actual browser-to-relay-to-model flow, including
  a real fallback. No production changes have been made by this branch.

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
