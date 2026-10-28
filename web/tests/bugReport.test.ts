/**
 * file_bug's shared core (src/bugs/bugReport.ts) and the app's hook
 * (src/bugs/appBugReport.ts): secret scrubbing, the issue body + labels + footer,
 * the pre-filled link and its truncation, duplicate search, the direct-filing
 * client, and the tool's decision flow (link by default; direct only when the
 * user confirmed and there are no unacknowledged duplicates; fallback to the
 * link when the relay can't file).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AGENT_FILED_MARKER,
  BUG_LIMITS,
  BugInputError,
  buildIssue,
  buildIssueUrl,
  effectHash,
  fileBug,
  findDuplicates,
  parseBugInput,
  scrubText,
  scrubValue,
  submitDirect,
  type DuplicateCandidate,
  type FileBugResult,
} from "../src/bugs/bugReport";
import { appFileBugHook, coarseUserAgent } from "../src/bugs/appBugReport";

const REPORT = {
  title: "Preview shows rainbow but fixture stays dark",
  description: "After deploying, the preview animates but the strip is black.",
  steps_to_reproduce: ["Open the editor", "Deploy the rainbow example"],
  expected: "The strip shows the rainbow",
  actual: "All LEDs off",
  severity: "medium",
};

const none = async () => ({ candidates: [] as DuplicateCandidate[] });

describe("scrubText", () => {
  const cases: [string, string, RegExp | null][] = [
    ["wifi password k=v", "wifi_password: hunter2 and psk=abcdefgh", /hunter2|abcdefgh/],
    ["JSON secrets", '{"password":"abc123","ssid":"Home Net","channel":6}', /abc123|Home Net/],
    ["bearer header", "Authorization: Bearer abcdefgh12345678", /abcdefgh12345678/],
    ["relay token", "token spl_at_abcdefghijklmnopqrst_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", /spl_at_/],
    ["github PAT", "GH ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 x", /ghp_/],
    ["fine-grained PAT", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", /github_pat_/],
    ["anthropic key", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", /sk-ant/],
    ["openrouter key", "sk-or-v1-0123456789abcdef0123456789abcdef", /sk-or-v1-0123/],
    ["PEM private key", "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabc\n-----END EC PRIVATE KEY-----", /MHcCAQ/],
    ["certificate", "-----BEGIN CERTIFICATE-----\nMIIBszCC\n-----END CERTIFICATE-----", /MIIBszCC/],
    ["CLI flag", "splanc-agent --password s3cr3t --host x", /s3cr3t/],
    ["Wi-Fi QR", "WIFI:S:HomeNet;T:WPA;P:pw12345;;", /HomeNet|pw12345/],
    ["URL userinfo", "https://user:pass@relay.example/mcp", /user:pass/],
    ["URL query", "https://x.example/cb?code=abc123&state=xyz", /abc123|xyz/],
    ["email", "contact kevin@example.com", /kevin@example/],
    ["home dir", "/home/kevin/.config and /Users/kevin/x", /kevin/],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop", /eyJhbGci/],
    ["high-entropy blob", "secret AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd end", /AbCdEfGh/],
  ];
  for (const [name, input, leak] of cases) {
    test(name, () => {
      const r = scrubText(input);
      assert.ok(r.redactions > 0, `${name}: nothing redacted in ${r.text}`);
      if (leak) assert.doesNotMatch(r.text, leak, `${name}: leaked in ${r.text}`);
    });
  }

  test("IPs and MACs keep only a coarse form", () => {
    const r = scrubText("192.168.1.42:8443, 10.0.0.7, 172.20.1.1, 100.101.2.3, 8.8.8.8, 127.0.0.1, fe80::1ff:fe23:4567:890a, AA:BB:CC:DD:EE:FF");
    assert.equal(
      r.text,
      "192.168.x.x:8443, 10.x.x.x, 172.16-31.x.x, 100.64.x.x, [public-ip], 127.0.0.1, [ipv6], AA:BB:CC:xx:xx:xx",
    );
  });

  test("leaves ordinary diagnostics alone", () => {
    const s =
      "max_tokens: 4096, tokens: 5, time 12:34:56, firmware 1.10.0, commit 314275e4abcdef0123456789abcdef0123456789, " +
      "sda_pin: 6, std::fmt, deploy_effect failed: no_effect";
    assert.deepEqual(scrubText(s), { text: s, redactions: 0 });
  });

  test("an already-redacted value isn't mangled by a later rule", () => {
    assert.equal(scrubText("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").text, "token=[REDACTED github token]");
    assert.equal(scrubText("Authorization: Bearer abcdefgh12345678").text, "Authorization: Bearer [REDACTED]");
  });
});

describe("scrubValue", () => {
  test("drops secret keys and the private library; scrubs strings", () => {
    const r = scrubValue({
      wifi: { ssid: "Home", password: "pw" },
      library: [{ id: "x", source: "private" }],
      keypoints: ["warm"],
      ip: "192.168.0.5",
      firmware: { version: "1.10.0" },
    });
    assert.deepEqual(r.value, {
      wifi: { ssid: "[REDACTED]", password: "[REDACTED]" },
      library: "[omitted: the user's private library; attach explicitly]",
      keypoints: "[omitted: the user's private library; attach explicitly]",
      ip: "192.168.x.x",
      firmware: { version: "1.10.0" },
    });
    assert.equal(r.redactions, 5);
  });
});

describe("parseBugInput", () => {
  test("normalizes loose model input", () => {
    const p = parseBugInput({ ...REPORT, severity: "HIGH", steps_to_reproduce: "1. one\n2) two\n\n", submit: "direct" });
    assert.equal(p.severity, "high");
    assert.deepEqual(p.steps_to_reproduce, ["one", "two"]);
    assert.equal(p.submit, "direct");
    assert.equal(p.user_confirmed, false);
  });
  test("requires title, description, severity", () => {
    assert.throws(() => parseBugInput({ description: "d", severity: "low" }), BugInputError);
    assert.throws(() => parseBugInput({ title: "t", severity: "low" }), BugInputError);
    assert.throws(() => parseBugInput({ title: "t", description: "d", severity: "urgent" }), /severity must be one of/);
  });
  test("caps sizes", () => {
    const p = parseBugInput({ ...REPORT, title: "x".repeat(500), attachments: { logs: "L".repeat(50_000) } });
    assert.equal(p.title.length, BUG_LIMITS.title);
    assert.equal(p.attachments.logs!.length, BUG_LIMITS.logs);
    assert.ok(p.attachments.logs!.startsWith("…"), "logs keep their tail");
  });
});

describe("buildIssue", () => {
  test("sections, labels, scrubbed diagnostics, footer marker", () => {
    const input = parseBugInput({
      ...REPORT,
      actual: "dark; device at 192.168.1.9 said password=hunter2",
      attachments: { effect_source: "fn shade() {}", logs: "E (12) wifi: psk=abcdefgh" },
    });
    const issue = buildIssue(input, { firmware: "1.10.0", host: "10.1.2.3" }, "mcp");
    assert.deepEqual(issue.labels, ["agent-filed", "severity:medium"]);
    for (const h of ["### Description", "### Steps to reproduce", "1. Open the editor", "### Expected", "### Actual", "### Diagnostics", "### Effect source", "### Logs"]) {
      assert.ok(issue.body.includes(h), h);
    }
    assert.doesNotMatch(issue.body, /hunter2|abcdefgh|192\.168\.1\.9|10\.1\.2\.3/);
    assert.ok(issue.body.trimEnd().endsWith(AGENT_FILED_MARKER));
    assert.match(issue.body, /Filed by an AI agent through Splanc \(mcp\)/);
    assert.ok(issue.redactions >= 4);
  });
});

describe("buildIssueUrl", () => {
  const issue = buildIssue(parseBugInput(REPORT), {}, "web-editor");

  test("a short report fits whole", () => {
    const r = buildIssueUrl(issue);
    assert.equal(r.truncated, false);
    const u = new URL(r.url);
    assert.equal(u.origin + u.pathname, "https://github.com/fughilli/splanc/issues/new");
    assert.equal(u.searchParams.get("title"), REPORT.title);
    assert.equal(u.searchParams.get("labels"), "agent-filed,severity:medium");
    assert.equal(u.searchParams.get("body"), issue.body);
  });

  test("a long report is cut to the limit, says so, keeps the footer and closes its fence", () => {
    const big = buildIssue(parseBugInput({ ...REPORT, attachments: { logs: "line of log output\n".repeat(400) } }), {}, "mcp");
    const r = buildIssueUrl(big, { max: 3000 });
    assert.ok(r.url.length <= 3000, `${r.url.length}`);
    assert.equal(r.truncated, true);
    assert.ok(r.omitted > 0);
    const body = new URL(r.url).searchParams.get("body")!;
    assert.match(body, /\*\*Truncated:\*\* \d+ more characters/);
    assert.ok(body.trimEnd().endsWith(AGENT_FILED_MARKER));
    assert.equal((body.match(/^`{3,4}/gm) ?? []).length % 2, 0, "code fences balanced");
    // As much as fits: one more character would not.
    assert.ok(r.url.length > 2800);
  });

  test("absurdly small limits still give a labelled link", () => {
    const r = buildIssueUrl(issue, { max: 350 });
    assert.equal(r.truncated, true);
    assert.match(new URL(r.url).searchParams.get("body")!, /too long for a link/);
  });
});

describe("findDuplicates", () => {
  test("queries open issues in the repo and ranks by title overlap", async () => {
    let asked = "";
    const fetch = async (url: string) => {
      asked = url;
      return new Response(
        JSON.stringify({
          items: [
            { number: 12, title: "Fixture stays dark while preview animates", html_url: "https://github.com/fughilli/splanc/issues/12" },
            { number: 13, title: "Unrelated: flasher on Windows", html_url: "u13" },
            { number: 14, title: "Preview rainbow fixture dark", html_url: "u14", pull_request: {} },
          ],
        }),
        { status: 200 },
      );
    };
    const r = await findDuplicates(REPORT.title, { fetch });
    const q = new URL(asked).searchParams.get("q")!;
    assert.match(q, /^repo:fughilli\/splanc is:issue is:open /);
    assert.match(q, /in:title,body preview OR shows OR rainbow OR fixture OR stays OR dark$/);
    assert.deepEqual(r.candidates.map((c) => c.number), [12], "PRs and unrelated titles are dropped");
  });
  test("never throws", async () => {
    assert.match((await findDuplicates("dark fixture", { fetch: async () => new Response("", { status: 403 }) })).error!, /403/);
    const boom = await findDuplicates("dark fixture", {
      fetch: async () => {
        throw new Error("offline");
      },
    });
    assert.match(boom.error!, /offline/);
  });
});

describe("submitDirect", () => {
  const issue = buildIssue(parseBugInput(REPORT), {}, "mcp");
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  test("posts the issue to <relay>/bugs with the caller's headers", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await submitDirect("https://relay.example/", issue, {
      fetch: async (url, init) => {
        seen = { url, init: init! };
        return new Response(JSON.stringify({ number: 7, url: "https://github.com/fughilli/splanc/issues/7" }), { status: 201 });
      },
      headers: (body) => ({ "x-test": String(body.length) }),
    });
    assert.deepEqual(r, { ok: true, number: 7, url: "https://github.com/fughilli/splanc/issues/7" });
    assert.equal(seen!.url, "https://relay.example/bugs");
    const sent = JSON.parse(String(seen!.init.body));
    assert.deepEqual(Object.keys(sent).sort(), ["body", "severity", "surface", "title"]);
    assert.equal((seen!.init.headers as Record<string, string>)["x-test"], String(String(seen!.init.body).length));
  });

  test("maps the relay's refusals", async () => {
    assert.equal(((await submitDirect("r", issue, { fetch: reply(503, { error: "not_configured", message: "no" }) })) as { reason: string }).reason, "not_configured");
    assert.equal(((await submitDirect("r", issue, { fetch: reply(429, { error: "rate_limited" }) })) as { reason: string }).reason, "rate_limited");
    assert.equal(((await submitDirect("r", issue, { fetch: reply(502, { error: "github_error" }) })) as { reason: string }).reason, "unavailable");
    const down = await submitDirect("r", issue, {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal((down as { reason: string }).reason, "unavailable");
  });
});

describe("fileBug", () => {
  const filed = async () => ({ ok: true as const, number: 99, url: "https://github.com/fughilli/splanc/issues/99" });

  test("default: a link, nothing filed", async () => {
    let called = false;
    const r = await fileBug(REPORT, {
      surface: "mcp",
      duplicates: none,
      diagnostics: async () => ({ firmware: "1.10.0" }),
      direct: async () => {
        called = true;
        return filed();
      },
    });
    assert.equal(r.status, "draft");
    assert.equal(called, false);
    assert.match(r.submit_url!, /^https:\/\/github\.com\/fughilli\/splanc\/issues\/new\?/);
    assert.match(r.report.body, /"firmware": "1.10.0"/);
  });

  test("direct without the user's confirmation: not filed", async () => {
    const r = await fileBug({ ...REPORT, submit: "direct" }, { surface: "mcp", duplicates: none, direct: filed });
    assert.equal(r.status, "draft");
    assert.equal(r.direct?.reason, "needs_confirmation");
    assert.match(r.next_step, /user_confirmed=true/);
  });

  test("possible duplicates hold a direct filing until acknowledged", async () => {
    const dup = async () => ({ candidates: [{ number: 5, title: "Fixture dark", url: "u5", score: 0.5 }] });
    const r = await fileBug({ ...REPORT, submit: "direct", user_confirmed: true }, { surface: "mcp", duplicates: dup, direct: filed });
    assert.equal(r.status, "possible_duplicates");
    assert.match(r.next_step, /#5/);
    const again = await fileBug(
      { ...REPORT, submit: "direct", user_confirmed: true, ignore_duplicates: true },
      { surface: "mcp", duplicates: dup, direct: filed },
    );
    assert.equal(again.status, "filed");
    assert.deepEqual(again.issue, { number: 99, url: "https://github.com/fughilli/splanc/issues/99" });
  });

  test("confirmed: filed; the relay not configured: back to the link", async () => {
    const ok = await fileBug({ ...REPORT, submit: "direct", user_confirmed: true }, { surface: "mcp", duplicates: none, direct: filed });
    assert.equal(ok.status, "filed");
    assert.equal(ok.submit_url, undefined);
    const off = await fileBug(
      { ...REPORT, submit: "direct", user_confirmed: true },
      { surface: "mcp", duplicates: none, direct: async () => ({ ok: false, reason: "not_configured", message: "not configured" }) },
    );
    assert.equal(off.status, "draft");
    assert.equal(off.direct?.reason, "not_configured");
    assert.ok(off.submit_url);
  });

  test("diagnostics that throw don't stop the report", async () => {
    const r = await fileBug(REPORT, {
      surface: "mcp",
      duplicates: none,
      diagnostics: async () => {
        throw new Error("player gone");
      },
    });
    assert.match(r.report.body, /diagnostics unavailable: player gone/);
  });
});

describe("app hook", () => {
  test("coarseUserAgent", () => {
    assert.equal(
      coarseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.70 Mobile Safari/537.36"),
      "Chrome 129 on Android",
    );
    assert.equal(
      coarseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
      "Safari 17 on iOS",
    );
  });

  test("effect hash, no source; direct filing asks the user and sends the relay token", async () => {
    const source = "uniform float speed;\nfn shade() {}";
    const asked: string[] = [];
    let auth = "";
    let answer = false;
    const hook = appFileBugHook({
      surface: "web-editor",
      source: () => source,
      client: () => null,
      confirm: async (issue) => {
        asked.push(issue.title);
        return answer;
      },
      duplicates: none,
      creds: () => ({ relay: "https://relay.example", token: "spl_pt_abcdefghijklmnopqrst_x" }),
      fetch: async (_url, init) => {
        auth = (init!.headers as Record<string, string>)["authorization"] ?? "";
        return new Response(JSON.stringify({ number: 3, url: "u3" }), { status: 201 });
      },
    });
    const draft = JSON.parse(await hook(REPORT)) as FileBugResult;
    assert.equal(draft.status, "draft");
    assert.ok(draft.report.body.includes(await effectHash(source)));
    assert.ok(!draft.report.body.includes("uniform float speed"));
    assert.match(draft.report.body, /none connected/);

    const declined = JSON.parse(await hook({ ...REPORT, submit: "direct", user_confirmed: true })) as FileBugResult;
    assert.equal(declined.status, "draft");
    assert.equal(declined.direct?.message, "the user chose not to file it");
    assert.equal(auth, "", "nothing sent");

    answer = true;
    const ok = JSON.parse(await hook({ ...REPORT, submit: "direct", user_confirmed: true })) as FileBugResult;
    assert.equal(ok.status, "filed");
    assert.equal(auth, "Bearer spl_pt_abcdefghijklmnopqrst_x");
    assert.equal(asked.length, 2);
  });
});
