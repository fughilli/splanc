# Splanc privacy notice

Last updated: 2026-11-20. Covers the Splanc app (web, iOS, Android), Splanc
players (firmware), and the Splanc cloud relay, run by Fug Studio.

Splanc runs on your own network. Your maps, effects, device names and Wi-Fi
details stay on your devices unless you choose to send something. This notice
lists everything that can leave them and why.

## What we receive, and when

| What                                                | When                                                              | What it contains                                                                                                                                                                                | Kept                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Device feedback** ("Send feedback to Fug Studio") | Only if you turn it on in Settings ▸ Privacy. **Off by default.** | Counters and measurements from your players and the app, in the categories you choose (below).                                                                                                  | At most 90 days                                                     |
| **Agent feedback reports**                          | Only when you send one from the AI chat.                          | Your note, the conversation and the effect involved, as shown before sending.                                                                                                                   | 90 days                                                             |
| **Bug reports**                                     | Only when you confirm filing one.                                 | The issue text you approve. It becomes a public GitHub issue.                                                                                                                                   | As long as the issue exists                                         |
| **Splanc AI credits**                               | Only if you buy credits or use Splanc AI.                         | Account id, balance, transactions and token counts. No prompt content is stored by Splanc. Anthropic processes prompts as our sub-processor and keeps API inputs and outputs for up to 30 days. | Financial records as long as tax law requires; request logs 30 days |
| **Cloud relay (remote control)**                    | Only if you pair a bridge.                                        | The commands your AI client sends to your lights, passed through, not stored.                                                                                                                   | Not stored                                                          |

## Device feedback in detail

When you turn on **Send feedback to Fug Studio**, you choose any of four
categories:

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
  address. Your IP address is used only to rate-limit uploads for an hour, and
  it is not stored with the data.

**See it yourself.** Settings ▸ Privacy ▸ **See exactly what's sent** shows the
exact text of the next upload, and of the last one.

**Why we collect it:** to find bugs, crashes and performance problems, and to
tune features such as the mesh, using your consent (you can withdraw it any
time by turning the setting off). We don't sell it, use it for advertising, or
combine it with other data about you.

**Where it goes:** to Fug Studio's cloud relay (Cloudflare), then to our private
monitoring workspace (Grafana Cloud). Only Fug Studio staff can see it.

**How long:** at most 90 days, then it is deleted automatically.

**Delete it:** Settings ▸ Privacy ▸ **Delete my data**.

- It deletes everything sent under every code your app used, and turns sending
  off.
- It finishes within 7 days.
- If you turn sending back on, it starts with new codes.

## Your choices and rights

- Everything above except bug reports and the cloud relay is opt-in, and you can
  stop it at any time.
- For anything else (access, correction, deletion, or a question), contact Fug
  Studio through the project's GitHub page,
  [github.com/fughilli/splanc](https://github.com/fughilli/splanc).

## Changes

If this notice changes in a way that affects what is collected, the app asks
again before collecting anything new.
