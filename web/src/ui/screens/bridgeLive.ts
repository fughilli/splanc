/**
 * Live via bridge — drive EVERY fixture from one place through a Splanc bridge
 * (docs/design/live-vj-relay.md). A player serves one connection at a time, so
 * the bridge holds them all and this screen talks to the bridge: through the
 * relay from anywhere, or directly on the LAN when it answers there (lower
 * latency; the pill says which).
 *
 *   pair (code from the bridge's screen) -> pick fixtures / rooms -> cue effects
 *   on decks A/B, crossfade, brightness, uniform sliders, keypoint pads, the
 *   Show Mode lock, clock sync, latency probe.
 *
 * Every slider goes through BridgeLiveClient.control (coalesced per tick); a
 * slider's release sends its final value at once, committed.
 */

import { Button, Card, Chip, EmptyState, Field, Slider, StatusPill, Switch, toast, confirmDialog } from "../kit";
import { effectStore, type StoredEffect } from "../../store/effectStore";
import {
  BridgeLiveClient,
  commonUniforms,
  forgetBridge,
  pairWithCode,
  type BridgeCreds,
  type LiveState,
} from "../../net/bridgeLive";
import type { LivePlayer, PerPlayer } from "../../net/liveProtocol";
import type { Router, Screen } from "../app/router";
import { installBridgeLiveStyles } from "./bridgeLive.css";

const STORE_KEY = "splanc.bridge.v1";
export const DEFAULT_RELAY = "https://splanc.pages.dev";

interface UniformDesc {
  name: string;
  width: number;
  ui: { kind: string; min?: number; max?: number; step?: number; options?: string[] };
  min?: number;
  max?: number;
  default: number[];
  current?: number[];
}

interface EffectInfo {
  effect_id: string | null;
  uniforms: UniformDesc[];
  keypoints: { name: string }[] | null;
}

export function loadCreds(): BridgeCreds | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const c = raw ? (JSON.parse(raw) as BridgeCreds) : null;
    return c && c.token && c.relay ? c : null;
  } catch {
    return null;
  }
}

function saveCreds(c: BridgeCreds | null): void {
  try {
    if (c) localStorage.setItem(STORE_KEY, JSON.stringify(c));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* private mode: this session only */
  }
}

function newClientId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function defaultName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : "browser";
  return `Splanc app (${dev})`;
}

