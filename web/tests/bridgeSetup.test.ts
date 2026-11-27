/**
 * "Set up a bridge" (#698): the flow's state machine (net/bridgeSetup.ts, pure) and its
 * runner (ui/screens/bridgeSetupRun.ts) against a scripted bridge: no radio, LAN or relay.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyPairError,
  codeShowing,
  failureCopy,
  formatPairingCode,
  initialState,
  nextAction,
  parseHealth,
  pairingCodeComplete,
  reduce,
  stageText,
  type SetupEvent,
  type SetupState,
} from "../src/net/bridgeSetup";
import { ImprovError } from "../src/net/improv";
import type { LanHealth } from "../src/net/liveProtocol";
import { BridgeSetupRunner, joinFailure, type BridgeSetupIO, type PairedWelcome } from "../src/ui/screens/bridgeSetupRun";
import { PairError } from "../src/net/bridgeLive";

const SHA = "ab".repeat(32);
const IP = "192.168.1.68";
const NOW_S = 1_800_000_000;

const health = (over: Partial<LanHealth> = {}): LanHealth => ({
  ok: true,
  live: 1,
  sha256: SHA,
  state: "pairing",
  relay: "https://relay.example",
  relay_online: true,
  relay_error: null,
  code_expires_at: NOW_S + 300,
  ...over,
});

function run(s: SetupState, ...evs: SetupEvent[]): SetupState {
  return evs.reduce(reduce, s);
}

/** Started, Wi-Fi sent, joined: the agent stage is next. */
function joined(opts: { hasCreds?: boolean; knownSha?: string } = {}): SetupState {
  return run(
    initialState({ hasCreds: opts.hasCreds ?? false, knownSha: opts.knownSha ?? null }),
    { t: "start" },
    { t: "send-wifi", ssid: "Home" },
    { t: "joined", ip: IP, ssid: "Home" },
  );
}

// -- the state machine -----------------------------------------------------------------

test("a fresh bridge: Wi-Fi, running, relay, a code on its screen, then paired", () => {
  let s = initialState({ hasCreds: false });
  assert.equal(s.step, "intro");
  s = reduce(s, { t: "start" });
  assert.equal(s.step, "wifi");
  s = reduce(s, { t: "send-wifi", ssid: "Home" });
  assert.equal(s.step, "checking");
  assert.deepEqual(s.stages, { wifi: "active", agent: "todo", relay: "todo", ready: "todo" });
  assert.deepEqual(nextAction(s), { kind: "none" }); // Improv is the screen's (gesture)
  s = reduce(s, { t: "joined", ip: IP, ssid: "Home" });
  assert.equal(s.stages.wifi, "ok");
  assert.deepEqual(nextAction(s), { kind: "probe-agent", ip: IP });
  // Up, but still connecting to the relay.
  s = reduce(s, { t: "health", health: health({ state: "starting", relay_online: false, code_expires_at: null }) });
  assert.equal(s.stages.agent, "ok");
  assert.equal(s.stages.relay, "active");
  assert.deepEqual(nextAction(s), { kind: "poll-relay", ip: IP });
  s = reduce(s, { t: "health", health: health() });
  assert.equal(s.step, "pair");
  assert.deepEqual(s.stages, { wifi: "ok", agent: "ok", relay: "ok", ready: "ok" });
  assert.ok(codeShowing(s.health, NOW_S));
  assert.equal(stageText(s, "ready", NOW_S).detail, "A pairing code is on its screen.");
  assert.equal(s.pairNote, null);
  assert.deepEqual(nextAction(s), { kind: "watch-code", ip: IP });
  s = reduce(s, { t: "pair-submit" });
  assert.ok(s.pairBusy);
  assert.deepEqual(nextAction(s), { kind: "none" });
  s = reduce(s, { t: "paired", players: ["Kitchen"] });
  assert.equal(s.step, "paired");
  assert.deepEqual(s.players, ["Kitchen"]);
  assert.ok(s.hasCreds);
});

test("an already-paired bridge on a new network: back online, still paired", () => {
  let s = joined({ hasCreds: true, knownSha: SHA });
  s = reduce(s, { t: "health", health: health({ state: "paired", code_expires_at: null }) });
  assert.equal(s.step, "checking");
  assert.equal(s.stages.ready, "active");
  assert.equal(stageText(s, "ready", NOW_S).title, "Still paired");
  assert.deepEqual(nextAction(s), { kind: "check-paired" });
  s = reduce(s, { t: "welcome", players: ["Living Room", "Kitchen"], sha256: SHA.toUpperCase() });
  assert.equal(s.step, "moved");
  assert.deepEqual(s.players, ["Living Room", "Kitchen"]);
  assert.equal(stageText(s, "ready", NOW_S).detail, "It's back online and this app is still paired with it.");
});

