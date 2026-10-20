# Run your own relay with Tailscale

The public Splanc relay is a convenience. If you'd rather your agent's requests never pass
through anyone else's server, run the relay yourself, on the bridge machine, and publish it with
[Tailscale](https://tailscale.com). No Cloudflare account is involved.

`splanc-agent relay` runs the same relay code the public one runs (OAuth sign-in with pairing
codes, tokens stored as hashes, rate limits), on Node, with its data in a local file. The bridge
connects to it over `127.0.0.1`; Tailscale gives it an HTTPS address.

There are two ways to make it reachable:

|            | Who can reach the relay                           | Use it for                                                                                     |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Funnel** | Anyone on the internet (it still demands a token) | Hosted agents (claude.ai, ChatGPT): their servers call your connector from the public internet |
| **Serve**  | Only devices on your tailnet                      | Agents that run on a machine you can put on your tailnet (a VM, a container, a cloud dev box)  |

Both need Tailscale ≥ 1.52 on the bridge machine, MagicDNS and HTTPS certificates enabled for
the tailnet (admin console → DNS). Below, `pi.example-tailnet.ts.net` stands for the bridge
machine's MagicDNS name (`tailscale status --self` shows it, as does the URL `tailscale serve`
prints).

## 1. Run the relay and the bridge

```sh
# The relay, on loopback only. --public-url is the address agents will use; --trust-proxy takes
# the caller's address from Tailscale's X-Forwarded-For (for the per-address rate limits).
npx -y https://splanc.io/agent/splanc-agent.tgz relay \
  --port 8787 --public-url https://pi.example-tailnet.ts.net --trust-proxy

# The bridge, pointed at it (a second terminal, or a second service):
npx -y https://splanc.io/agent/splanc-agent.tgz bridge --relay http://127.0.0.1:8787
```

The relay keeps its data (bridge keys, hashed tokens, pairing state) in
`~/.local/state/splanc/relay/relay.json` (`--data-dir` to move it). The bridge prints and
displays its pairing code exactly as with the public relay; `splanc-agent bridge-ctl status`
shows it too.

## 2a. Publish to the internet with Funnel (hosted agents)

```sh
sudo tailscale funnel --bg 8787
```

Tailscale terminates HTTPS at `https://pi.example-tailnet.ts.net` (port 443) and forwards to
`127.0.0.1:8787`. The first time, it prints a link to allow Funnel for this machine (it adds the
`funnel` node attribute to your tailnet policy). Check with `tailscale funnel status`; stop with
`sudo tailscale funnel --https=443 off`.

Then add the connector to your agent exactly as in
[Use Splanc from a cloud agent](cloud-agent.md), with the MCP address
`https://pi.example-tailnet.ts.net/mcp`. The sign-in page is your relay's; type the code from your
bridge.

What is exposed: only the relay's port. Every MCP request needs a token that only a pairing code
(shown on your bridge) can mint; unauthenticated requests get `401`. Funnel traffic is
encrypted to your machine; nobody in between, Tailscale included, sees the requests.

## 2b. Keep it on your tailnet with Serve (agents on machines you control)

```sh
sudo tailscale serve --bg 8787
```

Now `https://pi.example-tailnet.ts.net` works only from your tailnet. Put the agent's machine on
the tailnet. For a throwaway VM or container, use an ephemeral, tagged auth key (admin console →
Settings → Keys) so it disappears when it goes away and can be limited by policy:

```sh
sudo tailscale up --auth-key="$TS_AUTHKEY" --hostname=agent-box
```

In the tailnet policy, let that tag reach only the relay:

```json
{
  "tagOwners": { "tag:agent": ["autogroup:admin"] },
  "grants": [{ "src": ["tag:agent"], "dst": ["pi"], "ip": ["tcp:443"] }]
}
```

(`pi` is the bridge machine's name; use a tag such as `tag:splanc-bridge` for it if you prefer.)

Where the environment can't create a TUN device (many containers), run
`tailscaled --tun=userspace-networking --outbound-http-proxy-listen=localhost:1055` and point the
agent's HTTP client at it with `HTTPS_PROXY=http://localhost:1055`; whether that works depends on
the agent honoring proxy settings.

On the agent machine, open `https://pi.example-tailnet.ts.net/pair` in a browser on the tailnet,
enter the bridge's code, and use the token:

```sh
claude mcp add --transport http splanc https://pi.example-tailnet.ts.net/mcp \
  --header "Authorization: Bearer <token>"
```

(Or skip the token page: `claude mcp add --transport http splanc https://pi.example-tailnet.ts.net/mcp`
and authenticate from `/mcp` in Claude Code, which opens the same sign-in page.)

The relay still requires a token on the tailnet: being on the tailnet is not, by itself, access
to your lights.

## Run both as services (Linux, systemd)

```ini
# /etc/systemd/system/splanc-relay.service
[Unit]
Description=Splanc relay (self-hosted)
After=network-online.target
Wants=network-online.target

[Service]
User=splanc
ExecStart=/usr/bin/npx -y https://splanc.io/agent/splanc-agent.tgz relay --port 8787 \
  --public-url https://pi.example-tailnet.ts.net --trust-proxy --data-dir /var/lib/splanc-relay
StateDirectory=splanc-relay
Restart=always

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/splanc-bridge.service
[Unit]
Description=Splanc bridge
After=network-online.target splanc-relay.service
Wants=network-online.target

[Service]
User=splanc
Environment=SPLANC_BRIDGE_STATE_DIR=/var/lib/splanc-bridge
# The hub remembers players here (hub.json), so a restart reconnects without rediscovery.
Environment=SPLANC_CONFIG_DIR=/var/lib/splanc-bridge/config
Environment=SPLANC_CACHE_DIR=/var/cache/splanc-bridge
CacheDirectory=splanc-bridge
ExecStart=/usr/bin/npx -y https://splanc.io/agent/splanc-agent.tgz bridge --relay http://127.0.0.1:8787
StateDirectory=splanc-bridge
# /run/splanc-bridge: status.json + control.sock (the display contract)
RuntimeDirectory=splanc-bridge
RuntimeDirectoryMode=0755
Restart=always

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --create-home splanc
sudo systemctl enable --now splanc-relay splanc-bridge
sudo tailscale funnel --bg 8787    # or: sudo tailscale serve --bg 8787
```

Pin a bundle version instead of the moving `splanc-agent.tgz` if you want upgrades to be
deliberate: the release assets are `splanc-agent-<version>.tgz` on GitHub.

## Compared with the public relay

- Your relay is up exactly when your bridge machine is; there's no free-tier quota to share.
- Funnel has its own bandwidth limits, far above what MCP traffic needs.
- Revocation, pairing codes and the display behave the same (`bridge-ctl revoke-all` etc.).
- Back up `relay.json` and `bridge.json` if you want pairings to survive a reinstall; delete
  them to start over.
