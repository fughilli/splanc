# Agent bug reports (`file_bug`)

Every Splanc agent can file a bug against
[fughilli/splanc](https://github.com/fughilli/splanc) with one shared tool, `file_bug`.

## Where it is

| Agent                                                                       | Where the tool is defined                                      | Diagnostics                                                       | Direct filing                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| MCP hub over stdio (`npx … splanc-agent`) and the CLI (`splanc-agent file-bug`) | `agent/src/bugs.ts` (registered in `server.ts`)                | agent bundle, Node, OS; for each player: firmware, board, channels, LED count, features, a hash of the active effect | `POST <relay>/bugs`. Signed as this host's bridge if it runs one, anonymous otherwise |
| LAN bridge (`splanc-agent bridge`) for cloud connectors                     | the same, `surface: "bridge"`                                   | the same                                                           | `POST <relay>/bugs`, signed with the bridge's Ed25519 key  |
| Cloud relay `/mcp` (ChatGPT / Claude connectors)                            | `agent/relay/src/bugs.ts` `relayFileBug`, listed by `mergeTools` | relay protocol version and the bridge's state only                | in-process, with the per-bridge limit                      |
| App editor AI and Acid Mode                                                  | `web/src/effects/ai/chatPrompt.ts` `BUG_TOOLS` + `web/src/bugs/appBugReport.ts` | app version and commit, a coarse browser label, AI provider kind; for a connected player: firmware, board, channels, LED count; a hash of the effect | `POST <relay>/bugs` with the app's relay token if paired, anonymous otherwise. A confirmation dialog appears first |

The cloud relay serves `file_bug` itself in two cases:

- the bridge is offline;
- the bridge's `tools/list` doesn't include `file_bug` (an older bridge). The relay keeps this flag in storage.

Otherwise the call is tunnelled to the bridge, which can collect device diagnostics.

The shared core is `web/src/bugs/bugReport.ts`. It is a pure module that the agent, the relay and the app all import, and it holds:

- the input schema and description;
- validation;
- scrubbing;
- the issue body;
- the `issues/new` link;
- the duplicate search;
- the client for `POST /bugs`.

## Flow

1. **Validate.** The tool needs a title, a description and a severity (`critical | high | medium | low`). It also takes optional `steps_to_reproduce`, `expected` and `actual`. Size caps are in `BUG_LIMITS`.
2. **Diagnostics.** The surface adds its diagnostics automatically (see the table). It never adds:
   - a player's name, MAC or address;
   - the effect's name or source;
   - the user's effect library or keypoints.
3. **Attachments are opt-in.** These go in only when the agent attaches them, and the description tells it to ask first:
   - `effect_source`
   - `logs` (only the tail is kept)
   - `device_info`
   - `versions`
   - `fx_snapshot`, for a future `snapshot_fx` debugging tool
4. **Scrub everything.** `scrubText` and `scrubValue` run over all of the text:
   - **Removed:** PEM blocks, relay/GitHub/OpenAI/Anthropic/Google/AWS/Slack tokens, JWTs, `Bearer`/`Basic` credentials, `key: value` and `"key": "value"` pairs whose key names a password, PSK, secret, token, API key, auth, cookie or SSID, `--password`-style flags, Wi-Fi QR payloads, credentials in URLs and secret-looking query parameters, e-mail addresses, home-directory user names, and long mixed-case alphanumeric runs.
   - **Coarsened:** IPv4 addresses become `192.168.x.x`, `10.x.x.x` and similar, and a public address becomes `[public-ip]`; IPv6 becomes `[ipv6]`; a MAC keeps its OUI.
   - **Dropped from objects:** keys named after secrets or the private library.
5. **Look for duplicates.** The tool searches open issues in the repository through the public GitHub search API (unauthenticated) and ranks them by title overlap. Likely duplicates come back in `duplicates`, so the agent can point the user at them or comment there.
6. **Submit.**
   - `submit: "url"` (the default, always available): the result carries `submit_url`, a pre-filled `https://github.com/fughilli/splanc/issues/new?title=…&body=…&labels=agent-filed,severity:<s>` link. The user submits it under their own account. Above 7600 characters the body is cut to fit, with a note and a balanced code fence, and the footer is kept.
   - `submit: "direct"`: needs `user_confirmed: true`, which the agent sets only after the user has read the report and agreed. If possible duplicates were found, it also needs `ignore_duplicates: true`. In the app, a confirmation dialog is shown as well. If the relay can't file the report, the result falls back to the link. That covers: not configured, rate limited, offline, or GitHub refusing it.

Every issue body ends with a visible "Filed by an AI agent through Splanc (<surface>)" line and the hidden marker `<!-- splanc:agent-filed v1 -->`. Every issue is labelled `agent-filed` and `severity:<level>`.

## `POST /bugs` (the relay)

The request body is `{title, body, severity, surface}` as JSON.

**Responses:**

| Status | Body | When |
| ------ | ---- | ---- |
| 201 | `{number, url, labels}` | Filed. |
| 503 | `{error: "not_configured"}` | The secret is unset. This check runs before anything else. |
| 413 | | The request is over 64 KiB or the body is over 30000 characters. |
| 400 | | Validation failed. |
| 401 | | Bad credentials. |
| 429 | | Rate limited. |
| 502 | | GitHub failed. |

**Behaviour:**

- The relay scrubs the report again before filing.
- If the footer marker is missing, the relay adds it.
- If GitHub answers 422 to the labels, the relay files the issue without them.

**Credentials and rate limits.** Limits are fixed windows in the Directory Durable Object.

| Caller | Credential | Limit |
| ------ | ---------- | ----- |
| Paired app or cloud connector | `Authorization: Bearer spl_at_…` or `spl_pt_…`, checked by the bridge's Durable Object | `bugBridge`: 5 an hour per bridge |
| Bridge, or stdio on a bridge host | `x-splanc-bridge-bug: <bridge id>.<ts>.<sig>`, an Ed25519 signature over `splanc-bug-report\n<id>\n<ts>\n<sha256(body)>` | `bugBridge`: 5 an hour per bridge |
| Anonymous | none | `bugIp`: 3 an hour per client IP |
| Everyone together | | `bugGlobal`: 60 a day |

`splanc.pages.dev/bugs` reaches the relay through `RELAY_PATHS` in `web/_worker.js`. The Pages deployment must be redeployed for that path to forward.

## Configuring direct filing

The relay never files anything until its owner adds the secret. Until then, every agent hands out links.

1. On github.com, go to Settings → Developer settings → Fine-grained tokens and create a token:
   - **Repository access:** only `fughilli/splanc`.
   - **Permissions:** Issues: Read and write. Nothing else.
   - **Expiry:** pick one and note it. When the token expires, direct filing reports "GitHub answered 401" and agents fall back to links.
2. Store it as a Worker secret, from `agent/relay/` with the Cloudflare credentials loaded:

   ```sh
   pnpm dlx wrangler@4 secret put GITHUB_ISSUES_TOKEN --config wrangler.toml
   ```

   The token never goes in `wrangler.toml`, the repo, or any client.
3. Optionally, create the labels `agent-filed`, `severity:critical`, `severity:high`, `severity:medium` and `severity:low` in the repo. GitHub creates missing labels when an issue uses them, if the token may. If it may not, issues are filed unlabelled; the footer marker still identifies them.
4. Optional overrides:
   - `GITHUB_ISSUES_REPO`: file somewhere else, such as a test repo.
   - `GITHUB_API_URL`: point at a different API; the tests use a mock.

A self-hosted relay (`splanc-agent relay`) reads `GITHUB_ISSUES_TOKEN` and `GITHUB_ISSUES_REPO` from its environment.

## Tests

- `web/tests/bugReport.test.ts` covers:
  - scrubbing, case by case, including what must not be scrubbed;
  - parsing, the body, labels and footer;
  - the link and its truncation;
  - duplicate search over a mocked fetch;
  - the `POST /bugs` client;
  - the tool's decision flow;
  - the app hook (dialog, relay token).
- `agent/tests/bugs.test.ts` runs a mock GitHub on 127.0.0.1 and covers:
  - `POST /bugs`: not configured, filing, caps, refused labels, per-IP, per-bridge (token) and signature limits, and forged credentials;
  - the relay-served `file_bug`: a bridge without the tool, a bridge with it, and a bridge offline;
  - the hub's `file_bug`: link, confirmation, signed direct filing, and the fallback when the relay isn't configured.