test("the app is paired with a different bridge: pair this one (replaces)", () => {
  // Known by certificate before connecting...
  let s = reduce(joined({ hasCreds: true, knownSha: "cd".repeat(32) }), { t: "health", health: health({ state: "paired" }) });
  assert.equal(s.step, "pair");
  assert.equal(s.pairNote, "replaces");
  // ...or by the welcome's certificate.
  s = reduce(joined({ hasCreds: true }), { t: "health", health: health({ state: "paired" }) });
  assert.equal(s.stages.ready, "active");
  s = reduce(s, { t: "welcome", players: [], sha256: "cd".repeat(32) });
  assert.equal(s.step, "pair");
  assert.equal(s.pairNote, "replaces");
});

test("the bridge has nobody paired although this app has credentials: pair (replaces)", () => {
  const s = reduce(joined({ hasCreds: true, knownSha: SHA }), { t: "health", health: health({ state: "unpaired", code_expires_at: null }) });
  assert.equal(s.step, "pair");
  assert.equal(s.pairNote, "replaces");
  assert.match(stageText(s, "ready", NOW_S).detail, /Ready for a pairing code/);
});

test("a revoked credential: pair again", () => {
  let s = reduce(joined({ hasCreds: true }), { t: "health", health: health({ state: "paired" }) });
  s = reduce(s, { t: "revoked" });
  assert.equal(s.step, "pair");
  assert.equal(s.pairNote, "revoked");
  assert.equal(s.hasCreds, false);
});

test("a browser that can't read healthz: the stages end 'later' and pairing confirms them", () => {
  let s = reduce(joined(), { t: "agent-timeout", certain: false });
  assert.equal(s.step, "pair");
  assert.equal(s.stages.agent, "later");
  assert.equal(s.stages.relay, "later");
  assert.match(stageText(s, "relay", NOW_S).detail, /when you pair/);
  assert.deepEqual(nextAction(s), { kind: "none" }); // nothing to watch
  s = run(s, { t: "pair-submit" }, { t: "paired", players: null });
  assert.deepEqual(s.stages, { wifi: "ok", agent: "ok", relay: "ok", ready: "ok" });
  // Paired before, in a browser: the relay's welcome is the check.
  s = reduce(joined({ hasCreds: true }), { t: "agent-timeout", certain: false });
  assert.deepEqual(nextAction(s), { kind: "check-paired" });
  s = reduce(s, { t: "welcome", players: [], sha256: SHA });
  assert.equal(s.step, "moved");
  assert.equal(s.stages.agent, "ok");
});

test("a bridge from before #698 (no relay field): relay checked at pairing", () => {
  const s = reduce(joined(), { t: "health", health: { ok: true, live: 1, sha256: SHA } });
  assert.equal(s.step, "pair");
  assert.equal(s.stages.agent, "ok");
  assert.equal(s.stages.relay, "later");
});

