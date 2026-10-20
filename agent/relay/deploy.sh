#!/usr/bin/env bash
# Deploy the Splanc cloud relay (agent/relay: a Worker + two SQLite-backed Durable
# Object classes, Workers Free plan) to https://splanc-relay.<subdomain>.workers.dev,
# then smoke-test it. docs/design/cloud-relay.md has the design.
#
#   agent/relay/deploy.sh             deploy + smoke test
#   agent/relay/deploy.sh --dry-run   bundle only (wrangler deploy --dry-run)
#
# Auth: CLOUDFLARE_API_TOKEN with Account > Workers Scripts > Edit (and Account >
# Account Settings > Read), plus CLOUDFLARE_ACCOUNT_ID. A Pages-only token is
# refused ("No access to the specified resource"). The account needs a workers.dev
# subdomain (the Workers & Pages dashboard assigns one on first visit).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ "${1:-}" == "--dry-run" ]]; then
  pnpm dlx wrangler@4 deploy --config wrangler.toml --dry-run --outdir "$(mktemp -d)"
  exit 0
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "error: CLOUDFLARE_API_TOKEN is not set (needs Workers Scripts: Edit)" >&2
  exit 1
fi

out="$(pnpm dlx wrangler@4 deploy --config wrangler.toml 2>&1 | tee /dev/stderr)"
url="$(grep -oE 'https://splanc-relay\.[a-z0-9-]+\.workers\.dev' <<<"$out" | head -n1 || true)"
if [[ -z "$url" ]]; then
  echo "deployed, but couldn't find the workers.dev URL in wrangler's output" >&2
  exit 0
fi

echo "smoke test: $url"
for _ in 1 2 3 4 5 6; do
  if curl -fsS "$url/healthz" >/dev/null 2>&1; then break; fi
  sleep 5
done
curl -fsS "$url/healthz"
echo
curl -fsS "$url/.well-known/oauth-protected-resource/mcp"
echo
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/mcp" -H 'content-type: application/json' -d '{}')"
[[ "$code" == "401" ]] || {
  echo "expected 401 from an unauthenticated /mcp, got $code" >&2
  exit 1
}
echo "relay is up. MCP endpoint for connectors: $url/mcp"
echo "run a bridge against it:  npx -y https://splanc.io/agent/splanc-agent.tgz bridge --relay $url"
