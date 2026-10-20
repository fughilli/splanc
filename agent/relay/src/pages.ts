/**
 * The relay's few HTML pages: the landing page, the OAuth consent page (enter
 * the code on your bridge's screen) and the manual pairing page (code ->
 * personal token). Plain server-rendered HTML; every interpolation is escaped.
 */

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const DOCS_URL = "https://github.com/fughilli/splanc/blob/main/docs/guides/cloud-agent.md";

const STYLE = `
:root{--bg:#f7f7f8;--fg:#16161a;--muted:#5d5d66;--card:#fff;--line:#d9d9de;--accent:#6b3cf5;--err:#b3261e;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#121216;--fg:#ececf1;--muted:#a3a3ad;--card:#1c1c22;--line:#33333c;--accent:#a68bff;--err:#ff8a80;--warn:#ffcc66}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.4rem;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}
label{display:block;font-weight:600;margin:16px 0 6px}
input[type=text]{width:100%;font:600 1.6rem/1.2 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:1rem;cursor:pointer}
.err{color:var(--err);font-weight:600}.warn{color:var(--warn)}
code,pre{font-family:ui-monospace,Menlo,monospace;font-size:.85rem}pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px}
`;

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><style>${STYLE}</style></head>
<body><main><div class="card">${body}</div><p class="muted">Splanc relay · <a href="${DOCS_URL}">how this works</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // No framing (clickjacking a consent page), no scripts, forms post back here only.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export function landing(origin: string): Response {
  return page(
    "Splanc relay",
    `<h1>Splanc relay</h1>
<p>This relay lets an AI agent in the cloud drive the Splanc lights on your home network, through a
<b>Splanc bridge</b> (a small computer on that network running <code>splanc-agent bridge</code>).</p>
<p>Add this MCP server to your agent as a custom connector:</p><pre>${esc(origin)}/mcp</pre>
<p>When it asks you to sign in, enter the pairing code shown on your bridge. No account, no password.</p>
<p class="muted">Have a client that takes a bearer token instead? <a href="/pair">Get a token with a pairing code</a>.</p>`,
  );
}

export interface ConsentParams {
  clientName: string;
  clientId: string;
  source: string;
  redirectUri: string;
  /** Every OAuth parameter to carry through the form. */
  hidden: Record<string, string>;
  error?: string;
}

export function consent(p: ConsentParams, status = 200): Response {
  let host = p.redirectUri;
  let loopback = false;
  try {
    const u = new URL(p.redirectUri);
    host = u.host || p.redirectUri;
    loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    // private-use scheme: show it whole
  }
  const hidden = Object.entries(p.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return page(
    "Connect your Splanc bridge",
    `<h1>Connect your Splanc lights</h1>
<p><b>${esc(p.clientName)}</b> wants to control the Splanc lights behind one of your bridges.</p>
<p class="muted">After you approve, you go back to <b>${esc(host)}</b>.${
      loopback
        ? ` <span class="warn">That is a program on the computer you are using right now; continue only if you just started this connection yourself.</span>`
        : ""
    }</p>
${p.error ? `<p class="err">${esc(p.error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label for="code">Pairing code (on your bridge's screen)</label>
<input id="code" name="pairing_code" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="12" required autofocus>
<button type="submit">Connect</button></form>
<p class="muted">No code on the screen? Use the bridge's "new code" button (or run <code>splanc-agent bridge-ctl new-code</code> on it).
Codes last 10 minutes and work once. Client id: <code>${esc(p.clientId.length > 60 ? p.clientId.slice(0, 57) + "..." : p.clientId)}</code> (${esc(p.source)}).</p>`,
    status,
  );
}

export function oauthErrorPage(message: string, status = 400): Response {
  return page("Can't connect", `<h1>Can't connect</h1><p class="err">${esc(message)}</p>`, status);
}

export function pairForm(code: string, error?: string, status = 200): Response {
  return page(
    "Pair a Splanc bridge",
    `<h1>Get a token for your Splanc bridge</h1>
<p>For agents whose MCP settings take a <b>bearer token</b> (an <code>Authorization</code> header).
If your agent has a "sign in" / OAuth button, add <code>/mcp</code> as a connector instead: it asks for this same code.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/pair">
<label for="code">Pairing code (on your bridge's screen)</label>
<input id="code" name="pairing_code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="12" value="${esc(code)}" required autofocus>
<label for="label">Name this token (optional)</label>
<input id="label" name="label" type="text" style="font:inherit;letter-spacing:0;text-transform:none" maxlength="80" placeholder="e.g. claude code laptop">
<button type="submit">Get token</button></form>`,
    status,
  );
}

export function tokenPage(origin: string, token: string): Response {
  const mcp = `${origin}/mcp`;
  return page(
    "Your Splanc token",
    `<h1>Paired</h1>
<p>Your token (shown once: copy it now):</p><pre>${esc(token)}</pre>
<p>Claude Code:</p><pre>claude mcp add --transport http splanc ${esc(mcp)} --header "Authorization: Bearer ${esc(token)}"</pre>
<p>Any MCP client (Streamable HTTP):</p><pre>${esc(JSON.stringify({ url: mcp, headers: { Authorization: `Bearer ${token}` } }, null, 2))}</pre>
<p class="muted">It never expires. Revoke it (and every other connection) with the bridge's "revoke all" control.</p>`,
  );
}