test("failures each have a next step, and retry resumes at the failed stage", () => {
  const wifi = (kind: "join-refused" | "not-found" | "join-timeout" | "bluetooth") =>
    reduce(reduce(reduce(initialState({ hasCreds: false }), { t: "start" }), { t: "send-wifi", ssid: "Home" }), { t: "join-failed", kind });
  for (const k of ["join-refused", "not-found", "join-timeout", "bluetooth"] as const) {
    const s = wifi(k);
    assert.equal(s.step, "failed");
    assert.equal(s.stages.wifi, "failed");
    assert.equal(failureCopy(s).primary.id, "edit-wifi", k);
    assert.equal(reduce(s, { t: "retry" }).step, "wifi");
  }
  assert.match(failureCopy(wifi("join-refused")).text, /went back to the networks it already knew/);

  // Native app, nothing at its address.
  let s = reduce(joined(), { t: "agent-timeout", certain: true });
  assert.equal(s.failure?.kind, "agent-unreachable");
  assert.equal(s.stages.agent, "failed");
  assert.equal(failureCopy(s).primary.id, "retry");
  s = reduce(s, { t: "retry" });
  assert.equal(s.step, "checking");
  assert.deepEqual(s.stages, { wifi: "ok", agent: "active", relay: "todo", ready: "todo" });
  assert.deepEqual(nextAction(s), { kind: "probe-agent", ip: IP });

  // Relay blocked from the bridge's network (this phone reaches it) vs no internet at all.
  const offline = reduce(joined(), { t: "health", health: health({ state: "offline", relay_online: false, relay_error: "ETIMEDOUT" }) });
  s = reduce(offline, { t: "relay-timeout", phoneReachesRelay: true });
  assert.equal(s.failure?.kind, "relay-blocked");
  assert.equal(s.failure?.detail, "ETIMEDOUT");
  assert.match(failureCopy(s).text, /relay\.example/);
  s = reduce(s, { t: "retry" });
  assert.deepEqual(s.stages, { wifi: "ok", agent: "ok", relay: "active", ready: "todo" });
  assert.equal(reduce(offline, { t: "relay-timeout", phoneReachesRelay: false }).failure?.kind, "no-internet");

  // Its bridge service in an error state.
  assert.equal(reduce(joined(), { t: "health", health: health({ state: "error" }) }).failure?.kind, "bridge-error");

  // Paired before, and the relay never heard from it.
  const moved = reduce(joined({ hasCreds: true }), { t: "health", health: health({ state: "paired" }) });
  s = reduce(moved, { t: "welcome-timeout", phoneReachesRelay: true });
  assert.equal(s.failure?.kind, "not-back-online");
  assert.equal(stageText(s, "ready", NOW_S).title, "Still paired");
  assert.equal(reduce(moved, { t: "welcome-timeout", phoneReachesRelay: false }).failure?.kind, "no-internet");
  assert.deepEqual(nextAction(reduce(s, { t: "retry" })), { kind: "check-paired" });

  // A fixture answered: it joined; connect to it instead.
  s = run(initialState({ hasCreds: false }), { t: "start" }, { t: "send-wifi", ssid: "Home" }, { t: "not-a-bridge", address: "wss://192.168.1.77/ws" });
  assert.equal(s.failure?.kind, "not-a-bridge");
  assert.equal(s.fixtureAddress, "wss://192.168.1.77/ws");
  assert.equal(failureCopy(s).primary.id, "connect-fixture");
});

test("cancelling the join goes back to the Wi-Fi details", () => {
  const s = run(initialState({ hasCreds: false }), { t: "start" }, { t: "send-wifi", ssid: "Home" }, { t: "cancelled" });
  assert.equal(s.step, "wifi");
  assert.deepEqual(s.stages, { wifi: "todo", agent: "todo", relay: "todo", ready: "todo" });
});

test("the hand-off from the fixture flow starts at the agent stage", () => {
  const s = initialState({ hasCreds: false, joined: { ip: IP, ssid: "Home" } });
  assert.equal(s.step, "checking");
  assert.equal(s.stages.wifi, "ok");
  assert.deepEqual(nextAction(s), { kind: "probe-agent", ip: IP });
});

test("pair errors stay on the pair step with a message; stale events are ignored", () => {
  let s = reduce(joined(), { t: "health", health: health() });
  s = run(s, { t: "pair-submit" }, { t: "pair-failed", ...classifyPairError({ code: "invalid_grant" }) });
  assert.equal(s.step, "pair");
  assert.equal(s.pairBusy, false);
  assert.equal(s.pairError?.kind, "code-invalid");
  assert.match(s.pairError!.message, /KEY1/);
  // A late healthz answer from the agent probe can't drag the flow back.
  const again = reduce(s, { t: "agent-timeout", certain: true });
  assert.equal(again, s);
  assert.equal(classifyPairError({ code: "slow_down" }).kind, "code-rate");
  assert.equal(classifyPairError({ code: "invalid_request" }).kind, "code-format");
  assert.equal(classifyPairError(null).kind, "relay-unreachable");
  assert.equal(classifyPairError({ code: "http_500", message: "pairing failed (HTTP 500)" }).kind, "other");
});

test("pairing code input", () => {
  assert.equal(formatPairingCode("abcd"), "ABCD");
  assert.equal(formatPairingCode("abcdefgh"), "ABCD-EFGH");
  assert.equal(formatPairingCode(" ab cd-ef gh ij"), "ABCD-EFGH");
  assert.ok(pairingCodeComplete("abcd efgh"));
  assert.ok(!pairingCodeComplete("ABCD-EFG"));
  assert.ok(!codeShowing(health({ code_expires_at: NOW_S - 1 }), NOW_S));
  assert.ok(!codeShowing(health({ state: "unpaired" }), NOW_S));
});

