/**
 * Per-client management on the relay (docs/design/cloud-relay.md, "Paired
 * clients"): the grant list in `hello` and in `grants` frames (only to a bridge
 * whose `caps` asked), labels and kinds (OAuth connector, the app, a personal
 * token, grants from before grant records), `revoke_grant` (every token of that
 * grant refused afterwards, refresh too; its live sockets closed; other grants
 * untouched), last-used throttling, and that only the bridge's own socket can
 * list or revoke.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import WebSocket from "ws";

import { LAST_USED_WRITE_S, clientLabel } from "../relay/src/bridgeObject";
import type { ErrorFrame, GrantInfo, GrantsFrame, LiveOpenFrame, RelayFrame, RevokedFrame, StateFrame } from "../relay/src/protocol";
import { RelayLink } from "../src/bridge/relayLink";
import { RelayHost } from "../src/relayHost";
import { REDIRECT, connectorFlow, mcpPost, tempIdentity, tokenRequest, until } from "./relayHelpers";

let offsetMs = 0;
const host = new RelayHost({ trustProxy: true, now: () => Date.now() + offsetMs });
let relay = "";

before(async () => {
  relay = await host.listen();
});
after(async () => {
  await host.close();
});

function resetLimits(): void {
  const dir = host.storageOf("directory", "global");
  for (const k of [...(dir?.keys() ?? [])]) if (k.startsWith("rl:")) dir!.delete(k);
}

interface Bridge {
  link: RelayLink;
  frames: RelayFrame[];
  /** The newest client list a `grants` frame brought. */
  latest: () => GrantInfo[] | null;
}

/** A bridge on the real RelayLink that answers every tunnelled request; `grants`:
 * its caps ask for the client list (a new bridge) or not (an older one). */
async function bridge(grants = true): Promise<Bridge> {
  resetLimits();
  const { identity } = tempIdentity();
  const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
  const frames: RelayFrame[] = [];
  link.onFrame = (f) => {
    frames.push(f);
    if (f.t === "hello") link.send({ t: "caps", live: 1, ...(grants ? { grants: 1 } : {}) });
    if (f.t === "req") {
      link.send({
        t: "res",
        id: f.id,
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        end: true,
      });
    }
  };
  link.start();
  await until(() => link.online, "bridge online");
  const latest = () => {
    const g = frames.filter((f): f is GrantsFrame => f.t === "grants").at(-1);
    return g ? g.grants : null;
  };
  return { link, frames, latest };
}

async function code(b: Bridge): Promise<string> {
  const n = b.frames.length;
  b.link.send({ t: "new_code" });
  const f = await until(() => b.frames.slice(n).find((x): x is StateFrame => x.t === "state" && x.pairing !== null), "code");
  return f.pairing!.code;
}

