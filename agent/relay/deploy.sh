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
#
# Direct bug filing (POST /bugs) needs one Worker secret, set once and never in the
# repo: a fine-grained GitHub PAT with Issues: write on fughilli/splanc only —
#   pnpm dlx wrangler@4 secret put GITHUB_ISSUES_TOKEN --config wrangler.toml
# Without it /bugs answers 503 not_configured and agents hand out issue links
# (docs/design/agent-bug-reports.md).
#
# Agent feedback (POST /feedback, a private store) needs one more secret, any long
# random string, which the triage CLI uses as SPLANC_FEEDBACK_TOKEN —
#   pnpm dlx wrangler@4 secret put FEEDBACK_ADMIN_TOKEN --config wrangler.toml
# Without it /feedback answers 503 not_configured and phones keep reports queued
# (docs/design/agent-feedback.md).
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
# Agent feedback: 400 (an empty report refused) = configured; 503 = no secret yet.
fb="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/feedback" -H 'content-type: application/json' -d '{}')"
case "$fb" in
  400) echo "agent feedback: configured (/feedback refuses an empty report)" ;;
  503) echo "agent feedback: NOT configured (set FEEDBACK_ADMIN_TOKEN, see the top of this script)" ;;
  *) echo "agent feedback: unexpected $fb from /feedback" >&2 ;;
esac
# Splanc AI credits: 200 = enabled (sandbox), 503 = off (docs/design/ai-billing.md
# "Sandbox deploy runbook").
ai="$(curl -s -o /dev/null -w '%{http_code}' "$url/billing/pricing")"
case "$ai" in
  200) echo "AI credits: ENABLED ($(curl -fsS "$url/billing/pricing" | grep -oE '"(version":[0-9]*|environment":"[a-z]*")' | tr '\n' ' '))" ;;
  503) echo "AI credits: off (AI_BILLING not sandbox/production, or config incomplete)" ;;
  *) echo "AI credits: unexpected $ai from /billing/pricing" >&2 ;;
esac
echo "relay is up. MCP endpoint for connectors: $url/mcp"
echo "public address (splanc.pages.dev forwards to this Worker, web/_worker.js): https://splanc.pages.dev/mcp"
echo "run a bridge against it:  npx -y https://splanc.io/agent/splanc-agent.tgz bridge --relay $url"
