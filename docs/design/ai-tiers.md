# AI tiers: free, paid and self-serve

Status, 2026-11-18: built on branch `agent/ai-tiers`. The free tier and the
model-setup sheet work. The paid tier is a placeholder that turns on when
ai-billing (branch `agent/ai-billing`, `docs/design/ai-billing.md`) lands. The OAuth redirect has only been tested
against a mocked OpenRouter, and the iOS paste-the-code path has not been
tried in the real app.

## What the user sees

The first time someone sends an AI prompt with nothing set up (in the effect
editor, or via "Set up AI" in the effects library), a **Set up AI** sheet
opens. It holds on to the prompt and sends it once setup is done. The same
sheet opens from **Settings ▸ AI ▸ Model setup…** at any time. Users who
already have a key, endpoint or on-device model configured never see it.

| Tier | Cost | Quality | Limits | Privacy (shown verbatim) |
| --- | --- | --- | --- | --- |
| **Free**: OpenRouter `:free` models, user's own OpenRouter account | $0, no card | Fine for simple effects; slower and less reliable than Claude | 20/min; 50/day, or 1000/day once the account has bought $10 of credits; one prompt uses 1–3 requests | Most free models' providers may log prompts and train on them; pick a "Not used for training" model to avoid that |
| **Splanc AI credits** (paid, ai-billing) | Prepaid credits | Claude | Credit balance | Goes through Splanc's server to Anthropic |
| **Bring your own** | Provider's prices, or free on own hardware | Depends on the model | Provider's limits | Goes straight from the device to the chosen provider; on-device never leaves the device |

- **Free:** pick a model, then tap **Connect OpenRouter (free)**. This runs
  OpenRouter's OAuth PKCE flow, which gives the user their own key. Fallback:
  "I have an OpenRouter key" (paste a key; it is checked with `GET /api/v1/key`).
- **Paid:** the card shows "Coming soon" until both conditions below hold, then
  selects the credits provider (see the seam section).
- **Bring your own:** paste an Anthropic key directly in the sheet, or go to
  Settings ▸ AI for an OpenAI-compatible endpoint, an on-device model (CPU or
  WebGPU) or another cloud vendor. These options already existed; nothing new
  was added there. The OpenAI-compatible endpoint covers paid OpenRouter,
  Ollama, LM Studio and the llama.cpp server. It is now tested against a fake
  local server.