async function pairToken(b: Bridge, body: Record<string, string>): Promise<string> {
  const r = await fetch(`${relay}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pairing_code: await code(b), ...body }),
  });
  assert.equal(r.status, 200);
  return ((await r.json()) as { token: string }).token;
}

const call = (tok: string) => mcpPost(relay, tok, { jsonrpc: "2.0", id: 1, method: "ping" });

function openLive(token: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const ws = new WebSocket(`${relay.replace(/^http/, "ws")}/live`, ["splanc-live.v1", `bearer.${token}`]);
  const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, closed }));
    ws.on("unexpected-response", (_q, res) => {
      res.resume();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.on("error", () => undefined);
  });
}

const byLabel = (list: GrantInfo[] | null | undefined, label: string) => list?.find((g) => g.label === label);

describe("clientLabel", () => {
  test("a dynamic registration's own name, a metadata document's host, else generic", () => {
    const payload = Buffer.from(JSON.stringify({ r: [REDIRECT], n: "Claude", a: "none" })).toString("base64url");
    assert.equal(clientLabel(`dcr.${payload}.sig`), "Claude");
    assert.equal(clientLabel("https://chatgpt.com/oauth/client.json"), "chatgpt.com");
    assert.equal(clientLabel("personal"), "Personal token");
    assert.equal(clientLabel("dcr.!!!.x"), "Connector");
  });
});

describe("the client list", () => {
  test("hello carries it; caps grants:1 gets `grants` frames with label, kind, created", async () => {
    const b = await bridge();
    try {
      const hello = b.frames.find((f) => f.t === "hello");
      assert.ok(hello && hello.t === "hello");
      assert.deepEqual(hello.grants, []);
      await until(() => b.latest() !== null, "grants after caps");
      const t0 = Math.floor((Date.now() + offsetMs) / 1000);
      await connectorFlow(relay, await code(b));
      await pairToken(b, { label: "Kevin's iPhone", client: "app" });
      await pairToken(b, { label: "" });
      const list = await until(() => (b.latest()?.length === 3 ? b.latest() : null), "three clients");
      const conn = byLabel(list, "Test Agent")!;
      assert.equal(conn.kind, "connector");
      assert.ok(conn.created_at >= t0 - 1);
      assert.equal(conn.last_used_at, null);
      assert.equal(byLabel(list, "Kevin's iPhone")?.kind, "app");
      assert.equal(byLabel(list, "Personal token")?.kind, "token");
      // Oldest first; ids are opaque and distinct; the count matches.
      assert.ok(list.every((g, i) => i === 0 || list[i - 1]!.created_at <= g.created_at));
      assert.equal(new Set(list.map((g) => g.id)).size, 3);
      assert.equal(b.link.credentials, 3);
      // list_grants answers on demand.
      const n = b.frames.length;
      b.link.send({ t: "list_grants" });
      const f = await until(() => b.frames.slice(n).find((x): x is GrantsFrame => x.t === "grants"), "list_grants reply");
      assert.equal(f.grants.length, 3);
      // A reconnect's hello carries the list too.
      assert.equal(b.link.grants?.length, 3);
      assert.equal(b.link.grantsSupported, true);
    } finally {
      b.link.stop();
    }
  });

  test("an older bridge (no grants in caps) never gets a `grants` frame", async () => {
    const b = await bridge(false);
    try {
      await connectorFlow(relay, await code(b));
      await until(() => b.link.credentials === 1, "paired");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(b.frames.filter((f) => f.t === "grants").length, 0);
    } finally {
      b.link.stop();
    }
  });

  test("a grant from before grant records is listed from its token, and gets a record when used", async () => {
    const b = await bridge();
    try {
      const tok = await pairToken(b, { label: "old curl" });
      const store = host.storageOf("bridge", b.link.bridgeId!)!;
      const key = [...store.keys()].find((k) => k.startsWith("grant:"))!;
      store.delete(key); // as an older relay left it
      b.link.send({ t: "list_grants" });
      const g = await until(() => byLabel(b.latest(), "old curl"), "legacy listed");
      assert.equal(g.kind, "token");
      assert.equal(g.last_used_at, null);
      assert.equal((await call(tok)).status, 200);
      await until(() => byLabel(b.latest(), "old curl")?.last_used_at, "used");
      assert.ok(store.has(key));
    } finally {
      b.link.stop();
    }
  });

  test("a personal token that opens a live session is listed as the app (older apps)", async () => {
    const b = await bridge();
    try {
      const tok = await pairToken(b, { label: "Splanc app (iPhone)" });
      await until(() => byLabel(b.latest(), "Splanc app (iPhone)")?.kind === "token", "token first");
      const app = await openLive(tok);
      await until(() => byLabel(b.latest(), "Splanc app (iPhone)")?.kind === "app", "app after live");
      app.ws.close();
    } finally {
      b.link.stop();
    }
  });
});

describe("last used", () => {
  test("written on use at most once a minute per grant; refresh counts; pushed to the bridge", async () => {
    const b = await bridge();
    try {
      const { client, tokens } = await connectorFlow(relay, await code(b));
      const store = host.storageOf("bridge", b.link.bridgeId!)!;
      const recOf = () => {
        const k = [...store.keys()].find((x) => x.startsWith("grant:"))!;
        return store.get(k) as { last_used: number | null };
      };
      assert.equal(recOf().last_used, null);
      assert.equal((await call(tokens["access_token"]!)).status, 200);
      const first = recOf().last_used!;
      assert.ok(first > 0);
      await until(() => b.latest()?.[0]?.last_used_at === first, "pushed");
      const pushes = () => b.frames.filter((f) => f.t === "grants" && f.reason === "client used").length;
      const p0 = pushes();
      // Within the minute: no write, no push.
      offsetMs += 30_000;
      for (let i = 0; i < 5; i++) assert.equal((await call(tokens["access_token"]!)).status, 200);
      assert.equal(recOf().last_used, first);
      assert.equal(pushes(), p0);
      // A minute after the last write: written (and pushed) again.
      offsetMs += (LAST_USED_WRITE_S - 30 + 1) * 1000;
      assert.equal((await call(tokens["access_token"]!)).status, 200);
      const second = recOf().last_used!;
      assert.ok(second >= first + LAST_USED_WRITE_S, `${second} vs ${first}`);
      await until(() => pushes() === p0 + 1, "second push");
      // A refresh is a use too.
      offsetMs += (LAST_USED_WRITE_S + 1) * 1000;
      const r = await tokenRequest(relay, { grant_type: "refresh_token", refresh_token: tokens["refresh_token"]!, client_id: client["client_id"]! });
      assert.equal(r.status, 200);
      assert.ok(recOf().last_used! > second);
    } finally {
      b.link.stop();
    }
  });
});

describe("revoke one client", () => {
  test("its access and refresh tokens are refused, its live sockets close, the others keep working", async () => {
    const b = await bridge();
    try {
      const { client, tokens } = await connectorFlow(relay, await code(b));
      const appTok = await pairToken(b, { label: "Phone", client: "app" });
      const keepTok = await pairToken(b, { label: "Laptop" });
      const list = await until(() => (b.latest()?.length === 3 ? b.latest() : null), "three");
      const conn = byLabel(list, "Test Agent")!;
      const phone = byLabel(list, "Phone")!;
      assert.equal((await call(tokens["access_token"]!)).status, 200);

      let n = b.frames.length;
      b.link.send({ t: "revoke_grant", grant: conn.id });
      await until(() => b.frames.slice(n).find((f): f is RevokedFrame => f.t === "revoked" && f.grants.includes(conn.id)), "revoked");
      await until(() => (b.latest()?.length === 2 && !byLabel(b.latest(), "Test Agent") ? true : null), "list without it");
      await until(() => b.link.credentials === 2, "count");
      assert.equal((await call(tokens["access_token"]!)).status, 401);
      const r = await tokenRequest(relay, { grant_type: "refresh_token", refresh_token: tokens["refresh_token"]!, client_id: client["client_id"]! });
      assert.equal(r.status, 400);
      assert.equal(r.json["error"], "invalid_grant");
      assert.equal((await call(keepTok)).status, 200);

      // The app: its live socket is closed with 4003 and its token refused.
      const app = await openLive(appTok);
      await until(() => b.frames.find((f): f is LiveOpenFrame => f.t === "live_open" && f.grant === phone.id), "live_open");
      n = b.frames.length;
      b.link.send({ t: "revoke_grant", grant: phone.id });
      assert.equal(await app.closed, 4003);
      await until(() => b.frames.slice(n).some((f) => f.t === "revoked" && f.grants.includes(phone.id)), "revoked phone");
      assert.equal((await call(appTok)).status, 401);
      assert.equal((await call(keepTok)).status, 200);
    } finally {
      b.link.stop();
    }
  });

  test("an unknown id gets an error frame naming it; nothing is revoked", async () => {
    const b = await bridge();
    try {
      const tok = await pairToken(b, { label: "Laptop" });
      const n = b.frames.length;
      b.link.send({ t: "revoke_grant", grant: "nope" });
      const e = await until(() => b.frames.slice(n).find((f): f is ErrorFrame => f.t === "error" && f.for === "revoke_grant"), "error");
      assert.equal(e.grant, "nope");
      assert.equal((await call(tok)).status, 200);
    } finally {
      b.link.stop();
    }
  });
});

describe("authorization", () => {
  test("another bridge can't list or revoke this bridge's clients; an app socket can't either", async () => {
    const a = await bridge();
    const other = await bridge();
    try {
      const tok = await pairToken(a, { label: "A's phone", client: "app" });
      const g = await until(() => byLabel(a.latest(), "A's phone"), "listed on A");
      // B's list is its own (empty), and B naming A's grant id is an unknown id.
      other.link.send({ t: "list_grants" });
      await until(() => other.frames.filter((f) => f.t === "grants").length >= 2, "B's list");
      assert.deepEqual(other.latest(), []);
      const n = other.frames.length;
      other.link.send({ t: "revoke_grant", grant: g.id });
      await until(() => other.frames.slice(n).some((f) => f.t === "error" && f.for === "revoke_grant"), "refused on B");
      assert.equal((await call(tok)).status, 200);
      // An app's live socket speaks verbatim pass-through: a control frame from it
      // is just a live message for the bridge.
      const app = await openLive(tok);
      app.ws.send(JSON.stringify({ t: "revoke_grant", grant: g.id }));
      app.ws.send(JSON.stringify({ t: "list_grants" }));
      await until(() => a.frames.some((f) => f.t === "live" && f.d.includes("revoke_grant")), "passed through");
      assert.equal((await call(tok)).status, 200);
      assert.ok(byLabel(a.latest(), "A's phone"));
      app.ws.close();
    } finally {
      a.link.stop();
      other.link.stop();
    }
  });
});
