# Agent feedback: users help us chase AI agent bugs

When Splanc's AI does something wrong, the user can report it in two taps.
We get what we need to reproduce it and fix it. This covers the in-app AI
(the effect editor's chat and Acid Mode) and the MCP agent
(`agent/`, through `file_bug`).

This is not the same as bug reports ([agent-bug-reports.md](agent-bug-reports.md)).
A bug report describes a product defect, has no user content, and can become a
public GitHub issue. An agent-feedback report holds the user's own words and
effect code, so it goes to a **private store** and never becomes a public
issue.

## Why

A real client diagnostics bundle showed four failures. No user flagged any of
them. We only found them by reading the bundle by hand.

- The effect compiler download failed.
- The AI said "Pushed" when nothing was sent.
- The AI held back a push because an uncalibrated simulator said "over budget".
- The app offered the wrong firmware bundle for a P4.

The first three are agent behaviour. Each would have been one tap and one
reason chip, and the report would have held the tool result that proves it.

## User flow in the app

1. **Every AI reply has a small "Report" button** (a thumbs-down) under it. It
   appears in the effect editor's chat and in Acid Mode. Acid Mode's play mode
   doesn't have it, because play mode is for visitors on their own phones. The
   button is only on replies from this session: traces are kept in memory, not
   saved with the chat.
2. **A sheet opens** with these parts:
   - **Reason chips** (pick one or more): "Claimed it did something it didn't",
     "Wrong effect", "Didn't send to my fixture", "Stuck / error", "Other".
   - **An optional note.**
   - **Automatic findings** the app worked out on its own, such as "Said it sent
     the effect, but nothing was sent". See [Automatic findings](#automatic-findings).
   - **What will be sent**: one row per section, each with a switch and a
     summary such as "2 messages" or "1 turn, 3 tool calls". Under each row,
     "Show exactly what's sent" expands to the redacted JSON. The preview is
     rebuilt on every change, so it is exactly the payload. **The conversation
     and the effect code start switched off**: they are the user's own words and
     work, so the user opts in. Next to those two switches the sheet says
     "Including your conversation and the effect code helps us reproduce the
     problem." The other sections start on.
   - **A line saying what is always sent and what is never sent.**
   - **A size line**, such as "About 9 KB. 4 private details masked."
   - **A consent box**: "Send this to the Splanc team to help fix the AI. It's
     stored privately (never posted publicly), kept for 90 days, and you can ask
     for it to be deleted."
   - **Two buttons**: **Send report**, which needs at least one reason and the
     box ticked, and **Export instead**, which saves the same JSON as a file.
3. **Send** puts the report in the outbox on the phone and tries to send it at
   once. If the phone is offline, the relay is down, or intake isn't set up
   yet, the report stays queued. The app retries with backoff (1 minute,
   doubling, up to 6 hours) when it starts and when the browser comes back
   online. The button then reads "Report saved, sending later". Settings ▸
   Debugging has an "AI problem reports" row with **Send now**, **Check
   status** and **Export waiting**.
4. **Once the relay accepts a report, the report itself is deleted from the
   phone.** Only a receipt is kept: the id plus a receipt token.

### From the MCP agent side

The hub's `file_bug` (stdio, the CLI, and the LAN bridge) gets
`submit: "private"` and a `reasons` list. The agent uses it when the agent
itself misbehaved, not when the product is broken. It works in two steps:

1. Without `user_confirmed`, it returns the exact report as a draft. The agent
   shows it to the user.
2. Called again with `user_confirmed: true`, it `POST`s the report to the same
   private store, signed as the bridge when the host runs one.

The MCP server never sees the chat. Its report holds:

- the agent's own description, as the note;
- this session's last 40 tool calls, with their arguments and results;
- versions, and board and firmware info.

If the report can't be sent, the hub returns it to the agent to hand to the
user. It never falls back to a public GitHub link. Reports from the app and
from the MCP agent use the same schema and land in the same store, so triage
treats them the same way.

## What a report contains

Schema `splanc-agent-feedback/1` (`web/src/feedback/agentTrace.ts`).

**Always sent.** None of these fields hold user content:

- the reasons and the note;
- the app version and commit, and a coarse browser label (for example "Chrome 131 on Android");
- the AI kind, vendor and model;
- the reported turn's automatic findings;
- the **signal**: the failing tool, the error class and the firmware version;
- the grouping **signature**;
- which sections the user left out, what was cut to fit, and how many items were masked.

**Sections the user can switch on or off** (`conversation` and `source` start
off, `DEFAULT_OMITTED`; the rest start on):

| Section | What it holds |
| --- | --- |
| `conversation` (off by default) | The visible chat: the user's asks and the AI's replies. The last 24 messages, each up to 4000 characters. While it is off, the model's text in the trace is left out too. |
| `trace` | For each turn (up to 5, oldest first, ending at the reported turn): the start time, duration, outcome and error. For each round: its time and the model's text (only when the conversation is included). For each tool call (up to 40): its name and arguments, its result, its time and duration, SENT or NOT SENT, the compile outcome, and whether an estimate was calibrated. Also the system prompt's **hash, length and tool list**, not the prompt itself. |
| `source` (off by default) | The effect source before and after the reported turn, up to 12,000 characters each. If `source` is off, any source inside tool arguments is replaced by its length. |
| `device` | For each connected fixture: board, firmware, features, channel count and LED count. |
| `applog` | The last 80 entries of the app event log (#519). |

**Never sent:**

- provider API keys (any AI setting whose name contains key, token or secret is dropped);
- Wi-Fi names and passwords, relay and GitHub tokens, certificates and keys;
- fixture names, MAC addresses, IP addresses and `ws://` URLs;
- e-mail addresses and home-directory user names;
- images (`capture_preview` results become "[image omitted]");
- where the user is: no location, room names or poses.

**Redaction** runs on every string in two passes:

1. The app log's masks (#519, `maskText`): known device names and hosts become
   their opaque `dev#…` id, and `ws(s)://` URLs, URL queries, IP addresses, MAC
   addresses and long key-like runs are masked.
2. The bug reporter's scrubber (`scrubText` / `scrubValue`): `password=` /
   `ssid:` / `"token": …` pairs, the known token shapes, PEM blocks, Wi-Fi QR
   payloads and e-mail addresses.

The relay runs the scrubber again on intake.

**Size.** A report is at most 96 KiB of JSON. If it's bigger, the app shrinks
it in this order and notes each step in `truncated`:

1. the app log;
2. older messages;
3. tool results, cut to 1500 characters, then 600, then 200;
4. older turns;
5. the source, cut to 4000 characters, then 1000.

The reported turn is always kept.

### Automatic findings

The recorder (`TurnRecorder`) watches the existing `ChatHooks` seams: `onTrace`,
plus a new `onPrompt` that runs once per turn with the assembled system prompt
and the tool list. When the turn ends, it sets these flags:

| Flag | When it is set |
| --- | --- |
| `claimed_sent_not_sent` | The reply says pushed, sent, live or playing, no tool reported SENT, and the reply doesn't negate it. |
| `held_on_uncalibrated_estimate` | Nothing was sent, every estimate was uncalibrated, and the reply blames the budget or performance. |
| `compile_failed` | The last compile of the turn failed. |
| `tool_error` | A tool returned an error. |
| `exhausted` | The turn ran out of tool rounds. |
| `turn_error` | The turn threw an error. |

Two of the motivating failures (the false "Pushed" claim and the hold on an
uncalibrated estimate) are flagged without the user having to say so.

## Intake: where reports go

**Choice: a private store in the relay we already run.** Reports go to
`POST <relay>/feedback` (`agent/relay/src/feedback.ts`). They are stored in the
relay's `Directory` Durable Object: `fb:<id>` holds the record and `fbi:<id>`
holds a summary used for listing. This is on the Cloudflare free plan, needs
no new service, and uses the same callers, credentials and limits as `POST /bugs`.

| Method and path | Who | What it does |
| --- | --- | --- |
| `POST /feedback` | anyone | Submit a report. Answers `201 {id, receipt, status}`. The same report again answers 200 with the same receipt. A different report with the same id answers 409. |
| `GET /feedback/status?id=` | the reporter (`x-splanc-receipt`) | Returns `{status, fixed_in, message}`. |
| `DELETE /feedback?id=` | the reporter or the admin | Erases the report. |
| `GET /feedback[?signature=&status=]` | admin | Lists summaries. |
| `GET /feedback?id=` | admin | Returns the whole record. |
| `POST /feedback/status` | admin | Sets `{id, status, fixed_in?, message?}`. |

**How intake works:**

- **Off until the owner turns it on.** Without the `FEEDBACK_ADMIN_TOKEN` Worker
  secret, intake answers 503 `not_configured`, because nobody could read what
  it stored. The app then keeps reports queued and exportable.
- **Validation.** The relay checks the schema and the id format, needs at least
  one known reason and only known sections, and caps the request at 112 KiB.
  It scrubs every string again and **recomputes the signature**, so a client
  can't choose which group its report lands in.
- **Receipts** are an HMAC of the id, made with the Directory's key. Nothing
  per receipt is stored. A retry gets the same receipt.
- **Rate limits** are fixed windows, like the bugs endpoint:
  - `feedbackBridge`: 20 an hour per bridge (a paired app's relay token, or a bridge signature);
  - `feedbackIp`: 6 an hour per IP for anonymous callers;
  - `feedbackGlobal`: 300 a day for everyone together.
- **Abuse handling.** The summary keeps `via` (bridge or anonymous) and `from`,
  a salted hash of the bridge id or IP, never the IP itself. That lets us spot
  and delete a flood from one source. Blocking a source is a later addition if
  it's ever needed.
- **Retention.** Each record has an `exp` field, 90 days by default
  (`FEEDBACK_RETENTION_DAYS`). The Directory's alarm purges expired records
  with the rest of its housekeeping.
- **Privacy.**
  - Reports are opt-in for every report, with a preview.
  - Every section can be switched off.
  - Deletion on request works through the receipt, or by us with the admin token.
  - Nothing goes to GitHub. When a group of reports turns out to be a real bug,
    *we* open a public issue in our own words, with no user content, and link it
    to the group's signature.

**Considered and rejected:**

- **Public GitHub issues.** They break the owner's rule that a client's
  identity or chat content never goes anywhere public.
- **A private GitHub repo** (for example `Studio-Fug/splanc-feedback`), with
  the relay filing issues there. It gives comments and notifications for free.
  But it needs another token with write access, has a 65 KB body limit, and
  doesn't solve the reporter's status or deletion. It could be added later as a
  *mirror* for groups, never for raw reports.
- **R2 or a dedicated Durable Object.** Use one if volume outgrows the
  Directory: about 5 GB on the free plan, which is roughly 50,000 full reports.
  The endpoint wouldn't change.

## Grouping (deduplication)

The signature is `fnv1a(tool | error class | flags | reasons | app version | firmware)`.

- `tool` is the reported turn's last failing tool call: an error, NOT SENT, or
  a compile failure.
- The error class is lowercased, with numbers, hex ids and quoted text removed,
  so "line 12: unknown identifier "foo"" and "line 3: unknown identifier 'bar'"
  match.

The signature does not depend on which sections the user left out. Triage lists
groups with the biggest first.

## Triage tooling (for us)

`splanc-agent feedback …` (`agent/src/feedback.ts`, `agent/src/feedbackCli.ts`).
It reads the relay with `SPLANC_FEEDBACK_TOKEN` (the admin token), or reads
files that the app exported (`--file`).

| Command | What it does |
| --- | --- |
| `feedback list [--signature s] [--status s]` | Lists groups: count, tool, error class, flags, reasons, app and firmware versions, statuses, newest report and ids. |
| `feedback show <id>` | Shows one report as readable text: the findings, the conversation, and a timeline per turn (`r1 +0ms set_script (80 ms) [compile ok, NOT SENT]: …`). |
| `feedback replay <id> [--runs 5] [--host <test player>]` | Re-runs the recorded tool calls through the hub's own MCP tools, N times. |
| `feedback status <id> fixed --fixed-in 1.15.0` | Sets the status. The reporter sees it in the app. |
| `feedback fixture <id> --out f.json --expect ok/ok/sent` | Turns a confirmed report into a regression fixture: the scrubbed report plus the outcome its failing step must replay as once fixed. |

**How replay works:**

- **App tool calls are mapped onto the agent's tools.**
  - `set_script` becomes `deploy_effect` (compile and upload, which gives
    SENT or NOT SENT);
  - `estimate_performance` becomes `estimate_effect`;
  - `capture_preview` becomes `preview_effect`;
  - `measure_on_device` becomes `measure_effect`;
  - `set_live_uniforms` becomes `set_uniforms`.
- **MCP tool calls replay as recorded.** MIDI and `file_bug` are skipped.
- **Each step gets an outcome class**, `ok|error / compile ok|error|- / sent|not_sent|-`.
- **Replay reports:**
  - how many runs brought the reported failure back;
  - the first step where the runs disagree with each other (flaky);
  - the first step where a run disagrees with the recording;
  - how many uploads the player saw, when that is available;
  - plain-English findings.

**Replay re-runs the tools, not the model.** That splits faults into two kinds:

- **A tool or app fault.** For example, the app reported NOT SENT, but a fresh
  fixture accepts the same effect. That points at the app's push path.
- **A model fault.** For example, the tool said NOT SENT and the reply said
  "Pushed". That is a model honesty bug, and the finding says so.

The agent tests run replay against `FakePlayer`
(`agent/tests/feedback.test.ts`, with the committed synthetic fixture
`agent/tests/fixtures/feedback/claimed-pushed-not-sent.json`).

**Model replay** (later): re-ask the recorded user turns N times against a
model with a scripted or simulated fixture, and compare the runs side by side.
This is the one idea we take from
[orban/moirai](https://github.com/orban/moirai). We considered moirai and
rejected it as a dependency:

- it is archived;
- its own held-out test found that its trajectory-divergence analysis predicts
  success at chance (AUROC about 0.51);
- it needs many repeated pass/fail runs of the same task.

Repeated runs compared side by side only suit our replay step, and we do that
ourselves.

## Feedback to the reporter

The phone keeps one receipt per sent report (up to 50). "Check status", and
later a background refresh, asks `GET /feedback/status` for each one. The app
shows one of: **Received**, **Reproduced: we can see the problem**, **Looked
at: we couldn't reproduce it yet**, **Fixed in version X**, **Closed**, or
**Deleted**. A short message from triage can ride along.

## Owner rules this keeps

- **Auto-push stays on by default.** Feedback only observes. The `onPrompt` and
  recording hooks never change what a turn does, and they never throw.
- **The fixture is the gold standard.** Estimates are recorded with whether
  they were calibrated. The `held_on_uncalibrated_estimate` finding exists to
  catch an AI that let an uncalibrated estimate gate a send.
- **Complexity stays in the app.** Capture, redaction, size limits, the outbox
  and the preview all run on the phone. The relay only validates and stores.
  The firmware is untouched.
- **No client identity or chat content in public places**, including PRs,
  issues and docs. The committed fixture is synthetic.

## Plan (small PRs)

1. **This PR.**
   - In the app: the trace recorder and report core, the sheet with preview and
     consent, the offline outbox, and the editor and Acid Mode buttons.
   - On the relay: the private store (`/feedback`).
   - In the agent: `file_bug submit=private` and the triage CLI (`list`,
     `show`, `replay`, `status`, `fixture`).
   - Tests for all of it, and this design.
2. Show each sent report's status under its reply, and in Settings as a list
   with a Delete button that uses the receipt. Refresh it in the background
   once a day.
3. Model replay: re-ask recorded turns N times with a scripted fixture, using
   the provider seam, and compare runs side by side.
4. A regression-fixture runner: every file in `agent/tests/fixtures/feedback/`
   replays in CI and must match its `expect`.
5. A weekly triage summary of groups by count (private), and a public issue,
   in our own words, per confirmed group.
6. If needed: move storage to R2 or a dedicated Durable Object, and block
   abusive sources.

## Decisions (owner, on #539)

1. **Storage:** the relay's private store (Cloudflare Durable Object). The owner
   sets `FEEDBACK_ADMIN_TOKEN` and deploys after merge; see [Deploying](#deploying).
2. **Retention:** 90 days (`FEEDBACK_RETENTION_DAYS` changes it).
3. **Defaults:** the conversation and effect code sections start **off**, with
   the note that including them helps us reproduce the problem. The others
   start on.
4. **Anonymous reports:** allowed from apps not paired with a bridge, with the
   per-IP limit (6 an hour) and the global limit.

Still open:

- **A private GitHub repo as a mirror** for confirmed groups. Do we want one?
- **Found while building this.** The MCP `deploy_effect` refuses to deploy
  when its *uncalibrated* default-table estimate says the effect would overrun
  (`agent/src/server.ts`, `calibrated: false`), unless `force=true`. That goes
  against "uncalibrated estimates never gate anything". #522 fixed this only in
  the app. Should the hub get the same fix?

## Deploying

After merge (needs `CLOUDFLARE_API_TOKEN` with Workers Scripts: Edit, and
`CLOUDFLARE_ACCOUNT_ID`):

1. Set the secret once (any long random string; keep it, it is the triage
   CLI's `SPLANC_FEEDBACK_TOKEN`):
   `cd agent/relay && pnpm dlx wrangler@4 secret put FEEDBACK_ADMIN_TOKEN --config wrangler.toml`
2. Deploy the relay Worker: `agent/relay/deploy.sh`. Its smoke test prints
   "agent feedback: configured" (`POST /feedback` with `{}` answers 400; 503
   means the secret is missing).
3. Deploy Pages so `splanc.pages.dev/feedback` and `/feedback/status` are
   forwarded to the relay (`web/_worker.js` `RELAY_PATHS`): run the "Deploy
   tested web app" workflow (`deploy-web.yml`) with the merge commit's
   successful Test run id and `worker_only` **off**: this change also ships the
   app's Report button, and `worker_only` refuses a diff outside `_worker.js`.
4. Check end to end with the admin token: list
   (`curl -H "authorization: Bearer $T" https://splanc.pages.dev/feedback`
   answers `{"items": [...]}`; without the token, 401), send one report from
   the app (it should leave the outbox), then
   `SPLANC_FEEDBACK_TOKEN=$T splanc-agent feedback list --relay https://splanc.pages.dev`
   and `feedback show <id>`, set `feedback status <id> wontfix`, and delete the
   test report with `curl -X DELETE -H "authorization: Bearer $T" "https://splanc.pages.dev/feedback?id=<id>"`.
