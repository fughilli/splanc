# App Store Connect ▸ App Privacy answers

These are the answers to enter in **App Store Connect ▸ Splanc ▸ App Privacy**
for the iOS app (`dev.splanc.app`). They match [the privacy notice](../privacy.md)
and replace the device-feedback-only table in `docs/store-privacy-labels.md`
(#574 branch).

**Ship gate.** Enter a row only once the build that collects it is in review:

| Row tag     | Ships with                                                                |
| ----------- | ------------------------------------------------------------------------- |
| **credits** | Splanc AI credits on iOS (In-App Purchase, `agent/ios-iap`)               |
| **email**   | Optional recovery email (#557)                                            |
| **sign-in** | Sign in with Apple and Google (`agent/sign-in-apple-google`): **pending** |
| **metrics** | "Send feedback to Fug Studio" (#574)                                      |
| **reports** | AI problem reports (#539): already shipped                                |
| **bugs**    | Bug reports via `POST /bugs`: already shipped                             |

## Page 1: data collection

- **Do you or your third-party partners collect data from this app?** **Yes.**
- **Privacy Policy URL:** the published privacy notice
  (`https://github.com/fughilli/splanc/blob/main/docs/privacy.md` today; see
  the owner decision on publishing it at `https://splanc.io/privacy`).

## Page 2: data types

Apple asks, for each data type: is it **linked to the user's identity**, is it
**used for tracking**, and for which **purposes**. "Linked" is answered once per
data type, so a type that is linked anywhere is answered **Yes**.

**Tracking: No for every type.** There is no advertising, no data broker and no
cross-app tracking, so the app never shows the App Tracking Transparency prompt.

| Data type                               | Linked to the user | Tracking | Purposes                     | What it is (source)                                                                                                                                                                                                      | Row tag          |
| --------------------------------------- | ------------------ | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Contact Info ▸ **Email Address**        | **Yes**            | No       | App Functionality            | Optional recovery email. We keep a keyed hash and a masked hint (`k•••@gmail.com`), not the address; Resend delivers the code (`agent/relay/src/billing/email.ts`, #557). Apple counts a hash of an email as email data. | email            |
| Identifiers ▸ **User ID**               | **Yes**            | No       | App Functionality            | The Splanc AI credits account id (`acct_…`) and its session token; Apple/Google's opaque subject id once sign-in ships (`billing/account.ts`, `ai-billing.md` › Accounts and identity)                                   | credits, sign-in |
| Identifiers ▸ **Device ID**             | No                 | No       | Analytics, App Functionality | The random, 30-day rotating install and player codes of device feedback (#574 `device-metrics.md`)                                                                                                                       | metrics          |
| Purchases ▸ **Purchase History**        | **Yes**            | No       | App Functionality            | Transaction id, pack and channel per purchase, refunds; on the user's opt-in, the consumption answer to Apple's refund request (`billing/purchases.ts`, `ledger.ts`, `ai-billing.md` › Apple refund requests)            | credits          |
| Usage Data ▸ **Product Interaction**    | **Yes**            | No       | App Functionality, Analytics | Linked: the credits ledger's per-request entries (model, token counts, time), for billing. Not linked: device feedback's usage category (app opens, screens, effects-sent counts)                                        | credits, metrics |
| User Content ▸ **Other User Content**   | **Yes**            | No       | App Functionality            | Prompts and effect code sent to Anthropic through the relay for Splanc AI credits; Anthropic keeps them up to 30 days with the opaque account id (`billing/proxy.ts`, `ai-billing.md` › Privacy)                         | credits          |
| User Content ▸ **Customer Support**     | No                 | No       | App Functionality            | AI problem reports: reasons, note, and (opt-in) conversation and effect code; bug reports the user confirms (`agent-feedback.md`, `agent-bug-reports.md`)                                                                | reports, bugs    |
| Diagnostics ▸ **Crash Data**            | No                 | No       | App Functionality, Analytics | Device feedback: restart reasons, crash, watchdog and brownout counts                                                                                                                                                    | metrics          |
| Diagnostics ▸ **Performance Data**      | No                 | No       | App Functionality, Analytics | Device feedback: frame rates, memory headroom, Wi-Fi signal, link drops, mesh delivery                                                                                                                                   | metrics          |
| Diagnostics ▸ **Other Diagnostic Data** | No                 | No       | App Functionality, Analytics | Device feedback: uptime, versions, board, LED count. AI problem reports: the tool trace, app log, device board and firmware                                                                                              | metrics, reports |

Notes on the choices:

- **"App Functionality"** in Apple's definition includes preventing fraud,
  security, customer support and fixing crashes and performance, which covers
  the 18+ gate, caps and abuse suspension, problem reports and device feedback.
- **Analytics** is chosen for device feedback because it measures how the app
  and players behave across installs.
- **Business monitoring (#559) adds no row.** Its events have no identifiers
  and no user content (`agent/relay/src/ops.ts`, `OPS_SCHEMA`), so they are
  aggregate counts derived from the rows above.
- **The 18+ confirmation and the refund-information consent** are records on
  the credits account, not separate data types.

## Not collected

Answer **not collected** for:

- **Financial Info** (payment info, credit info, other financial info): Apple
  handles In-App Purchase payment, and the iOS app never offers the Stripe web
  checkout (`mayShowWebCheckout()`).
- **Contact Info** other than email (name, phone, physical address), **Health
  & Fitness**, **Location** (precise or coarse), **Sensitive Info**,
  **Contacts**, **Browsing History**, **Search History**.
- **User Content** ▸ Emails or Text Messages, Photos or Videos, Audio Data,
  Gameplay Content. Camera frames for mapping are processed on the device.
  Voice in Acid Mode is recognised by Apple's speech framework; Splanc only
  receives the text, as part of a prompt (see the owner decision on audio).
- **Usage Data** ▸ Advertising Data, Other Usage Data.
- **Other Data.**

## Data not counted as collected

- **The Free AI option and your own key** send prompts straight from the device
  to OpenRouter or the user's chosen provider, under the user's own account.
  Neither we nor a partner of ours receive them.
- **Rate-limit IP counters** (deleted within a day) and transient request
  handling are not used to locate or identify the user.
- **The cloud relay** passes bridge commands through without storing them.

## App Review notes

- **5.1.2(i), third-party AI:** credits requests go to Anthropic. The model
  setup sheet says so ("Requests go through Splanc's server to Anthropic
  (Claude)"); see the owner decision on an explicit consent step.
- **5.1.1(v), account deletion:** Settings ▸ AI ▸ Delete account, with the
  forfeit warning.
- **Privacy policy link in the app:** Settings ▸ Privacy (#574); see the owner
  decision on adding it to the credits flow and About.
