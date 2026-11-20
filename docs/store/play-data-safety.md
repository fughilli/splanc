# Google Play Console ▸ Data safety answers

**There is no Play app today.** Android users run the web app in Chrome, where
no store form applies (`docs/design/ai-billing.md` › Store rules, owner
decision 1: no Play-distributed app for now). This form is prepared for the day
a Play build (for example a Trusted Web Activity) ships. It matches
[the privacy notice](../privacy.md) and replaces the device-feedback-only
section of `docs/store-privacy-labels.md` (#574 branch).

**Before using it, read the payments note at the end:** a Play build can't use
the Stripe web checkout for credits as it stands.

## Overview questions

| Question                                                                      | Answer                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does your app collect or share any of the required user data types?           | **Yes**                                                                                                                                                                                                                                                                                             |
| Is all of the user data collected by your app encrypted in transit?           | **Yes** (HTTPS / WSS to our relay; the LAN link to players is local and isn't collection)                                                                                                                                                                                                           |
| Which of the following methods of account creation does your app support?     | Accounts are created **anonymously** (no username or password) for Splanc AI credits, optionally with a verified email for recovery, and Sign in with Google / Apple once that ships. Select the options the Console offers that match: "OAuth" (when sign-in ships) and "Other: anonymous account" |
| Do you provide a way for users to request that their data is deleted?         | **Yes**: in the app (Settings ▸ AI ▸ Delete account; Settings ▸ Privacy ▸ Delete my data)                                                                                                                                                                                                           |
| Delete account URL (required for apps that create accounts)                   | `https://splanc.io/app/#/settings/ai` (the same web app has Delete account), or the privacy notice's "Your rights" section. See the owner decision                                                                                                                                                  |
| Has your app been independently validated against a global security standard? | **No**                                                                                                                                                                                                                                                                                              |
| Is your app's data collection committed to the Play Families policy?          | **No** (not directed at children)                                                                                                                                                                                                                                                                   |

"Shared" below means transferred to a third party. Play doesn't count
transfers to **service providers** processing for us (Cloudflare, Anthropic,
Stripe, Resend, Grafana Labs), or transfers the user starts and expects (their
own OpenRouter or provider key), as sharing. So **Shared is No** throughout.

## Data types

| Category ▸ type                                           | Collected         | Shared | Processed ephemerally | Required or optional                  | Purposes                                                                         | What it is                                                                                                                                                                         |
| --------------------------------------------------------- | ----------------- | ------ | --------------------- | ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal info ▸ **Email address**                         | Yes               | No     | No                    | Optional                              | Account management                                                               | Recovery email: a keyed hash and a masked hint are kept; Resend delivers codes (#557)                                                                                              |
| Personal info ▸ **User IDs**                              | Yes               | No     | No                    | Optional (only for Splanc AI credits) | Account management, App functionality, Fraud prevention, security and compliance | Credits account id; Google/Apple subject id once sign-in ships                                                                                                                     |
| Financial info ▸ **Purchase history**                     | Yes               | No     | No                    | Optional                              | App functionality, Account management, Fraud prevention, security and compliance | Transaction id, pack, channel, refunds and disputes                                                                                                                                |
| Financial info ▸ **User payment info**                    | No (see the note) |        |                       |                                       |                                                                                  | Entered on Stripe's hosted checkout page, never received by us                                                                                                                     |
| Messages ▸ **Other in-app messages**                      | No                |        |                       |                                       |                                                                                  | AI chat stays on the device; prompts are declared below                                                                                                                            |
| App activity ▸ **App interactions**                       | Yes               | No     | No                    | Optional                              | Analytics, App functionality                                                     | Device feedback's usage counts (opt-in); the credits ledger's per-request entries                                                                                                  |
| App activity ▸ **Other user-generated content**           | Yes               | No     | No                    | Optional                              | App functionality                                                                | Prompts and effect code sent to Anthropic for credits requests (kept by Anthropic up to 30 days); AI problem reports' note and opt-in conversation and code; confirmed bug reports |
| App info and performance ▸ **Crash logs**                 | Yes               | No     | No                    | Optional                              | Analytics, App functionality                                                     | Device feedback: restart reasons and crash counts                                                                                                                                  |
| App info and performance ▸ **Diagnostics**                | Yes               | No     | No                    | Optional                              | Analytics, App functionality                                                     | Device feedback; AI problem reports' trace, app log and device info                                                                                                                |
| App info and performance ▸ **Other app performance data** | Yes               | No     | No                    | Optional                              | Analytics, App functionality                                                     | Device feedback: frame rates, memory, link drops                                                                                                                                   |
| Device or other IDs ▸ **Device or other IDs**             | Yes               | No     | No                    | Optional                              | Analytics                                                                        | Device feedback's rotating install and player codes (Play counts app-generated install ids here)                                                                                   |

Every type is **optional**: Splanc works without an account, without sending
reports and with device feedback off.

## Not collected

- **Location** (approximate or precise).
- **Personal info** other than email: name, address, phone, race and ethnicity,
  political or religious beliefs, sexual orientation, other info.
- **Financial info** other than purchase history.
- **Health and fitness**, **Messages** (emails, SMS), **Photos and videos**,
  **Audio** (voice in Acid Mode is recognised by the device's speech service;
  only the text reaches a prompt), **Files and docs**, **Calendar**,
  **Contacts**, **Web browsing**.
- **App activity** ▸ in-app search history, installed apps, other actions.

## Payments note (blocking for a Play build)

The web and Android channel buys credits through Stripe Checkout. Play's
payments policy requires Google Play Billing for digital goods in a Play app,
except where alternative billing is allowed (for example the US, with fees)
(`ai-billing.md` › Store rules). A Play build therefore needs either Play
Billing (a new purchase channel, which would then add **Financial info ▸
Purchase history** from Google instead of Stripe) or an enrolled alternative
billing program. This is an owner decision before any Play submission.