export function BridgeLiveScreen(_router: Router): Screen {
  installBridgeLiveStyles();
  const el = document.createElement("div");
  el.className = "screen bridge-screen";

  let creds = loadCreds();
  let client: BridgeLiveClient | null = null;
  let selected = new Set<string>();
  let library: StoredEffect[] = [];
  let effect: EffectInfo | null = null;
  let deck: 0 | 1 = 0;
  let crossfade = 0;
  let xfMode = 0;
  let rtt: number | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let unsubLib: (() => void) | null = null;

  const pill = StatusPill(() => void measure());

  // -- pairing -----------------------------------------------------------------------

  function renderPairing(): void {
    const code = Field({ label: "Pairing code (on the bridge's screen)", placeholder: "ABCD-EFGH" });
    code.input.autocapitalize = "characters";
    code.input.autocomplete = "off";
    const name = Field({ label: "Name this device (other performers see it)", value: defaultName() });
    const relay = Field({ label: "Relay", value: DEFAULT_RELAY });
    const adv = document.createElement("details");
    adv.className = "bridge-adv";
    const sum = document.createElement("summary");
    sum.textContent = "Advanced";
    adv.append(sum, relay.el);
    const go = Button({
      label: "Pair",
      icon: "link",
      variant: "primary",
      block: true,
      onClick: () => void pair(),
    });
    async function pair(): Promise<void> {
      go.disabled = true;
      try {
        const base = relay.input.value.trim().replace(/\/+$/, "") || DEFAULT_RELAY;
        const token = await pairWithCode(base, code.input.value.trim(), name.input.value.trim() || defaultName());
        creds = { relay: base, token, clientId: newClientId(), name: name.input.value.trim() || defaultName() };
        saveCreds(creds);
        toast("Paired with the bridge");
        start();
      } catch (e) {
        toast(`Pairing failed: ${(e as Error).message}`, { error: true });
      } finally {
        go.disabled = false;
      }
    }
    const intro = document.createElement("p");
    intro.className = "bridge-dim";
    intro.textContent =
      "A Splanc bridge (e.g. the Raspberry Pi appliance) keeps the one connection each fixture allows, so " +
      "this app can drive all of them at once — through the relay from anywhere, or directly on the same " +
      "network. Press the bridge's pairing button (or wait for its code), then enter the code here.";
    el.replaceChildren(Card(intro, code.el, name.el, adv, go));
  }

  // -- live --------------------------------------------------------------------------

  function start(): void {
    if (!creds) return renderPairing();
    client?.close();
    const c = new BridgeLiveClient(creds);
    client = c;
    c.events = {
      onState: (s, detail) => {
        updatePill(s);
        if (s === "revoked") {
          toast(detail ?? "Access revoked", { error: true });
          saveCreds(null);
          creds = null;
          stop();
          renderPairing();
        }
      },
      onWelcome: () => {
        if (selected.size === 0) selected = new Set(c.players.map((p) => p.id));
        render();
        void refreshEffect();
      },
      onPlayers: () => render(),
      onError: (code, msg) => {
        if (code !== "bad_uniform") toast(msg, { error: true });
      },
      onFps: (m) => {
        // Advisory only: a lagging effect keeps playing, just slower.
        if (m.lagging) {
          const rate = m.achieved_fps || m.current_fps;
          toast(
            `${m.name}: effect running at ${rate ? `${rate} fps` : "a reduced rate"}, below its ${m.auto ? m.min_fps || 25 : m.target_fps} fps target — it keeps playing.`,
            { ms: 6000 },
          );
        }
      },
      onLan: () => {
        if (creds) saveCreds(creds);
      },
    };
    renderShell();
    updatePill("connecting");
    c.connect().catch((e: Error) => {
      updatePill(e.message === "revoked" ? "revoked" : "offline", e.message);
      if (e.message !== "revoked") setTimeout(() => client === c && start(), 3000);
    });
    pingTimer = setInterval(() => void measure(true), 15_000);
  }

  function stop(): void {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    client?.close();
    client = null;
  }

  function updatePill(s: LiveState, detail?: string): void {
    const via = client?.via === "lan" ? "direct (LAN)" : "via relay";
    const ms = rtt !== null ? ` · ${Math.round(rtt)} ms` : "";
    if (s === "live") pill.set("connected", `Live ${via}${ms}`);
    else if (s === "connecting") pill.set("connecting", "Connecting to bridge…");
    else if (s === "bridge-offline") pill.set("error", "Bridge offline");
    else if (s === "revoked") pill.set("error", "Not paired");
    else pill.set("offline", detail ? `Offline: ${detail}` : "Offline");
  }

  async function measure(quiet = false): Promise<void> {
    const c = client;
    if (!c?.connected) return;
    try {
      rtt = await c.ping();
      updatePill(c.state);
      if (!quiet) {
        const probe = await c.query("probe", {}, sel());
        const dev = (probe.results ?? [])
          .filter((r) => r.ok)
          .map((r) => `${r.player.name} ${(r.result as { device_rtt_ms: number }).device_rtt_ms} ms`);
        toast(`App ⇄ bridge ${Math.round(rtt)} ms (${c.via === "lan" ? "direct" : "via relay"}); bridge ⇄ fixture: ${dev.join(", ") || "n/a"}`, { ms: 6000 });
      }
    } catch {
      /* next time */
    }
  }

  const sel = (): string[] => [...selected];

  // The shell: pill + sections that render() refills.
  const head = document.createElement("div");
  head.className = "bridge-head";
  const lanNote = document.createElement("div");
  lanNote.className = "bridge-lan";
  const fixturesEl = document.createElement("div");
  fixturesEl.className = "bridge-fixtures";
  const controlsEl = document.createElement("div");
  const uniformsEl = document.createElement("div");
  uniformsEl.className = "bridge-uniforms";
  const footer = document.createElement("div");
  footer.className = "bridge-footer";

  function renderShell(): void {
    head.replaceChildren(pill.el);
    el.replaceChildren(head, lanNote, fixturesEl, controlsEl, uniformsEl, footer);
    renderControls();
    renderFooter();
    render();
  }

  function render(): void {
    const c = client;
    if (!c) return;
    // Direct-path hint: advertised but not in use.
    lanNote.replaceChildren();
    if (c.via === "relay" && c.welcome?.lan) {
      const lan = c.welcome.lan;
      const t = document.createElement("span");
      t.textContent = "Via the relay. On the bridge's network? Connect directly for lower latency: ";
      const a = document.createElement("a");
      a.href = lan.page;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "trust the bridge once";
      const retry = Button({
        label: "Go direct",
        variant: "quiet",
        onClick: () =>
          void c.upgradeToLan().then((ok) => {
            toast(ok ? "Connected directly" : (c.lanNote ?? "Not reachable directly"), { error: !ok });
            updatePill(c.state);
            render();
          }),
      });
      const fp = document.createElement("div");
      fp.className = "bridge-dim";
      fp.textContent = `Certificate SHA-256 ${lan.sha256.slice(0, 16)}…`;
      lanNote.append(t, a, retry, fp);
    }
    renderFixtures(c.players, c.rooms);
  }

  function renderFixtures(players: LivePlayer[], rooms: Record<string, string[]>): void {
    if (players.length === 0) {
      fixturesEl.replaceChildren(EmptyState({ icon: "device", title: "The bridge hasn't found any fixtures on its network yet" }));
      return;
    }
    const row = document.createElement("div");
    row.className = "bridge-chips";
    const all = Chip({
      label: "All",
      on: players.every((p) => selected.has(p.id)),
      onClick: () => {
        selected = players.every((p) => selected.has(p.id)) ? new Set() : new Set(players.map((p) => p.id));
        render();
        void refreshEffect();
      },
    });
    row.append(all);
    for (const [room, ids] of Object.entries(rooms)) {
      row.append(
        Chip({
          label: room,
          icon: "folder",
          on: ids.length > 0 && ids.every((id) => selected.has(id)),
          onClick: () => {
            selected = new Set(ids);
            render();
            void refreshEffect();
          },
        }),
      );
    }
    for (const p of players) {
      const chip = Chip({
        label: p.name,
        on: selected.has(p.id),
        onClick: () => {
          if (selected.has(p.id)) selected.delete(p.id);
          else selected.add(p.id);
          render();
          void refreshEffect();
        },
      });
      chip.dataset["online"] = p.connected ? "1" : "0";
      const rate = p.fps ? p.fps.achieved || p.fps.current : 0;
      const fps = p.fps?.lagging
        ? ` · lagging at ${rate ? `${rate} fps` : "a reduced rate"} (below target)`
        : rate
          ? ` · ${rate} fps`
          : "";
      chip.title = `${p.host}${p.fw ? ` · fw ${p.fw}` : ""}${p.connected ? "" : " · not connected"}${fps}${p.lock ? ` · locked by ${p.lock.by}` : ""}`;
      if (p.fps?.lagging) chip.dataset["lagging"] = "1";
      if (p.lock) {
        const b = document.createElement("span");
        b.className = "bridge-lock";
        b.textContent = p.lock.mine ? "🔒 you" : `🔒 ${p.lock.by}`;
        chip.append(b);
      }
      row.append(chip);
    }
    fixturesEl.replaceChildren(row);
  }

  function renderControls(): void {
    const bri = Slider({
      label: "Brightness",
      min: 0,
      max: 100,
      step: 1,
      value: 100,
      format: (v) => `${v}%`,
      onInput: (v) => client?.control(sel(), { bri: v / 100 }),
      onChange: () => client?.flush(),
    });

    // Effect cue: library -> deck A/B (the bridge compiles per fixture firmware).
    const pick = document.createElement("select");
    pick.className = "bridge-select";
    const fillPick = (): void => {
      pick.replaceChildren(
        ...library.map((e) => {
          const o = document.createElement("option");
          o.value = e.id;
          o.textContent = e.name;
          return o;
        }),
      );
    };
    fillPick();
    unsubLib?.();
    unsubLib = effectStore.subscribe(() => void effectStore.list({ sort: "name" }).then((l) => ((library = l), fillPick())));
    void effectStore.list({ sort: "name" }).then((l) => ((library = l), fillPick()));
    const cue = (d: 0 | 1) =>
      Button({
        label: `Cue ${d === 0 ? "A" : "B"}`,
        icon: "effect-to-device",
        ...(d === 0 ? { variant: "primary" as const } : {}),
        onClick: () => void cueDeck(d, pick.value),
      });

    const fader = Slider({
      label: "Crossfade A ⇄ B",
      min: 0,
      max: 100,
      step: 1,
      value: 0,
      format: (v) => (v === 0 ? "A" : v === 100 ? "B" : `${100 - v} / ${v}`),
      onInput: (v) => {
        crossfade = v / 100;
        client?.control(sel(), { xf: { pos: crossfade, mode: xfMode } });
      },
      onChange: () => client?.flush(),
    });
    const hsv = Switch({
      on: false,
      label: "HSV crossfade",
      onChange: (on) => {
        xfMode = on ? 1 : 0;
        client?.control(sel(), { xf: { pos: crossfade, mode: xfMode } });
      },
    });
    const hsvRow = document.createElement("label");
    hsvRow.className = "bridge-row";
    hsvRow.append(hsv.el, document.createTextNode(" HSV blend"));

    const deckSw = Switch({
      on: false,
      label: "Edit deck B",
      onChange: (on) => {
        deck = on ? 1 : 0;
        void refreshEffect();
      },
    });
    const deckRow = document.createElement("label");
    deckRow.className = "bridge-row";
    deckRow.append(deckSw.el, document.createTextNode(" Sliders edit deck B"));

    const lock = Switch({
      on: false,
      label: "Show Mode lock",
      onChange: (on) =>
        void client?.query("lock", { on }, sel()).then((r) => {
          const bad = (r.results ?? []).filter((x) => !x.ok);
          if (bad.length) toast(bad.map((x) => x.error).join("; "), { error: true });
        }),
    });
    const lockRow = document.createElement("label");
    lockRow.className = "bridge-row";
    lockRow.append(lock.el, document.createTextNode(" Show Mode lock (agents and other phones can't change these fixtures)"));

    const tools = document.createElement("div");
    tools.className = "bridge-tools";
    tools.append(
      Button({ label: "Sync clocks", variant: "quiet", onClick: () => void align() }),
      Button({ label: "Identify", variant: "quiet", onClick: () => void client?.query("identify", {}, sel()) }),
      Button({ label: "Latency", variant: "quiet", onClick: () => void measure() }),
    );

    const cueRow = document.createElement("div");
    cueRow.className = "bridge-cue";
    cueRow.append(pick, cue(0), cue(1));
    controlsEl.replaceChildren(Card(bri.el, cueRow, fader.el, hsvRow, deckRow, lockRow, tools));
  }

  async function align(): Promise<void> {
    const r = await client?.query("align", {}, sel());
    const d = r?.data as { skew_bound_ms?: number; time_base?: string } | undefined;
    if (d) toast(`Clocks aligned (${d.time_base}; skew ≤ ${d.skew_bound_ms} ms)`);
  }

  async function cueDeck(d: 0 | 1, id: string): Promise<void> {
    const c = client;
    const e = library.find((x) => x.id === id);
    if (!c?.connected || !e) return;
    toast(`Cueing "${e.name}" on ${selected.size} fixture(s)…`);
    const r = await c.query("deploy", { effect_id: e.id, source: e.source, deck: d }, sel()).catch((err: Error) => ({ ok: false, error: err.message, results: [] as PerPlayer[] }));
    const failed = (r.results ?? []).filter((x) => !x.ok);
    if (!r.ok || failed.length) toast(`Cue: ${r.error ?? failed.map((f) => `${f.player.name}: ${f.error}`).join("; ")}`, { error: true });
    deck = d;
    void refreshEffect();
  }

  /** The selected fixtures' active effect on the current deck -> shared sliders. */
  async function refreshEffect(): Promise<void> {
    const c = client;
    if (!c?.connected || selected.size === 0) {
      uniformsEl.replaceChildren();
      return;
    }
    try {
      const r = await c.query("effect", { deck }, sel());
      const infos = (r.results ?? []).filter((x) => x.ok).map((x) => x.result as EffectInfo);
      effect = infos[0] ?? null;
      const shared = commonUniforms(infos.map((i) => i.uniforms));
      renderUniforms(shared, infos);
    } catch {
      /* keep the old sliders */
    }
  }

  function renderUniforms(us: UniformDesc[], infos: EffectInfo[]): void {
    const ids = new Set(infos.map((i) => i.effect_id ?? ""));
    const title = document.createElement("div");
    title.className = "bridge-sub";
    title.textContent =
      infos.length === 0
        ? "No effect info"
        : `Deck ${deck === 0 ? "A" : "B"}: ${[...ids].map((x) => x || "(none)").join(" / ")}${ids.size > 1 ? " (mixed: shared uniforms only)" : ""}`;
    const items: HTMLElement[] = [title];
    for (const u of us) {
      if (u.width !== 1 && u.ui.kind !== "color") continue; // vectors: the editor has them
      if (u.ui.kind === "color") {
        const inp = document.createElement("input");
        inp.type = "color";
        const cur = u.current ?? u.default;
        inp.value = `#${cur.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("")}`;
        // Colour uniforms take [r, g, b] in 0..1 (the bridge refuses hex strings).
        const rgb = (): number[] => [1, 3, 5].map((i) => parseInt(inp.value.slice(i, i + 2), 16) / 255);
        inp.addEventListener("input", () => client?.control(sel(), { deck, u: { [u.name]: rgb() } }));
        inp.addEventListener("change", () => (client?.control(sel(), { deck, u: { [u.name]: rgb() }, commit: true }), client?.flush()));
        const row = document.createElement("label");
        row.className = "bridge-row";
        row.append(inp, document.createTextNode(` ${u.name}`));
        items.push(row);
        continue;
      }
      if (u.ui.kind === "toggle") {
        const sw = Switch({ on: (u.current ?? u.default)[0]! > 0.5, label: u.name, onChange: (on) => (client?.control(sel(), { deck, u: { [u.name]: on }, commit: true }), client?.flush()) });
        const row = document.createElement("label");
        row.className = "bridge-row";
        row.append(sw.el, document.createTextNode(` ${u.name}`));
        items.push(row);
        continue;
      }
      const min = u.min ?? u.ui.min ?? 0;
      const max = u.max ?? u.ui.max ?? 1;
      const step = u.ui.kind === "dropdown" ? 1 : u.ui.step && u.ui.step > 0 ? u.ui.step : (max - min) / 200;
      const s = Slider({
        label: u.name,
        min,
        max,
        step,
        value: (u.current ?? u.default)[0] ?? min,
        format: (v) => (u.ui.kind === "dropdown" ? (u.ui.options?.[v] ?? String(v)) : v.toFixed(step < 0.1 ? 2 : 1)),
        onInput: (v) => client?.control(sel(), { deck, u: { [u.name]: v } }),
        onChange: (v) => {
          client?.control(sel(), { deck, u: { [u.name]: v }, commit: true });
          client?.flush();
        },
      });
      items.push(s.el);
    }
    // Keypoint pads (stored on the device): tap = morph there in 0.5 s.
    const kps = effect?.keypoints ?? [];
    if (kps.length) {
      const pads = document.createElement("div");
      pads.className = "bridge-pads";
      for (const k of kps) {
        pads.append(
          Button({
            label: k.name,
            variant: "quiet",
            onClick: () => {
              client?.control(sel(), { kb: { w: { [k.name]: 1 }, seconds: 0.5, deck } });
              client?.flush();
            },
          }),
        );
      }
      items.push(pads);
    }
    uniformsEl.replaceChildren(Card(...items));
  }

  function renderFooter(): void {
    const forget = Button({
      label: "Forget this bridge",
      variant: "danger",
      onClick: () =>
        void (async () => {
          const ok = await confirmDialog({
            title: "Forget this bridge?",
            message: "This revokes this app's access (and its direct-connection ticket). Pair again with a new code.",
            confirmLabel: "Forget",
            danger: true,
          });
          if (!ok || !creds) return;
          const c = creds;
          stop();
          await forgetBridge(c.relay, c.token);
          saveCreds(null);
          creds = null;
          renderPairing();
        })(),
    });
    const info = document.createElement("div");
    info.className = "bridge-dim";
    info.textContent = creds ? `Relay ${creds.relay} · this device: ${creds.name}` : "";
    footer.replaceChildren(info, forget);
  }

  return {
    el,
    onMount: () => (creds ? start() : renderPairing()),
    onUnmount: () => {
      stop();
      unsubLib?.();
      unsubLib = null;
    },
  };
}