- When the free daily limit is used up, the editor says so ("You've used
  today's free OpenRouter requests (50 per day). It resets at HH:MM…"),
  suggests the other tiers, and shows a **Model setup…** button. A revoked key
  shows the same button.

Screenshots (mocked OpenRouter, all other network blocked) are in
`/workspace/.claude/aitiers/status/`, which is not committed.

## Flows

**PWA / browser (redirect).** `beginOAuth` creates a code_verifier and stores
the verifier, the state, the route to return to and the chosen model in
localStorage. It then navigates to
`openrouter.ai/auth?callback_url=<origin+path>&code_challenge=…&code_challenge_method=S256&state=…`.
OpenRouter sends the user back with `?code&state`. At boot, before the router
starts, `finishOpenRouterRedirect` checks that the state matches and calls
`POST /api/v1/auth/keys {code, code_verifier, code_challenge_method}` to get
`{key}`. It then stores the key under the free tier, strips the code from the
URL and restores the route. When the editor mounts, it takes the pending prompt
for that route and sends it.

localStorage is used rather than sessionStorage because an installed Android
PWA can come back in a browser tab. If the sheet is open in another tab, a
`storage` event lets it pick up the new config.

**iOS app (headless code).** The Capacitor WKWebView opens off-origin pages in
Safari, and nothing brings a redirect back into the app without a native URL
handler. So the app uses OpenRouter's headless mode: it omits `callback_url`.
OpenRouter then shows a one-time code (valid 10 minutes) for the user to paste
into the sheet. The PKCE exchange is the same.

**CORS.** `openrouter.ai/api/v1/*` answers `Access-Control-Allow-Origin: *`
for both `https://` and `capacitor://localhost`, so the app can call it
directly. Checked with a live preflight.

There is no Splanc server and no shared key. The relay key used by the website
demo (`effects-demo.md`) is not touched and is not used here.

## Provider

`web/src/effects/ai/providers/openrouter.ts` now serves the cloud vendor
`openrouter` for both the free tier and paid OpenRouter keys. It:

- streams responses, rebuilding tool calls from their deltas, and shows the
  `set_script` summary as the status;
- sends `reasoning: {enabled: false}` for free models. With its default
  reasoning, Nemotron 3.5 Super spent all 4000 output tokens on reasoning and
  never made a tool call;
- sends a `models` list for fallback that contains only `:free` models;
- sends `provider.data_collection: "deny"` for models marked private;
- returns typed errors: `daily_limit`, `rate_limited` (per minute),
  `upstream_busy`, `auth`, `payment`, `model_unavailable` (including the
  privacy-settings block), and `unavailable`.

Browsers cannot read `Retry-After` or `X-RateLimit-*`, because OpenRouter does
not list them in its CORS exposed headers. Reset times therefore come from
`error.metadata.headers` in the response body.

Checked against the live API (`/workspace/.claude/aitiers/eval/live_check.json`):

- The default model returned a `set_script` call in 1.2 s, with the summary
  streamed as the status.
- A bad key produced the `auth` error.
- An unknown model id produced `model_unavailable`.
- `GET /key` returned the daily free allowance.

## Model choice (eval)

Tool: `tools/fx_agent_eval/openrouter_eval.py`. It uses the app's real
`CHAT_SYSTEM` prompt and its `set_script` tool (rendered from the tree), the 15
fixed prompts in `prompts.json`, the host `fx_compile`, and allows up to 2
repair rounds with the compiler's diagnostics returned as the tool result.

The run was against the live API on 2026-11-18 with the owner's key, free
models only, with requests spaced 3.5 s apart. 125 of the key's 1000 daily free
requests were used. Raw results are in `tools/fx_agent_eval/out/openrouter/`.

| Model (`:free`) | Valid set_script, first reply | Compiles, first try | Compiles within 2 repairs | Median s/request | `data_collection: deny` |
| --- | --- | --- | --- | --- | --- |
| **nvidia/nemotron-3.5-lightning** (default) | 15/15 | 12/15 | **13/15** | **1.8** | refused (trains) |
| nvidia/nemotron-3-ultra-550b-a55b | 15/15 | 10/15 | 13/15 | 9.4 | refused |
| nvidia/nemotron-3.5-super-vl | 15/15 | 9/15 | 10/15 | 2.8 | refused |
| inclusionai/ling-3.2-flash | 15/15 | 8/15 | 8/15 | 16.6 | routes |
| cohere/north-mini-code | 10/15 | 5/15 | 6/15 | 2.6 | **routes** |
| google/gemma-4-31b-it | 0/15: every request got 429 upstream (Google AI Studio shared pool), and again on a retry later | – | – | – | – |
| google/gemma-4-26b-a4b-it | 1/15: 15 cells got 429 upstream | – | – | – | – |

The picker offers these, in order:

1. Nemotron 3.5 Lightning (default)
2. Nemotron 3 Ultra
3. Nemotron 3.5 Super
4. Cohere North Mini Code, labelled "Not used for training"

The picker also accepts any other `:free` id.

For comparison, Claude on the same 15 prompts (the `app2` rows in
`tools/fx_agent_eval/out/summary.md`) compiles 15/15. That run used a different
harness: `claude -p` returning a code block, not a tool call.

Caveats:

- Compiling is not the same as looking right. No judge pass was run on these
  outputs.
- n=15 per model, single run.
- The free catalog changes often (the MiniMax model shortlisted in October is
  gone). Rerun with
  `OPENROUTER_KEY_FILE=… python3 openrouter_eval.py --fx-compile <fx_compile>`.

Models without tool calling are not offered. If a user types such an id
anyway, the existing loop falls back to plain chat with no tools. The free tier
does not advertise vision: each `capture_preview` call costs one more request
against a 50-per-day allowance.

## Privacy

Free variants on OpenRouter are mostly served by endpoints that may keep and
train on prompts. A request with `data_collection: "deny"` for the Nemotron
models returns 404 "No endpoints found matching your data policy (Free model
training)". The OpenRouter account must also allow "Free model training" in its
privacy settings, or those models return the same 404. The app's error message
says this. Cohere North Mini Code and Ling do route with "deny", so the private
choice enforces it on every request.

Chat content goes from the user's device to OpenRouter under the user's own
account. Splanc never sees it.

## Paid-tier seam (with agent/ai-billing)

This PR does not import the credits provider. It assumes only these four
things, matching `providers/credits.ts` on agent/ai-billing:

- The flag is `localStorage["splanc.flags.aiCredits"] === "1"`.
- Selecting the tier means `updateAiConfig({kind: "credits"})`.
- Before the billing PR merges, `normalizeConfig` drops the unknown kind. The
  card checks this with the pure function `paidTierSupported()` and stays
  "Coming soon".
- Sign-in and buying credits live in Settings ▸ AI. When credits are selected
  but no session exists, the sheet sends the user there and keeps the prompt.

A three-way merge of both branches' edits to `generate.ts`, `aiSettings.ts`,
`provider.ts` and `anthropic.ts` has no conflicts.

## Decisions for the owner

1. **Default free model:** Nemotron 3.5 Lightning, which may train on prompts.
   Alternatively, default to the weaker but private Cohere model.
2. **iOS one-tap connect:** currently the user pastes a code. A native
   `ASWebAuthenticationSession` plugin, or a `splanc://` URL scheme with
   `@capacitor/app`, would give one tap. Needs native work and an App Store
   build.
3. **Acid Mode / kiosk** still uses the shared demo relay when nothing is
   configured (zero setup for strangers), and it does not show the sheet. Keep
   it that way?
4. **Free-tier vision:** off, to save the 50/day allowance. Turn it on for
   accounts that have 1000/day?
5. **OpenRouter app attribution:** the `HTTP-Referer: https://splanc.io` and
   `X-Title: Splanc` headers make Splanc appear in OpenRouter's app rankings.
   Keep them?
