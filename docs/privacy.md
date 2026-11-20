# Splanc privacy notice

Last updated: 2026-11-20.

This notice covers:

- the Splanc app on the web (splanc.io/app), on iOS and on Android (the web app
  in Chrome);
- Splanc players (the firmware on your lights);
- the Splanc cloud services: the relay that runs Splanc AI credits, problem
  reports and remote control, and the splanc.io website.

> **[OWNER: legal name]** Splanc is made by Fug Studio, a trade name of
> **[OWNER: the LLC's legal name and registered address]**, which is the
> controller of the data described here ("we", "us").
> Privacy contact: **[OWNER: privacy contact email]**.

## The short version

- **Splanc runs on your own network.** Your maps, effects, device names and
  Wi-Fi details stay on your devices unless you choose to send something.
- **Nothing is collected unless you use a feature that needs it.** Each one is
  listed below, with what it sends, why, how long we keep it and who helps us
  process it.
- **We don't sell your data, show ads, or track you across apps or websites.**
  There are no advertising or analytics SDKs in the app.
- **Splanc AI credits don't store your prompts.** They pass through our server
  to Anthropic, which keeps them for up to 30 days.
- **You can delete your data in the app**: your AI credits account under
  Settings ▸ AI, and device feedback under Settings ▸ Privacy.

## What stays on your device

These are stored only in the app on your phone or computer, or on your
players, and never sent to us:

- fixture maps, effects and saved looks (keypoints);
- device names, rooms and poses;
- Wi-Fi names and passwords (they go from the app to your player over
  Bluetooth or your local network, never to us);
- camera images used for mapping (processed in the app);
- AI chat history;
- API keys you enter for your own AI provider.

## What we receive, and when

| Feature                                                         | When                                       | What we receive                                                                  | Kept                                                                        |
| --------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Splanc AI credits account](#splanc-ai-credits)                 | Only if you use Splanc AI credits          | A random account id, your balance and ledger, purchases, an 18+ confirmation     | Until you delete the account; financial records as long as tax law requires |
| [Recovery email](#optional-recovery-email)                      | Only if you add one                        | A scrambled (keyed-hash) copy and a masked hint, not the address                 | Until you remove it or delete the account                                   |
| [Sign in with Apple or Google](#sign-in-with-apple-or-google)   | Only if you link one                       | The anonymous id Apple or Google gives us for you; for Apple, an encrypted token | Until you unlink it or delete the account                                   |
| [AI requests](#ai-requests)                                     | When you ask the AI something              | Depends on the AI option you choose (below)                                      | Splanc stores no prompt content                                             |
| [AI problem reports](#ai-problem-reports)                       | Only when you send one                     | Your note and the parts of the report you leave switched on                      | 90 days                                                                     |
| [Bug reports](#bug-reports)                                     | Only when you confirm filing one           | The issue text you approve. It becomes a **public** GitHub issue                 | As long as the issue exists                                                 |
| [Device feedback](#device-feedback-send-feedback-to-fug-studio) | Only if you turn it on. **Off by default** | Counters and measurements, in the categories you choose                          | At most 90 days                                                             |
| [Cloud relay (remote control)](#cloud-relay-remote-control)     | Only if you pair a bridge                  | Your AI client's commands to your lights, passed through                         | Not stored, except hashes of access tokens                                  |
| [Service operation](#running-the-service)                       | Whenever you use a cloud feature           | Your IP address (for rate limits) and request logs                               | IP: at most 1 day; logs: 30 days                                            |

## Splanc AI credits

Splanc AI credits let you pay for Claude in the app without your own API key.

**What we keep:**

- **An anonymous account.** The app creates a random account id (`acct_…`) and
  a sign-in token, which it stores on your device. The account holds no name,
  no email (unless you add a recovery email) and no device name.
- **Your 18+ confirmation.** Buying credits is for adults only. We record that
  you confirmed you are 18 or older, and when.
- **Your ledger:** each purchase, refund and AI request, as numbers: credits,
  token counts, the model, the time and an opaque request id. **It never holds
  your prompts or the AI's replies.**
- **Purchases:** the store's transaction id, the pack, and whether it was bought
  in the iOS app or on the web. We never keep your card or other payment
  details, and we don't keep Apple's receipt after we have checked it.
- **On iOS, your refund-information choice.** If you say yes (it is off by
  default, and you can change it in AI settings), when you ask Apple for a
  refund we tell Apple how much of that credit pack you used, as Apple's refund
  process asks. Without your yes, we tell Apple nothing.

**Payments:**

- **iOS app:** you pay Apple through In-App Purchase. Apple handles the payment
  and your payment details; we receive a signed record of the transaction.
- **Web and Android:** you pay on Stripe's secure checkout page (card, Apple Pay
  or Google Pay). Stripe collects your payment details, email and the billing
  address it needs to work out sales tax (Stripe Tax). We receive the payment's
  status, the amount and pack, and any refund or dispute, linked to your
  account id. Stripe's own privacy policy covers what you enter on its page.

**Why:** to provide the credits you bought, keep your balance correct, prevent
fraud and abuse (daily and monthly caps, suspending an account that breaks the
rules), handle refunds, and keep the financial records the law requires.

**Deleting your account** (Settings ▸ AI ▸ Delete account):

- **Any credits left are forfeited and not refunded.** The app warns you before
  you confirm.
- We first tell Apple to end any Sign in with Apple link (we revoke Apple's
  token for Splanc and erase it). Then the account is closed, your recovery
  email is erased, every Apple or Google sign-in is removed, and every device
  is signed out.
- The ledger and purchase records, which hold no name or contact details, are
  kept as long as tax and accounting law requires
  **[OWNER: retention period, e.g. 7 years]**.
- Apple's and Stripe's own refund processes stay available to you.

## Optional recovery email

An anonymous account lives only in the app's storage. If you clear the app's
data or change phones, you lose the sign-in token and your credits with it. An
email lets you get the account back. It is **optional**: you can buy credits
without one, after the app tells you that the credits can't then be recovered.

- **What we keep:** a **scrambled copy** of the address (a keyed hash), which
  is all we need to find your account when you ask to recover it, and a masked
  hint such as `k•••@gmail.com` (the first letter and the domain) so the app can
  show which email you used. **We don't keep the address itself.**
- **Codes:** to check the address is yours, and to recover the account, we send
  a 6-digit code. It is valid for 10 minutes and works once. We keep only a
  scrambled copy of the code until it is used or expires.
- **Who sends it:** our email provider, **Resend**, receives the address and the
  message only to deliver the code.
- **What it's used for:** only verifying the address and recovering your
  account. We can't send you anything else, because we don't have your address.
- **Remove it** in Settings ▸ AI at any time. Deleting the account erases it.
- Recovering your account signs it out on your other devices.

## Sign in with Apple or Google

You can link your Splanc AI credits account to Sign in with Apple or Sign in
with Google, so that your credits follow you to another device. It is
optional.

**What we keep**, for each sign-in you link (at most one Apple and one
Google):

- **The anonymous id Apple or Google gives Splanc for you.** It is not your name
  or email. We use it only to find your account when you sign in on another
  device.
- **Which Splanc app it came from** (the iOS app or the web app), because
  Apple needs that to end the sign-in later.
- **When you linked it**, which Settings ▸ AI shows.
- **For Sign in with Apple only, Apple's token for Splanc, encrypted.** We keep
  it only so we can tell Apple to end the sign-in when you remove it or delete
  your account. We never use it to get data from Apple.

To stop a sign-in being replayed, we also keep a random one-time code for 10
minutes. It isn't linked to you.

**What we don't keep:**

- **your name, email, a hashed email or your profile photo.** We ask Apple for
  no name or email, and Google only for the basic sign-in. Google's sign-in
  answer still contains your name, email and picture; our server checks the
  sign-in and discards the answer without reading or keeping them;
- any Google token;
- the sign-in id in our logs. Our logs record that a sign-in happened, with
  our own account id, for 30 days.

**Who is involved:** you sign in on Apple's or Google's own screen. Our server
asks Apple and Google to confirm the sign-in. In the web app, Apple's and
Google's sign-in scripts load only when you open the sign-in screen. Apple
tells us if you stop using Sign in with Apple with Splanc or delete your Apple
ID, and we then remove the link.

**Your controls** (Settings ▸ AI):

- **Sign out** forgets the sign-in on this device only. Nothing is deleted on
  our server.
- **Remove** a sign-in deletes what we keep for it. For Apple, we also revoke
  and erase Apple's token.
- **Delete account** does the same for every sign-in, then closes the account
  (see [Deleting your account](#splanc-ai-credits)).
- If a sign-in already belongs to another Splanc AI account, nothing is
  merged: you choose which account this device uses.

## AI requests

What happens to a prompt depends on the AI option you choose in Settings ▸ AI
▸ Model setup:

| Option                                           | Where your prompt goes                                                                                                | Who can keep it                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Splanc AI credits**                            | From the app to our relay, then to **Anthropic** (Claude)                                                             | We store no prompt content. Anthropic processes it for us, does not train on it, and keeps API inputs and outputs for up to 30 days (up to 2 years if flagged for a policy violation). We send Anthropic only your opaque account id with it, never your email or device name. |
| **Free** (OpenRouter free models)                | Straight from your device to **OpenRouter**, under your own OpenRouter account and key. Splanc's servers never see it | OpenRouter and the model provider, under your OpenRouter account's settings. Most free models' providers may log prompts and train on them; the app's "Not used for training" choice avoids that.                                                                              |
| **Your own key or endpoint**                     | Straight from your device to the provider you choose                                                                  | That provider, under your agreement with them                                                                                                                                                                                                                                  |
| **On-device model**                              | Nowhere: it runs on your device. The model files are downloaded from their public host (such as Hugging Face)         | Nobody                                                                                                                                                                                                                                                                         |
| **Website demo and Acid Mode without AI set up** | From the page to our server, then to OpenRouter's free models under our account                                       | We store no prompt content. The free models' providers may log prompts and train on them, so don't put personal information in prompts.                                                                                                                                        |

A prompt can include what you type, the effect code you are working on and a
description of your fixture (LED count, layout). Don't put personal information
in prompts.

**Voice in Acid Mode** is turned into text by your device's speech service:
Apple's speech recognition on iOS, or your browser's (for example Google's, in
Chrome). Splanc receives only the resulting text, as part of the prompt.

## AI problem reports

Every AI reply has a **Report** button. A report helps us find and fix bugs in
the AI.

- **You see exactly what is sent** before you send it, section by section.
- **Your conversation and the effect code are off by default.** You can switch
  them on, and switch any other section off.
- **Always included:** the reasons you pick, your note, the app version, a
  coarse browser label (for example "Chrome 131 on Android"), the AI model, and
  what the app noticed went wrong.
- **Never included:** API keys and tokens, Wi-Fi names and passwords, device
  names, IP and MAC addresses, email addresses, images and where you are. The
  app masks these, and our server scrubs every report again.
- **Anonymous reports are allowed.** To stop floods we keep a salted hash of
  the sender's IP address (or of the paired bridge), never the IP itself.
- **Where it goes:** a private store on our relay (Cloudflare). It is never
  posted publicly. If a group of reports turns out to be a real bug, we write
  our own public issue without your content.
- **Kept 90 days**, then deleted automatically. To delete one sooner, ask us
  (the app keeps a receipt for each report it sent, which identifies it).

## Bug reports

When the app or an AI agent offers to file a bug and you confirm, the text you
approve becomes a **public issue** on the project's GitHub page. It includes
the app and firmware versions and board details, never a player's name or
address, your effects or your saved looks. It is public as long as the issue
exists.

## Device feedback ("Send feedback to Fug Studio")

**Off by default.** If you turn it on in Settings ▸ Privacy, you choose any of
four categories:

- **Performance:** frame rates (the target, the achieved rate, and whether an
  effect is lagging), free memory, and the number of LEDs.
- **Reliability:**
  - uptime;
  - why a player last restarted (power on, update, watchdog, crash, brownout)
    and how many times since power-on;
  - Wi-Fi joins, lost connections and signal strength;
  - Bluetooth connections that dropped.
- **Mesh:** how a mesh of players delivers updates: mode, size, delivery rate,
  airtime, relay load and mode switches.
- **Usage:**
  - how many players the app knows;
  - how often you open the app and which main screens you use;
  - how many effects you send to players.
  - Never which effects you send, what they are, or what you make.

Each upload also includes:

- the app version and the platform (web, iOS or Android);
- for each player, its firmware version, its board type and how it is
  connected;
- random codes for the app and for each player.

**What we never collect** this way:

- names or device names, Wi-Fi network names or passwords;
- IP or MAC addresses, or location;
- maps, effects, chats, or anything you type.

**The codes are pseudonyms.**

- They are random, derived from a secret that only your app holds.
- They change every 30 days.
- They are never linked to your Splanc AI account, a bridge, or your IP
  address. Your IP address is used only to rate-limit uploads, and it is not
  stored with the data.

**See it yourself.** Settings ▸ Privacy ▸ **See exactly what's sent** shows the
exact text of the next upload, and of the last one.

**Why:** to find bugs, crashes and performance problems, and to tune features
such as the mesh, with your consent. You can withdraw it at any time by turning
the setting off.

**Where it goes:** to our relay (Cloudflare), then to our private monitoring
workspace (Grafana Cloud). Only Fug Studio staff can see it.

**How long:** at most 90 days, then it is deleted automatically.

**Delete it:** Settings ▸ Privacy ▸ **Delete my data**.

- It deletes everything sent under every code your app used, and turns sending
  off.
- It finishes within 7 days.
- If you turn sending back on, it starts with new codes.

## Cloud relay (remote control)

If you pair a bridge so that an AI assistant (such as a ChatGPT or Claude
connector) can control your lights, the relay passes its requests to your
bridge and the answers back. Those requests can include effect code, the shape
of your fixtures, player names and their local addresses. The relay passes them
through and does not store them. It stores no passwords, Wi-Fi details or
device keys, and keeps only hashes of access tokens. You can run your own relay
instead (see the cloud agent guide).

## Running the service

- **Business monitoring.** Our servers send counts and labels to a private
  Grafana Cloud workspace: for example, how many credits were bought or spent,
  Anthropic costs, error rates and how many problem reports came in. These
  events go through an allowlist that keeps only numbers, yes/no values and
  short labels. They never contain account ids, request or transaction ids, IP
  addresses, emails, names, card data, prompts, replies or effect code.
- **Request logs.** Our relay's logs (Cloudflare, and the billing events in
  Grafana Cloud) hold ids, token counts, status codes and errors, never prompt
  content. They are kept for 30 days.
- **Rate limits.** To stop abuse, we count requests per IP address (for example,
  how many accounts or email codes an address asked for). These counters are
  deleted when their window ends: within an hour, or at most a day.
- **Payment webhooks.** We remember the id of each Stripe event for 30 days so
  that a repeat isn't processed twice.
- **The splanc.io website** loads its fonts from Google Fonts, which receives
  your IP address as part of the request.

## Who processes data for us

| Provider                         | What for                                                                      | What it receives                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare**                   | Hosts the app, the website and our relay                                      | All requests to our servers, including your IP address; the data our relay stores                                                                                                                                    |
| **Anthropic**                    | Answers Splanc AI credits requests (Claude)                                   | Your prompts and the opaque account id                                                                                                                                                                               |
| **Stripe**                       | Web and Android payments, sales tax (Stripe Tax)                              | What you enter at checkout; your account id with the payment                                                                                                                                                         |
| **Apple**                        | iOS In-App Purchase; iOS speech recognition; Sign in with Apple               | Your purchase (Apple holds the payment); on your yes, how much of a refunded pack you used; your sign-in on Apple's screen, our checks of it, and our request to revoke it when you remove it or delete your account |
| **Google**                       | Google Fonts on the website; Chrome's speech recognition; Sign in with Google | Your IP address; your spoken words, if you use voice in Chrome; your sign-in on Google's screen and our check of it                                                                                                  |
| **OpenRouter**                   | The website demo's free AI models; the Free option (under your own account)   | Prompts                                                                                                                                                                                                              |
| **Grafana Labs** (Grafana Cloud) | Private business monitoring and device feedback                               | Allowlisted counts and labels; device feedback, if you turn it on                                                                                                                                                    |
| **Resend**                       | Sending recovery-email codes                                                  | Your email address and the code                                                                                                                                                                                      |
| **GitHub**                       | Public bug reports you confirm                                                | The issue text you approve                                                                                                                                                                                           |

Apple's and Google's own privacy policies cover what you enter on their
sign-in screens.

Some of these providers process data in the United States and other countries.

## Why we may use it (legal bases)

If you are in the UK, the EU or a similar jurisdiction, these are our legal
bases:

- **To provide a service you asked for (contract):** your Splanc AI credits
  account, sign-ins you link, purchases, AI requests through credits, the cloud relay, and bug
  reports you choose to file.
- **Your consent:** device feedback, AI problem reports, the recovery email,
  and the iOS refund-information choice. You can withdraw consent at any time
  in the app.
- **Legal obligations:** keeping financial and tax records.
- **Our legitimate interests:** keeping the service secure and working (rate
  limits, abuse prevention, request logs) and understanding the business in
  aggregate (counts without identifiers).

## How long we keep it

| Data                                     | Kept                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Splanc AI credits account                | Until you delete it                                                                 |
| Ledger and purchase records              | As long as tax and accounting law requires **[OWNER: period]**, also after deletion |
| Recovery email (scrambled copy and hint) | Until you remove it or delete the account                                           |
| Email codes                              | 10 minutes, or until used                                                           |
| Apple / Google sign-in link              | Until you remove it, delete the account, or Apple tells us you stopped using it     |
| Apple's token (encrypted)                | Revoked and erased when you remove the sign-in or delete the account                |
| Sign-in one-time codes                   | 10 minutes                                                                          |
| Prompts                                  | Not stored by Splanc; Anthropic: up to 30 days (2 years if flagged)                 |
| AI problem reports                       | 90 days                                                                             |
| Device feedback                          | At most 90 days                                                                     |
| Request logs                             | 30 days                                                                             |
| Business-monitoring counts               | No personal data; kept as long as useful                                            |
| IP rate-limit counters                   | At most 1 day                                                                       |
| Stripe event ids                         | 30 days                                                                             |

## Your rights and choices

- **Delete:**
  - your AI credits account: Settings ▸ AI ▸ Delete account;
  - your device feedback: Settings ▸ Privacy ▸ Delete my data;
  - an AI problem report: ask us;
  - your recovery email: Settings ▸ AI;
  - an Apple or Google sign-in: Settings ▸ AI ▸ Remove.
- **Stop:** turn device feedback off, choose not to send reports, and use the
  AI options that keep prompts on your device or with your own provider.
- **See:** Settings ▸ AI shows your balance and recent activity; Settings ▸
  Privacy shows exactly what device feedback sends.
- **Ask us:** for a copy of your data, a correction, deletion, or any question,
  contact **[OWNER: privacy contact email]**. Because accounts are anonymous, we
  may need you to prove the account is yours from the app (for example, with
  your account's sign-in or a code sent to your recovery email).
- **Complain:** you can also complain to your local data protection authority.

## Children

Splanc is not directed at children. Buying Splanc AI credits is for people 18
or older, and the app asks you to confirm that before your first purchase. The
other features don't ask for your age and don't collect personal information
about anyone.

## Changes

We will update this notice before a change in what we collect takes effect,
and change the date at the top.
