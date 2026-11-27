/**
 * "Set up a bridge" (#698): the flow's state machine, pure (no DOM, no I/O). The screen
 * (ui/screens/bridgeSetup.ts) renders a state; its runner (ui/screens/bridgeSetupRun.ts)
 * does what {@link nextAction} asks and feeds the answers back as events.
 *
 *   intro -> wifi -> checking -> pair -> paired          a new bridge
 *                             -> moved                    an already-paired bridge on a new network
 *                             -> failed (a next step for each kind)
 *
 * "checking" confirms the bridge is up in four stages, each from a real signal:
 *
 *   wifi   joined Wi-Fi       the Improv result: `http://<ip>/#splanc-bridge` over Bluetooth
 *                             (pi/bridge/image/splanc_image/improv.py), or UNABLE_TO_CONNECT
 *   agent  bridge running     its LAN endpoint answers `https://<ip>:8443/healthz`
 *                             (agent/src/bridge/liveLan.ts; same certificate as it vouches for)
 *   relay  relay reachable    healthz `relay_online` (bridges with #698), else the relay
 *                             itself when this app connects or pairs through it
 *   ready  ready to pair      healthz `state` (unpaired / pairing, `code_expires_at`); for a
 *                             bridge this app is already paired with: the relay's welcome
 *                             from it ("back online, still paired")
 *
 * A browser can't read healthz until it trusts the bridge's self-signed certificate (the
 * native app can), so there `agent` and `relay` may end "later": not failed, confirmed
 * by the relay when the app pairs or reconnects.
 */

import type { LanHealth } from "./liveProtocol";

export type StageId = "wifi" | "agent" | "relay" | "ready";
export const STAGES: readonly StageId[] = ["wifi", "agent", "relay", "ready"];

/** todo: not reached; active: being checked; ok: confirmed; later: can't be checked from
 * here, pairing confirms it; failed: what the failure is about. */
export type StageStatus = "todo" | "active" | "ok" | "later" | "failed";

export type Step = "intro" | "wifi" | "checking" | "pair" | "paired" | "moved" | "failed";

export type FailureKind =
  /** The bridge couldn't join (Improv UNABLE_TO_CONNECT; it went back to its saved networks). */
  | "join-refused"
  /** The network isn't in range of it (a firmware-style reason; bridges report join-refused). */
  | "not-found"
  /** No Improv answer within the join timeout. */
  | "join-timeout"
  /** Bluetooth itself failed (lost the link, GATT error). */
  | "bluetooth"
  /** The device that answered is a fixture, not a bridge (it joined Wi-Fi anyway). */
  | "not-a-bridge"
  /** It joined Wi-Fi but nothing answers at its address (native app: certain). */
  | "agent-unreachable"
  /** Its bridge reported an error state. */
  | "bridge-error"
  /** It's up on the LAN but can't reach the relay (this phone can). */
  | "relay-blocked"
  /** Neither it nor this phone reaches the relay: this network has no internet. */
  | "no-internet"
  /** Already paired: the relay never heard from it after the move. */
  | "not-back-online";

export interface Failure {
  kind: FailureKind;
  stage: StageId | null;
  /** The technical detail (an error message, the relay link's last error). */
  detail?: string;
}

/** Pairing-code problems are fixed in place on the pair step (not a failure screen). */
export type PairErrorKind = "code-format" | "code-invalid" | "code-rate" | "relay-unreachable" | "other";

