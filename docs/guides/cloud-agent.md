# Use Splanc from a cloud agent

AI agents that run in the cloud (Claude on claude.ai and its apps, ChatGPT, Claude Code on the
web, and similar hosted agents) can't see your home network, so they can't reach your Splanc
lights directly. A **bridge** fixes that: a small always-on computer on your network that
connects out to the **Splanc relay**, which the cloud agent talks to as an MCP connector.

```text
cloud agent ──▶ Splanc relay ──▶ your bridge (on your Wi-Fi) ──▶ your Splanc lights
```

Nothing on your network is opened to the internet: the bridge makes the connection outward,
like a phone app does. If your agent runs on your own computer (Claude Code, Claude Desktop,
Cursor…), you don't need any of this: use `splanc-agent` directly (see `/AGENTS.md` on
splanc.io).

## What you need

- A Splanc player on your Wi-Fi.
- A bridge: a computer on the same network that stays on. A Raspberry Pi with the Splanc bridge
  image (it shows its state and pairing code on its screen) is the easy option; any Linux, macOS
  or Windows machine with Node.js 20 or newer works too.
- The relay's address. The public Splanc relay runs at a `workers.dev` address
  (`https://splanc-relay.<name>.workers.dev`, published on splanc.io). You can also run your own:
  see [Run your own relay with Tailscale](relay-tailscale.md).

Below, `<relay>` stands for that address.

## 1. Start the bridge

On the Pi image, the bridge starts by itself; its screen says **Pairing** and shows a code like
`ABCD-EFGH`.

On any other computer:

```sh
npx -y https://splanc.io/agent/splanc-agent.tgz bridge --relay <relay>
```

It finds your players (mDNS, then a scan of the local network), connects to the relay, and asks
for a pairing code. Without a screen, read the code with:

```sh
npx -y https://splanc.io/agent/splanc-agent.tgz bridge-ctl status
```

The code lasts 10 minutes and works once. For a new one: the Pi's button, or
`splanc-agent bridge-ctl new-code`. An unpaired bridge makes new codes by itself during its
first hour; after that, ask for one.

Players discovery can't see (different subnet, multicast blocked): add `--host <ip>` (repeat it
for each).

## 2. Add Splanc to your agent

The MCP server address is **`<relay>/mcp`**. When the agent asks you to sign in, a Splanc page
opens and asks for the pairing code: type the code from your bridge and press **Connect**. There
is no account and no password.

- **Claude (claude.ai, desktop and mobile apps)**: Settings → Connectors → Add custom
  connector. Name it "Splanc", paste `<relay>/mcp`, add it, then press Connect.
- **ChatGPT**: in the connectors settings (developer mode), create a connector with the URL
  `<relay>/mcp` and OAuth authentication.
- **Claude Code** (including on the web):

  ```sh
  claude mcp add --transport http splanc <relay>/mcp
  ```

  then run `/mcp` in Claude Code, pick `splanc`, and choose Authenticate.

- **Anything that takes a bearer token instead of a sign-in button**: open `<relay>/pair`, enter
  the code, and copy the token it shows (once). Give the client the URL `<relay>/mcp` and the
  header `Authorization: Bearer <token>`. That page also shows the exact `claude mcp add …
--header` command.

Each agent (or each person) pairs once with its own code; the bridge's screen shows **Paired**
and how many cloud sessions are connected.

## 3. Ask

"Make the living room a slow ocean blue", "turn everything down to 30 %", "show me what the
fire effect would look like on the porch". The agent sees every player your bridge sees, rooms
and all, with the same tools a local agent gets (list players, effects, uniforms, keypoints,
previews). It can't re-flash, re-map or rewire anything.

## Managing access

- **Revoke everything**: the Pi's "revoke all" control, or
  `splanc-agent bridge-ctl revoke-all`. Every connected agent loses access at once and has to
  pair again with a new code.
- **Which light is which?** `splanc-agent bridge-ctl identify` blinks every fixture.
- **Moving the bridge** to another machine: pair again from the new one (the identity lives in
  `~/.local/state/splanc/bridge.json`; copying it moves the bridge with its pairings).

## What the screen (status) means

| State    | Meaning                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| Starting | Connecting to the relay for the first time.                                   |
| Offline  | Can't reach the relay (no internet, relay down). It keeps retrying by itself. |
| Unpaired | Connected, nobody paired yet, no code showing: ask for a code.                |
| Pairing  | A code is showing; enter it in your agent's sign-in page.                     |
| Paired   | At least one agent is connected to this bridge.                               |
| Error    | Something needs attention; the message says what.                             |

## Troubleshooting

- **The agent says the bridge is offline**: the bridge isn't running or has no internet. Check
  its screen or `bridge-ctl status`.
- **"That code isn't valid or has expired"**: codes last 10 minutes and work once. Get a new one.
- **"Too many wrong codes"**: wait 10 minutes.
- **The bridge says its signature was rejected**: the bridge computer's clock is off by more than
  5 minutes. Fix the time (NTP) and it reconnects.
- **No players listed**: the bridge must be on the same network as the players; try
  `--host <player ip>`.

## Privacy

The relay passes your agent's requests to your bridge and the answers back. It stores no
passwords, Wi-Fi details or device keys, and keeps only hashes of the access tokens. It does see
the requests themselves (effect code, the shape of your fixtures, player names and their local
addresses). If you'd rather nothing leaves your own machines, run your own relay with Tailscale.
The design and threat model are in `docs/design/cloud-relay.md`.
