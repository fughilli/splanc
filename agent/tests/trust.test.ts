/**
 * Per-device certificate pinning (src/trust.ts, docs/design/per-device-cert.md):
 * the pure TOFU decision, and the hub end to end against fake players — first
 * sight pins by device id, a changed certificate for a known id is refused with a
 * re-trust path (trust_player), the legacy shared certificate re-pins silently, a
 * manifest that lies about the certificate is refused, and a first-boot player
 * that is still generating its identity (mDNS tls=generating) is waited for.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { HubConfig } from "../src/config";
import { resolveTarget } from "../src/discovery";
import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { createServer } from "../src/server";
import { LEGACY_SHARED_CERT_SHA256, decideTrust, isLegacyShared, normFingerprint, trustError, trusted } from "../src/trust";
import { FakePlayer, TEST_CERT2_SHA256, TEST_CERT_SHA256 } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const A = normFingerprint(TEST_CERT_SHA256);
const B = normFingerprint(TEST_CERT2_SHA256);
const MAC = "CC:FD:49:00:AA:01";

before(async () => {
  await loadFxHost(WASM_ROOT);
});

function emptyConfig(): HubConfig {
  return { players: {}, groups: {}, poses: {} };
}

async function player(identity: 1 | 2 = 1, port = 0): Promise<FakePlayer> {
  const p = new FakePlayer({ name: "Porch", mac: MAC, identity });
  await p.start(port);
  p.serveManifest();
  return p;
}

function hubFor(p: FakePlayer, config: HubConfig): Hub {
  return new Hub({
    root: WASM_ROOT,
    hosts: [p.host],
    mdns: false,
    config,
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [] },
  });
}

async function mcp(hub: Hub): Promise<Client> {
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "trust-test", version: "0" });
  await c.connect(b);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
  const text = r.content[0]?.text ?? "";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: r.isError === true, text, json };
}

describe("decideTrust", () => {
  test("first sight, known, changed", () => {
    assert.deepEqual(decideTrust({ id: MAC, presented: A, claimed: A }), { kind: "first-sight", pin: A });
    assert.deepEqual(decideTrust({ id: MAC, presented: A, claimed: A, known: A }), { kind: "known", pin: A });
    assert.deepEqual(decideTrust({ id: MAC, presented: B, claimed: B, known: A }), {
      kind: "changed",
      pin: A,
      presented: B,
    });
  });

  test("the legacy shared certificate re-pins silently, in any spelling", () => {
    const legacyColons = LEGACY_SHARED_CERT_SHA256.toUpperCase().replace(/(..)(?!$)/g, "$1:");
    assert.ok(isLegacyShared(legacyColons));
    const v = decideTrust({ id: MAC, presented: B, claimed: B, known: legacyColons });
    assert.deepEqual(v, { kind: "legacy-repin", pin: B, previous: LEGACY_SHARED_CERT_SHA256 });
    assert.ok(trusted(v));
    assert.equal(trustError("Porch", MAC, v), null);
  });

  test("a manifest claim that differs from the presented certificate is refused", () => {
    const v = decideTrust({ id: MAC, presented: B, claimed: A });
    assert.equal(v.kind, "mismatch");
    assert.ok(!trusted(v));
    assert.match(trustError("Porch", MAC, v) ?? "", /intercepting TLS/);
  });

  test("operator pin wins; nothing to go on is unverified", () => {
    assert.deepEqual(decideTrust({ id: MAC, presented: B, known: A, operatorPin: A }), { kind: "operator", pin: A });
    assert.deepEqual(decideTrust({ presented: A }), { kind: "unverified" });
    assert.deepEqual(decideTrust({ id: MAC }), { kind: "unverified" });
    assert.deepEqual(decideTrust({ id: MAC, known: A }), { kind: "known", pin: A });
  });

  test("the changed-certificate message says how to re-trust after a factory reset", () => {
    const msg = trustError("Porch", MAC, { kind: "changed", pin: A, presented: B }) ?? "";
    assert.match(msg, /certificate changed/);
    assert.match(msg, /factory-reset/);
    assert.match(msg, new RegExp(`trust_player \\{player: "${MAC}"\\}`));
  });
});

describe("hub TOFU", () => {
  const cleanup: FakePlayer[] = [];
  after(async () => {
    for (const p of cleanup) await p.stop().catch(() => undefined);
  });

  test("first sight pins by device id; a factory-reset player is refused until re-trusted", async () => {
    const cfg = emptyConfig();
    let p = await player(1);
    cleanup.push(p);
    let c = await mcp(hubFor(p, cfg));
    // The session that identifies the player is its first sight: pinned by MAC.
    assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
    assert.equal(cfg.players[MAC]?.pin, A, "remembered by device id");
    assert.match((await call(c, "list_players")).json.players[0].tls, /^pinned/);

    // Same device id, new identity (flash erased -> new key + cert), same port.
    const port = p.port;
    await p.stop();
    p = await player(2, port);
    cleanup.push(p);
    c = await mcp(hubFor(p, cfg));
    const refused = await call(c, "set_brightness", { level: 0.5 });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /certificate changed/);
    assert.match(refused.text, /trust_player/);
    assert.equal(cfg.players[MAC]?.pin, A, "a changed certificate never overwrites the pin");
    assert.equal(p.types().length, 0, "nothing was sent to the unverified device");
    const listed = await call(c, "list_players");
    assert.match(listed.json.players[0].tls, /^CHANGED/, JSON.stringify(listed.json));
    // Refused up front from now on.
    assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, true);

    // The user confirms they reset it: re-trust, and it connects.
    const t = await call(c, "trust_player", { player: MAC });
    assert.equal(t.isError, false, t.text);
    assert.equal(t.json.cert_sha256, B);
    assert.equal(cfg.players[MAC]?.pin, B);
    assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
    assert.equal(cfg.players[MAC]?.pin, B);
    // Nothing left to re-trust.
    assert.equal((await call(c, "trust_player", { player: MAC })).isError, true);
  });

  test("a known id answering at a NEW host with another certificate is refused", async () => {
    // TOFU is by device id, not by host: the player's old address is elsewhere.
    const cfg = emptyConfig();
    cfg.players[MAC] = { host: "10.9.9.9", pin: A };
    const p = await player(2);
    cleanup.push(p);
    const c = await mcp(hubFor(p, cfg));
    const r = await call(c, "set_brightness", { level: 0.5 });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /certificate changed/);
    assert.equal(cfg.players[MAC]?.pin, A);
  });

  test("a player remembered with the legacy shared certificate re-pins silently", async () => {
    const cfg = emptyConfig();
    const p = await player(1);
    cleanup.push(p);
    cfg.players[MAC] = { host: p.host, name: "Porch", pin: LEGACY_SHARED_CERT_SHA256 };
    const logs: string[] = [];
    const hub = new Hub({
      root: WASM_ROOT,
      hosts: [p.host],
      mdns: false,
      config: cfg,
      persist: () => undefined,
      registryDeps: { sweepHosts: () => [] },
      log: (...a) => logs.push(a.join(" ")),
    });
    const c = await mcp(hub);
    const r = await call(c, "set_brightness", { level: 0.5 });
    assert.equal(r.isError, false, r.text);
    assert.equal(cfg.players[MAC]?.pin, A);
    assert.match((await call(c, "list_players")).json.players[0].tls, /^pinned/);
    assert.ok(logs.some((l) => /own TLS certificate/.test(l)), logs.join("\n"));
  });

  test("a manifest naming a different certificate than the connection's is refused", async () => {
    const p = await player(2);
    cleanup.push(p);
    p.serveManifest({ tls: { cert_sha256: TEST_CERT_SHA256, state: "ready" } });
    const t = await resolveTarget(p.host, { knownPin: () => undefined });
    assert.equal(t.trust?.kind, "mismatch");
    assert.match(trustError("Porch", MAC, t.trust!) ?? "", /intercepting TLS/);
    // A matching manifest: first sight, pinned to what the GET presented.
    p.serveManifest();
    const first = await resolveTarget(p.host, { knownPin: () => undefined });
    assert.deepEqual(first.trust, { kind: "first-sight", pin: B });
    assert.equal(first.tls.pinSha256, B);
    // ...and judged against the pin remembered for the id the manifest names.
    const known = await resolveTarget(p.host, { knownPin: (id) => (id === MAC ? A : undefined) });
    assert.deepEqual(known.trust, { kind: "changed", pin: A, presented: B });
    assert.equal(known.tls.pinSha256, A, "a refused verdict still pins the REMEMBERED cert");
  });

  test("a first-boot player still generating its identity is waited for", async () => {
    // :443 is closed while the device generates its key (the firmware never accepts
    // a handshake without a cert); its mDNS advert says tls=generating.
    const p = await player(1);
    cleanup.push(p);
    const port = p.port;
    await p.stop();
    const started = Date.now();
    setTimeout(() => void p.start(port), 400);
    const t = await resolveTarget(p.host, { waitGeneratingMs: 10000, retryMs: 100, timeoutMs: 2000 });
    assert.ok(t.reachable, t.manifestError);
    assert.equal(t.manifest?.tls?.state, "ready");
    assert.equal(t.trust?.kind, "first-sight");
    assert.ok(Date.now() - started >= 350);
    // Without the generating hint, an unreachable host fails fast (no waiting).
    await p.stop();
    const t0 = Date.now();
    const gone = await resolveTarget(p.host, { timeoutMs: 1000 });
    assert.equal(gone.reachable, false);
    assert.ok(Date.now() - t0 < 1500);
  });

  test("manifest reads wait only for hosts whose advert says tls=generating", async () => {
    const p = await player(1);
    cleanup.push(p);
    const seen: { host: string; wait: number | undefined }[] = [];
    const hub = new Hub({
      root: WASM_ROOT,
      mdns: true,
      config: emptyConfig(),
      persist: () => undefined,
      registryDeps: {
        sweepHosts: () => [],
        browse: async () => [
          {
            instance: "Porch._splanc._tcp.local",
            host: "x.local",
            port: p.port,
            addresses: ["127.0.0.1"],
            txt: { tls: "generating" },
          },
        ],
        resolve: async (host, opts) => {
          seen.push({ host, wait: opts.waitGeneratingMs });
          return resolveTarget(host, { ...opts, waitGeneratingMs: 0 });
        },
      },
    });
    await hub.refresh({ fresh: true });
    assert.deepEqual(seen, [{ host: p.host, wait: 30000 }]);
  });
});