test("Improv failures from a bridge", () => {
  assert.deepEqual(joinFailure(new ImprovError("unable-to-connect", "x")), { t: "join-failed", kind: "join-refused", detail: "x" });
  assert.deepEqual(joinFailure(new ImprovError("wrong-password", "x")), { t: "join-failed", kind: "join-refused", detail: "x" });
  assert.equal((joinFailure(new ImprovError("not-found", "x")) as { kind: string }).kind, "not-found");
  assert.equal((joinFailure(new ImprovError("timeout", "x")) as { kind: string }).kind, "join-timeout");
  assert.deepEqual(joinFailure(new ImprovError("cancelled", "x")), { t: "cancelled" });
  assert.equal((joinFailure(new Error("GATT Server is disconnected")) as { kind: string }).kind, "bluetooth");
});

test("healthz parsing", () => {
  assert.deepEqual(parseHealth(JSON.stringify(health())), health());
  assert.equal(parseHealth("{}"), null);
  assert.equal(parseHealth("not json"), null);
  assert.equal(parseHealth(JSON.stringify({ ok: true, live: 1 })), null);
});

// -- the runner --------------------------------------------------------------------------

interface Script {
  urls?: string[];
  provisionError?: unknown;
  healths?: (LanHealth | null)[];
  certain?: boolean;
  phoneReachesRelay?: boolean;
  paired?: PairedWelcome | "revoked" | "timeout";
  pairError?: unknown;
}

function fakeIO(sc: Script) {
  let clock = 0;
  let i = 0;
  const calls: string[] = [];
  const io: BridgeSetupIO = {
    provision: async () => {
      calls.push("provision");
      if (sc.provisionError) throw sc.provisionError;
      return sc.urls ?? [`http://${IP}/#splanc-bridge`];
    },
    readHealth: async (ip) => {
      calls.push(`health ${ip}`);
      const list = sc.healths ?? [];
      const h = list[Math.min(i++, list.length - 1)] ?? null;
      return h;
    },
    healthCertain: sc.certain ?? true,
    relayReachable: async (relay) => {
      calls.push(`relay? ${relay}`);
      return sc.phoneReachesRelay ?? true;
    },
    checkPaired: async () => {
      calls.push("checkPaired");
      return sc.paired ?? "timeout";
    },
    pair: async (relay, code, label) => {
      calls.push(`pair ${relay} ${code} ${label}`);
      if (sc.pairError) throw sc.pairError;
    },
    confirmPaired: async () => ["Kitchen"],
    defaultRelay: "https://default.example",
    credsRelay: null,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setImmediate(r));
    },
  };
  return { io, calls };
}

async function settle(r: BridgeSetupRunner, until: (s: SetupState) => boolean, n = 500): Promise<void> {
  for (let k = 0; k < n && !until(r.state); k++) await new Promise((res) => setImmediate(res));
  assert.ok(until(r.state), `stuck at ${r.state.step} ${JSON.stringify(r.state.stages)}`);
}

const device = { id: "d", name: "splanc-bridge", gatt: {} } as never;

test("runner: a fresh bridge end to end, pairing at the relay healthz names", async () => {
  const { io, calls } = fakeIO({
    healths: [null, health({ state: "starting", relay_online: false, code_expires_at: null }), health({ relay: "https://bridge-relay.example" })],
  });
  const r = new BridgeSetupRunner(io, { hasCreds: false });
  r.start();
  r.dispatch({ t: "start" });
  await r.sendWifi(device, { ssid: "Home", password: "pw" });
  await settle(r, (s) => s.step === "pair");
  assert.deepEqual(r.state.stages, { wifi: "ok", agent: "ok", relay: "ok", ready: "ok" });
  await r.pair("ABCD-EFGH", "Kim's phone");
  assert.equal(r.state.step, "paired");
  assert.deepEqual(r.state.players, ["Kitchen"]);
  assert.ok(calls.includes("pair https://bridge-relay.example ABCD-EFGH Kim's phone"), calls.join("\n"));
  r.dispose();
});

test("runner: relay blocked from the bridge -> asks whether this phone reaches the relay", async () => {
  const { io, calls } = fakeIO({ healths: [health({ state: "offline", relay_online: false, relay_error: "ECONNREFUSED" })], phoneReachesRelay: true });
  const r = new BridgeSetupRunner(io, { hasCreds: false, joined: { ip: IP, ssid: "Guest" } });
  r.start();
  await settle(r, (s) => s.step === "failed");
  assert.equal(r.state.failure?.kind, "relay-blocked");
  assert.ok(calls.includes("relay? https://relay.example"));
  // Retry: now it's connected.
  r.dispatch({ t: "retry" });
  r.dispose();
});