export interface SetupState {
  step: Step;
  stages: Record<StageId, StageStatus>;
  /** The network sent, and the address the bridge reported on it. */
  ssid: string;
  ip: string | null;
  /** The last healthz read (null: none yet, or this browser can't read it). */
  health: LanHealth | null;
  /** This app already holds a bridge credential (Live via bridge). */
  hasCreds: boolean;
  /** The certificate of the bridge those credentials are for, when known. */
  knownSha: string | null;
  /** Fixtures the bridge reported (relay welcome), for the paired / moved pages. */
  players: string[] | null;
  /** Shown on the pair step: why pairing is needed although this app has credentials. */
  pairNote: "replaces" | "revoked" | null;
  pairBusy: boolean;
  pairError: { kind: PairErrorKind; message: string } | null;
  failure: Failure | null;
  /** The device that answered isn't a bridge: its address, to connect to it as a fixture. */
  fixtureAddress: string | null;
  /** True once pairing (or the paired check) confirmed the relay end to end. */
  relayConfirmed: boolean;
}

export interface StartOpts {
  hasCreds: boolean;
  knownSha?: string | null;
  /** Arrived from the fixture flow, which already joined this bridge to Wi-Fi. */
  joined?: { ip: string; ssid: string };
}

const todo = (): Record<StageId, StageStatus> => ({ wifi: "todo", agent: "todo", relay: "todo", ready: "todo" });

export function initialState(o: StartOpts): SetupState {
  const s: SetupState = {
    step: "intro",
    stages: todo(),
    ssid: "",
    ip: null,
    health: null,
    hasCreds: o.hasCreds,
    knownSha: o.knownSha ? normSha(o.knownSha) : null,
    players: null,
    pairNote: null,
    pairBusy: false,
    pairError: null,
    failure: null,
    fixtureAddress: null,
    relayConfirmed: false,
  };
  if (!o.joined) return s;
  return reduce({ ...s, step: "checking", ssid: o.joined.ssid, stages: { ...todo(), wifi: "active" } }, { t: "joined", ...o.joined });
}

export type SetupEvent =
  | { t: "start" }
  | { t: "edit-wifi" }
  | { t: "send-wifi"; ssid: string }
  | { t: "cancelled" }
  | { t: "joined"; ip: string; ssid: string }
  | { t: "join-failed"; kind: "join-refused" | "not-found" | "join-timeout" | "bluetooth"; detail?: string }
  | { t: "not-a-bridge"; address: string }
  /** A healthz read (agent up; relay + readiness from its fields). */
  | { t: "health"; health: LanHealth }
  /** No healthz answer by the deadline; `certain` = the app could have read it (native),
   * so nothing is there; otherwise the browser may just not trust the certificate yet. */
  | { t: "agent-timeout"; certain: boolean }
  /** healthz kept saying the relay is down until the deadline; can this phone reach it? */
  | { t: "relay-timeout"; phoneReachesRelay: boolean }
  /** The relay welcome from the bridge this app is paired with (`sha256`: its lan cert). */
  | { t: "welcome"; players: string[]; sha256: string | null }
  /** The relay refused this app's credential (revoked) — pair again. */
  | { t: "revoked" }
  /** The relay never connected us to the bridge by the deadline. */
  | { t: "welcome-timeout"; phoneReachesRelay: boolean }
  | { t: "pair-submit" }
  | { t: "pair-failed"; kind: PairErrorKind; message: string }
  /** Paired: the credential is saved; `players` from the confirming welcome (null: not yet). */
  | { t: "paired"; players: string[] | null }
  | { t: "retry" };

/** What the runner should do now for this state. */
export type SetupAction =
  | { kind: "none" }
  /** Read healthz until it answers (agent stage). */
  | { kind: "probe-agent"; ip: string }
  /** Re-read healthz until `relay_online` (relay stage). */
  | { kind: "poll-relay"; ip: string }
  /** Connect through the relay with this app's credential and wait for the welcome. */
  | { kind: "check-paired" }
  /** On the pair step: keep the code's expiry fresh (when healthz is readable). */
  | { kind: "watch-code"; ip: string };