test("runner: native, nothing answers -> agent-unreachable; browser -> pair with 'later'", async () => {
  {
    const { io } = fakeIO({ healths: [null], certain: true });
    const r = new BridgeSetupRunner(io, { hasCreds: false, joined: { ip: IP, ssid: "Home" } });
    r.start();
    await settle(r, (s) => s.step === "failed");
    assert.equal(r.state.failure?.kind, "agent-unreachable");
    r.dispose();
  }
  {
    const { io } = fakeIO({ healths: [null], certain: false });
    const r = new BridgeSetupRunner(io, { hasCreds: false, joined: { ip: IP, ssid: "Home" } });
    r.start();
    await settle(r, (s) => s.step === "pair");
    assert.equal(r.state.stages.agent, "later");
    r.dispose();
  }
});

test("runner: already paired -> back online; revoked -> pair; silent -> not back online", async () => {
  const paired = health({ state: "paired", code_expires_at: null });
  for (const [answer, step, extra] of [
    [{ players: ["Hall"], sha256: SHA }, "moved", null],
    ["revoked", "pair", "revoked"],
    ["timeout", "failed", "not-back-online"],
  ] as const) {
    const { io } = fakeIO({ healths: [paired], paired: answer as PairedWelcome | "revoked" | "timeout" });
    const r = new BridgeSetupRunner(io, { hasCreds: true, knownSha: SHA, joined: { ip: IP, ssid: "New" } });
    r.start();
    await settle(r, (s) => s.step === step);
    if (extra === "revoked") assert.equal(r.state.pairNote, "revoked");
    if (extra === "not-back-online") assert.equal(r.state.failure?.kind, "not-back-online");
    if (step === "moved") assert.deepEqual(r.state.players, ["Hall"]);
    r.dispose();
  }
});

test("runner: Improv outcomes (refused, a fixture answered, cancelled)", async () => {
  {
    const { io } = fakeIO({ provisionError: new ImprovError("unable-to-connect", "unable to connect") });
    const r = new BridgeSetupRunner(io, { hasCreds: false });
    r.dispatch({ t: "start" });
    await r.sendWifi(device, { ssid: "Home", password: "bad" });
    assert.equal(r.state.failure?.kind, "join-refused");
    r.dispose();
  }
  {
    const { io } = fakeIO({ urls: ["http://192.168.1.77/"] });
    const r = new BridgeSetupRunner(io, { hasCreds: false });
    r.dispatch({ t: "start" });
    await r.sendWifi(device, { ssid: "Home", password: "pw" });
    assert.equal(r.state.failure?.kind, "not-a-bridge");
    assert.equal(r.state.fixtureAddress, "wss://192.168.1.77/ws");
    r.dispose();
  }
  {
    const { io } = fakeIO({ provisionError: new ImprovError("cancelled", "stopped") });
    const r = new BridgeSetupRunner(io, { hasCreds: false });
    r.dispatch({ t: "start" });
    await r.sendWifi(device, { ssid: "Home", password: "pw" });
    assert.equal(r.state.step, "wifi");
    r.dispose();
  }
});

test("runner: a wrong code stays on the pair step; a network failure says the relay", async () => {
  const { io } = fakeIO({ healths: [health()], pairError: new PairError("invalid_grant", "That code isn't valid or has expired.") });
  const r = new BridgeSetupRunner(io, { hasCreds: false, joined: { ip: IP, ssid: "Home" } });
  r.start();
  await settle(r, (s) => s.step === "pair");
  await r.pair("ZZZZ-ZZZZ", "phone");
  assert.equal(r.state.step, "pair");
  assert.equal(r.state.pairError?.kind, "code-invalid");
  r.dispose();

  const net = fakeIO({ healths: [health()], pairError: new TypeError("Failed to fetch") });
  const r2 = new BridgeSetupRunner(net.io, { hasCreds: false, joined: { ip: IP, ssid: "Home" } });
  r2.start();
  await settle(r2, (s) => s.step === "pair");
  await r2.pair("ABCD-EFGH", "phone");
  assert.equal(r2.state.pairError?.kind, "relay-unreachable");
  r2.dispose();
});