export function nextAction(s: SetupState): SetupAction {
  if (s.step === "pair") return s.ip && s.health && !s.pairBusy ? { kind: "watch-code", ip: s.ip } : { kind: "none" };
  if (s.step !== "checking" || !s.ip) return { kind: "none" };
  if (s.stages.agent === "active") return { kind: "probe-agent", ip: s.ip };
  if (s.stages.relay === "active") return { kind: "poll-relay", ip: s.ip };
  if (s.stages.ready === "active") return { kind: "check-paired" };
  return { kind: "none" };
}

/** A healthz body, checked (anything else counts as no answer). */
export function parseHealth(text: string): LanHealth | null {
  try {
    const j = JSON.parse(text) as Partial<LanHealth> | null;
    if (!j || j.ok !== true || typeof j.sha256 !== "string") return null;
    return j as LanHealth;
  } catch {
    return null;
  }
}

export function normSha(s: string | null | undefined): string {
  return (s ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** Whether healthz says a pairing code is on the bridge's screen at `nowS`. */
export function codeShowing(h: LanHealth | null, nowS: number): boolean {
  return !!h && h.state === "pairing" && typeof h.code_expires_at === "number" && h.code_expires_at > nowS;
}

function fail(s: SetupState, kind: FailureKind, stage: StageId | null, detail?: string): SetupState {
  const stages = { ...s.stages };
  if (stage) stages[stage] = "failed";
  return { ...s, step: "failed", stages, failure: { kind, stage, ...(detail ? { detail } : {}) } };
}

/** Agent and relay are settled (ok or later): decide the last stage. */
function settleReady(s: SetupState): SetupState {
  const h = s.health;
  // An app paired with a DIFFERENT bridge (its certificate differs): pair this one.
  const other = !!(h && s.knownSha && normSha(h.sha256) && normSha(h.sha256) !== s.knownSha);
  const bridgeHasNobody = h?.state === "unpaired" || h?.state === "pairing";
  if (s.hasCreds && !other && !bridgeHasNobody) {
    // Probably the bridge this app is paired with, moved: the relay will tell.
    return { ...s, stages: { ...s.stages, ready: "active" } };
  }
  return {
    ...s,
    step: "pair",
    stages: { ...s.stages, ready: "ok" },
    pairNote: s.hasCreds ? "replaces" : null,
  };
}

/** Apply a healthz answer on the checking step. */
function onHealth(s: SetupState, h: LanHealth): SetupState {
  const next: SetupState = { ...s, health: h, stages: { ...s.stages, agent: "ok" } };
  if (h.state === "error") return fail(next, "bridge-error", "agent", h.relay_error ?? undefined);
  if (h.relay_online === true) return settleReady({ ...next, stages: { ...next.stages, relay: "ok" } });
  if (h.relay_online === false || h.state === "starting" || h.state === "offline") {
    return { ...next, stages: { ...next.stages, relay: "active" } };
  }
  // A bridge from before #698: no relay field; the relay is checked when the app uses it.
  return settleReady({ ...next, stages: { ...next.stages, relay: "later" } });
}

export function reduce(s: SetupState, e: SetupEvent): SetupState {
  switch (e.t) {
    case "start":
      return s.step === "intro" ? { ...s, step: "wifi" } : s;
    case "edit-wifi":
      return { ...s, step: "wifi", failure: null, stages: todo() };
    case "send-wifi":
      if (s.step !== "wifi" && s.step !== "failed") return s;
      return {
        ...s,
        step: "checking",
        ssid: e.ssid,
        ip: null,
        health: null,
        failure: null,
        fixtureAddress: null,
        stages: { ...todo(), wifi: "active" },
      };
    case "cancelled":
      return s.step === "checking" && s.stages.wifi === "active" ? { ...s, step: "wifi", stages: todo() } : s;
    case "joined":
      if (s.step !== "checking") return s;
      return { ...s, ssid: e.ssid || s.ssid, ip: e.ip, stages: { ...s.stages, wifi: "ok", agent: "active" } };
    case "join-failed":
      if (s.step !== "checking") return s;
      return fail(s, e.kind, "wifi", e.detail);
    case "not-a-bridge":
      if (s.step !== "checking") return s;
      return { ...fail({ ...s, stages: { ...s.stages, wifi: "ok" } }, "not-a-bridge", null), fixtureAddress: e.address };
    case "health":
      if (s.step === "pair") return { ...s, health: e.health };
      if (s.step !== "checking") return s;
      if (s.stages.agent === "active") return onHealth(s, e.health);
      if (s.stages.relay === "active") {
        const next = { ...s, health: e.health };
        if (e.health.state === "error") return fail(next, "bridge-error", "relay", e.health.relay_error ?? undefined);
        return e.health.relay_online === true ? settleReady({ ...next, stages: { ...s.stages, relay: "ok" } }) : next;
      }
      return { ...s, health: e.health };
    case "agent-timeout":
      if (s.step !== "checking" || s.stages.agent !== "active") return s;
      if (e.certain) return fail(s, "agent-unreachable", "agent");
      // A browser that doesn't trust its certificate yet can't tell: the relay will.
      return settleReady({ ...s, stages: { ...s.stages, agent: "later", relay: "later" } });
    case "relay-timeout":
      if (s.step !== "checking" || s.stages.relay !== "active") return s;
      return fail(s, e.phoneReachesRelay ? "relay-blocked" : "no-internet", "relay", s.health?.relay_error ?? undefined);
    case "welcome": {
      if (s.step !== "checking" || s.stages.ready !== "active") return s;
      const sha = normSha(e.sha256);
      const here = s.health ? normSha(s.health.sha256) : "";
      if (sha && here && sha !== here) {
        // The app's bridge is a different one (online somewhere else): pair this one.
        return { ...s, step: "pair", stages: { ...s.stages, ready: "ok" }, pairNote: "replaces" };
      }
      const confirmed = (x: StageStatus): StageStatus => (x === "later" ? "ok" : x);
      return {
        ...s,
        step: "moved",
        players: e.players,
        relayConfirmed: true,
        stages: { wifi: "ok", agent: confirmed(s.stages.agent), relay: confirmed(s.stages.relay), ready: "ok" },
      };
    }
    case "revoked":
      if (s.step !== "checking" || s.stages.ready !== "active") return s;
      return { ...s, step: "pair", hasCreds: false, stages: { ...s.stages, ready: "ok" }, pairNote: "revoked" };
    case "welcome-timeout":
      if (s.step !== "checking" || s.stages.ready !== "active") return s;
      if (!e.phoneReachesRelay) return fail(s, "no-internet", "ready");
      return fail(s, "not-back-online", "ready");
    case "pair-submit":
      return s.step === "pair" ? { ...s, pairBusy: true, pairError: null } : s;
    case "pair-failed":
      return s.step === "pair" ? { ...s, pairBusy: false, pairError: { kind: e.kind, message: e.message } } : s;
    case "paired": {
      if (s.step !== "pair") return s;
      const confirmed = (x: StageStatus): StageStatus => (x === "later" ? "ok" : x);
      return {
        ...s,
        step: "paired",
        pairBusy: false,
        pairError: null,
        hasCreds: true,
        players: e.players,
        relayConfirmed: true,
        stages: { wifi: "ok", agent: confirmed(s.stages.agent), relay: confirmed(s.stages.relay), ready: "ok" },
      };
    }
    case "retry": {
      if (s.step !== "failed" || !s.failure) return s;
      const k = s.failure.kind;
      if (k === "join-refused" || k === "not-found" || k === "join-timeout" || k === "bluetooth" || k === "not-a-bridge") {
        return { ...s, step: "wifi", failure: null, stages: todo() };
      }
      // Re-check from the stage that failed; what passed stays passed.
      const stages = { ...s.stages };
      const from = s.failure.stage ?? "agent";
      let reached = false;
      for (const id of STAGES) {
        if (id === from) reached = true;
        if (reached) stages[id] = id === from ? "active" : "todo";
      }
      return { ...s, step: "checking", failure: null, stages };
    }
    default:
      return s;
  }
}

// -- wording ---------------------------------------------------------------------------

export interface StageText {
  title: string;
  detail: string;
}

/** What each stage row says in this state. */
export function stageText(s: SetupState, id: StageId, nowS: number): StageText {
  const st = s.stages[id];
  const net = s.ssid ? `“${s.ssid}”` : "your Wi-Fi";
  switch (id) {
    case "wifi":
      return {
        title: "Joined Wi-Fi",
        detail:
          st === "ok"
            ? `On ${net}${s.ip ? ` at ${s.ip}` : ""}.`
            : st === "active"
              ? `Sending ${net} over Bluetooth and waiting for it to join…`
              : st === "failed"
                ? `It didn't join ${net}.`
                : `Joins ${net}.`,
      };
    case "agent":
      return {
        title: "Bridge running",
        detail:
          st === "ok"
            ? "Its bridge service answers on this network."
            : st === "active"
              ? "Looking for it on this network…"
              : st === "later"
                ? "This browser can't check it directly yet. Pairing confirms it."
                : st === "failed"
                  ? s.failure?.kind === "bridge-error"
                    ? "Its bridge service reported an error."
                    : "Nothing answers at its address."
                  : "Its bridge service answers on this network.",
      };
    case "relay":
      return {
        title: "Relay reachable",
        detail:
          st === "ok"
            ? "It's connected to the Splanc relay, so the app reaches it from anywhere."
            : st === "active"
              ? "Waiting for it to connect to the Splanc relay…"
              : st === "later"
                ? "Checked through the relay when you pair."
                : st === "failed"
                  ? s.failure?.kind === "no-internet"
                    ? "This network doesn't reach the internet."
                    : "It can't reach the Splanc relay from this network."
                  : "Connects to the Splanc relay.",
      };
    case "ready": {
      const paired = s.step === "moved" || (s.stages.ready === "active" && s.hasCreds);
      if (paired || (st === "failed" && s.failure?.kind === "not-back-online")) {
        return {
          title: "Still paired",
          detail:
            st === "ok"
              ? "It's back online and this app is still paired with it."
              : st === "active"
                ? "This app is paired with a bridge: checking it's this one, through the relay…"
                : st === "failed"
                  ? "The relay hasn't heard from it."
                  : "Checks this app is still paired with it.",
        };
      }
      return {
        title: s.step === "paired" ? "Paired" : "Ready to pair",
        detail:
          st === "ok"
            ? s.step === "paired"
              ? "Paired with this app."
              : codeShowing(s.health, nowS)
                ? "A pairing code is on its screen."
                : "Ready for a pairing code."
            : "Shows a pairing code on its screen.",
      };
    }
  }
}

export interface FailureCopy {
  title: string;
  text: string;
  /** The next step, as the primary button. */
  primary: { id: "retry" | "edit-wifi" | "connect-fixture"; label: string };
}

/** What a failure says, and the one thing to do next. */
export function failureCopy(s: SetupState): FailureCopy {
  const f = s.failure;
  const net = s.ssid ? `“${s.ssid}”` : "the network";
  const ip = s.ip ?? "its address";
  switch (f?.kind) {
    case "join-refused":
      return {
        title: "It couldn't join the Wi-Fi",
        text: `The bridge couldn't connect to ${net}. The password may be wrong, or the network is out of its range. It went back to the networks it already knew. Check the details and send them again.`,
        primary: { id: "edit-wifi", label: "Check the Wi-Fi details" },
      };
    case "not-found":
      return {
        title: "It can't see that network",
        text: `The bridge can't find ${net}. Check the network name, and move the bridge closer to the router.`,
        primary: { id: "edit-wifi", label: "Check the network name" },
      };
    case "join-timeout":
      return {
        title: "No answer from the bridge",
        text: "The bridge didn't say whether it joined. Keep the phone near it, check its screen says it's ready for setup, then try again.",
        primary: { id: "edit-wifi", label: "Try again" },
      };
    case "bluetooth":
      return {
        title: "Bluetooth dropped",
        text: "The Bluetooth link to the bridge broke before it finished. Keep the phone within a few metres of it and try again.",
        primary: { id: "edit-wifi", label: "Try again" },
      };
    case "not-a-bridge":
      return {
        title: "That's a fixture, not a bridge",
        text: `The device you picked is a Splanc fixture. It has joined ${net}, so you can connect to it as a fixture now. To set up a bridge, pick “splanc-bridge” (its name, unless you renamed it) in the Bluetooth list.`,
        primary: { id: "connect-fixture", label: "Connect to the fixture" },
      };
    case "agent-unreachable":
      return {
        title: "The bridge isn't answering",
        text: `It joined ${net} at ${ip}, but its bridge service doesn't answer there. Check this phone is on ${net} too. If the bridge's screen says “Starting bridge…”, give it a minute.`,
        primary: { id: "retry", label: "Check again" },
      };
    case "bridge-error":
      return {
        title: "The bridge reported an error",
        text: "Its bridge service stopped with an error. Unplug the bridge for ten seconds, plug it back in, then check again.",
        primary: { id: "retry", label: "Check again" },
      };
    case "relay-blocked":
      return {
        title: "It can't reach the relay",
        text: `The bridge is on ${net}, but it can't connect to the Splanc relay, so the app can't pair with it or reach it from elsewhere. This network may block outgoing secure web connections (some guest and office networks do). Use another network, or ask its admin to allow HTTPS to ${relayHost(s)}.`,
        primary: { id: "retry", label: "Check again" },
      };
    case "no-internet":
      return {
        title: "This network has no internet",
        text: `Neither the bridge nor this phone can reach the Splanc relay. Check ${net} is connected to the internet, then check again.`,
        primary: { id: "retry", label: "Check again" },
      };
    case "not-back-online":
      return {
        title: "It hasn't come back online",
        text: `It joined ${net}, but the relay hasn't heard from it yet. It can take a minute after a network change. If the bridge's screen says “Offline”, this network may block the relay.`,
        primary: { id: "retry", label: "Check again" },
      };
    default:
      return { title: "Setup stopped", text: "Something went wrong. Try again.", primary: { id: "edit-wifi", label: "Try again" } };
  }
}

function relayHost(s: SetupState): string {
  try {
    return s.health?.relay ? new URL(s.health.relay).host : "the Splanc relay";
  } catch {
    return "the Splanc relay";
  }
}

/** A pairing-code failure from the relay (pairWithCode's error), as a kind + message. */
export function classifyPairError(e: { code?: string; message?: string } | null | undefined): { kind: PairErrorKind; message: string } {
  const code = e?.code ?? "";
  if (code === "invalid_grant") {
    return { kind: "code-invalid", message: "That code isn't valid or has expired. Check the code on the bridge's screen, or press KEY1 on it for a new one." };
  }
  if (code === "slow_down") return { kind: "code-rate", message: "Too many wrong codes. Wait a few minutes, then try again." };
  if (code === "invalid_request") return { kind: "code-format", message: "A pairing code is 8 letters and digits, like ABCD-EFGH." };
  if (!code) {
    return { kind: "relay-unreachable", message: "This phone couldn't reach the Splanc relay. Check its internet connection and try again." };
  }
  return { kind: "other", message: e?.message || "Pairing failed. Try again." };
}

/** The code as the user types it, shown like the bridge does: ABCD-EFGH. */
export function formatPairingCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export function pairingCodeComplete(input: string): boolean {
  return formatPairingCode(input).replace("-", "").length === 8;
}
