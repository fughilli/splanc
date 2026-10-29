/**
 * Halloween play mode (`#/play?f=SpookySplanc1`) — the zero-friction visitor
 * screen at a public install (.claude/halloween/CONTRACT.md "Visitor flow"):
 * a connection pill, big effect tiles (HALLOWEEN_PRESETS) with 1–2 big sliders
 * for the selected one, a big Acid Mode button, the kiosk idle countdown, a
 * revert notice, and a small "exit to full app" link. No tabs, no ⋯ menu.
 *
 * Connect: one tap on "🎃 Connect" opens the Web Bluetooth chooser filtered to
 * the fixture (net/halloweenConnect.ts); in the iPhone app it connects to the
 * nearest SpookySplanc* on its own. A BLE link can't survive a reload, so a
 * dropped/never-made connection always shows a big Reconnect button.
 *
 * Map: effects run on the device against its own map; the on-screen preview
 * pulls that map over the same link (store/deviceMap.ts) and, when the device
 * has none, says so to the owner.
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { FxPreview, deriveLedTopology, type FxCompiled } from "../../fx/preview";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { withDeviceLock } from "../../effects/devicePerf";
import { extractTopology } from "../../topology/extract";
import { MapView } from "../mapview";
import { appState } from "../app/state";
import { toast } from "../kit";
import { deviceStore } from "../../store/deviceStore";
import { mapStore } from "../../store/mapStore";
import { deviceMaps } from "./deviceMapCard";
import { HALLOWEEN_PRESETS, attractDisplayName, presetEffectId, type HalloweenPreset } from "../../halloween/presets";
import { ROPE_START_UNIFORM, presetUniformValues, ropeStartFromChannels, sliderSpecs } from "../../halloween/playLogic";
import type { LedMapperClient } from "../../net/client";
import { kioskStore } from "../../halloween/kioskStore";
import { countdownLine, formatCountdown } from "../../net/kiosk";
import {
  connectAttempt,
  onConnectAttempt,
  rememberFixture,
  rememberedFixture,
  startPlayConnect,
} from "../../halloween/playSession";
import { halloweenBleAvailable, isNativeBle, parseFixtureName } from "../../net/halloweenConnect";
import { installPlayStyles } from "./playMode.css";
import type { Router, Screen } from "../app/router";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What the play screen knows about the fixture's map. */
type MapState =
  | { kind: "unknown" }
  | { kind: "loading" }
  | { kind: "map"; map: OutputMap; topology?: Topology | undefined }
  | { kind: "none" }
  | { kind: "unavailable"; why: string };

export function PlayModeScreen(router: Router, query: URLSearchParams): Screen {
  installPlayStyles();
  kioskStore.start();

  const fixture = parseFixtureName(query.get("f")) ?? rememberedFixture();
  rememberFixture(fixture);

  const el = document.createElement("div");
  el.className = "screen screen--play";

  // -- state -----------------------------------------------------------------
  const worker = typeof Worker !== "undefined" ? new FxCompilerWorker() : null;
  const compiled = new Map<string, Promise<FxCompiled>>();
  const sliderValues = new Map<string, Record<string, number>>();
  let selected: HalloweenPreset | null = null;
  let deploying: string | null = null;
  let everConnected = false;
  let mapState: MapState = { kind: "unknown" };
  let mapClient: unknown = null;
  // Device-derived uniforms (rope_start = CH0's LED count), read once per connection.
  let deviceVals: { client: LedMapperClient; vals: Promise<Record<string, number>> } | null = null;
  const deviceUniforms = (c: LedMapperClient): Promise<Record<string, number>> => {
    if (deviceVals?.client !== c) {
      const vals = c
        .getHardwareConfig()
        .then((h) => ({ [ROPE_START_UNIFORM]: ropeStartFromChannels(h.channels ?? []) }))
        .catch(() => ({ [ROPE_START_UNIFORM]: 0 }));
      deviceVals = { client: c, vals };
    }
    return deviceVals.vals;
  };
  let disposed = false;

  const compile = (p: HalloweenPreset): Promise<FxCompiled> => {
    let c = compiled.get(p.id);
    if (!c) {
      c = worker
        ? worker.compile(p.source)
        : Promise.resolve({ ok: false, bytecode: new Uint8Array(), uniforms: [], diagnostics: [] });
      compiled.set(p.id, c);
    }
    return c;
  };
  // Warm every tile's compile so the first tap only uploads.
  for (const p of HALLOWEEN_PRESETS) void compile(p);

  // -- top: title + connection pill -------------------------------------------
  const top = document.createElement("div");
  top.className = "play-top";
  const title = document.createElement("h1");
  title.className = "play-title";
  title.textContent = "🎃 Spooky Splanc";
  const pill = document.createElement("div");
  pill.className = "play-pill";
  const pillDot = document.createElement("span");
  pillDot.className = "play-pill-dot";
  const pillText = document.createElement("span");
  pill.append(pillDot, pillText);
  top.append(title, pill);

  // -- connect card ------------------------------------------------------------
  const connectCard = document.createElement("div");
  connectCard.className = "play-connect-card";

  // -- kiosk countdown + revert notice ----------------------------------------
  const countdown = document.createElement("div");
  countdown.className = "play-countdown";
  countdown.hidden = true;
  const cdIcon = document.createElement("span");
  cdIcon.textContent = "⏳";
  const cdText = document.createElement("span");
  countdown.append(cdIcon, cdText);

  const revert = document.createElement("div");
  revert.className = "play-revert";
  revert.hidden = true;
  const revertText = document.createElement("span");
  const revertClose = document.createElement("button");
  revertClose.type = "button";
  revertClose.textContent = "✕";
  revertClose.setAttribute("aria-label", "Dismiss");
  revertClose.addEventListener("click", () => (revert.hidden = true));
  revert.append(revertText, revertClose);
  let revertTimer = 0;

  // -- preview + map hint ------------------------------------------------------
  const previewBox = document.createElement("div");
  previewBox.className = "play-preview";
  previewBox.hidden = true;
  const canvas = document.createElement("canvas");
  previewBox.append(canvas);
  const mapHint = document.createElement("div");
  mapHint.className = "play-hint";
  mapHint.hidden = true;

  // -- tiles + sliders ---------------------------------------------------------
  const tiles = document.createElement("div");
  tiles.className = "play-tiles";
  const tileEls = new Map<string, HTMLButtonElement>();
  for (const p of HALLOWEEN_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "play-tile";
    b.setAttribute("aria-pressed", "false");
    const em = document.createElement("span");
    em.className = "play-tile-emoji";
    em.textContent = p.emoji;
    const nm = document.createElement("span");
    nm.className = "play-tile-name";
    nm.textContent = p.name;
    b.append(em, nm);
    b.addEventListener("click", () => void play(p));
    tileEls.set(p.id, b);
    tiles.append(b);
  }
  const sliders = document.createElement("div");
  sliders.className = "play-sliders";

  // -- acid + exit -------------------------------------------------------------
  const acidBtn = document.createElement("button");
  acidBtn.type = "button";
  acidBtn.className = "play-big play-big--acid";
  acidBtn.textContent = "🎤 Acid Mode";
  acidBtn.addEventListener("click", () => router.navigate("/acid?play=1"));

  const exit = document.createElement("button");
  exit.type = "button";
  exit.className = "play-exit";
  exit.textContent = "Exit to full app";
  exit.addEventListener("click", () => router.navigate("/maps"));

  el.append(top, connectCard, revert, countdown, previewBox, mapHint, tiles, sliders, acidBtn, exit);

  // -- rendering ---------------------------------------------------------------
  const connected = (): boolean => appState.status.state === "connected" && !!appState.client?.isConnected;
  const fixtureLabel = (): string => {
    const id = deviceStore.activeId();
    const rec = id ? deviceStore.get(id) : undefined;
    return appState.client?.welcome?.deviceName || rec?.label || fixture || "Spooky Splanc";
  };

  function renderPill(): void {
    const s = appState.status;
    const a = connectAttempt();
    let state = "offline";
    let text = fixture ?? "Not connected";
    if (connected()) {
      state = "connected";
      text = fixtureLabel();
    } else if (a.state === "picking" || (appState.client && s.state === "connecting")) {
      state = "connecting";
      text = `Connecting to ${fixture ?? "the pumpkins"}…`;
    } else if (s.state === "error") {
      state = "error";
      text = "Connection lost";
    }
    pill.dataset["state"] = state;
    pillText.textContent = text;
  }

  function renderConnect(): void {
    const isConn = connected();
    if (isConn) everConnected = true;
    connectCard.hidden = isConn;
    tiles.classList.toggle("play-tiles--offline", !isConn);
    for (const b of tileEls.values()) b.disabled = !isConn;
    acidBtn.disabled = false;
    if (isConn) return;
    const a = connectAttempt();
    const busy = a.state === "picking" || (appState.client !== null && appState.status.state === "connecting");
    const p = document.createElement("p");
    connectCard.replaceChildren();
    if (!halloweenBleAvailable()) {
      p.textContent =
        "This browser can't use Bluetooth. Open this page in Chrome on an Android phone, or in the Splanc iPhone app.";
      connectCard.append(p);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "play-big";
    btn.textContent = busy ? "Connecting…" : everConnected ? "🔄 Reconnect" : "🎃 Connect";
    btn.disabled = busy && a.state === "picking";
    // The chooser is the FIRST async call in this handler (user-gesture rule).
    btn.addEventListener("click", () => void startPlayConnect(fixture));
    if (a.state === "failed") p.textContent = `Couldn't connect: ${a.message}. Walk closer and try again.`;
    else if (everConnected || appState.status.state === "error")
      p.textContent = "The lights dropped off. Walk a little closer and tap Reconnect.";
    else
      p.textContent = isNativeBle()
        ? "Looking for the pumpkins nearby…"
        : `Tap Connect, then pick ${fixture ?? "a SpookySplanc"} from the list.`;
    connectCard.append(btn, p);
  }

  function renderTiles(): void {
    for (const [id, b] of tileEls) {
      b.setAttribute("aria-pressed", String(selected?.id === id));
      b.dataset["busy"] = deploying === id ? "1" : "0";
    }
  }

  async function renderSliders(): Promise<void> {
    const p = selected;
    sliders.replaceChildren();
    if (!p) return;
    const r = await compile(p);
    if (selected !== p || !r.ok) return;
    const cur = sliderValues.get(p.id) ?? {};
    for (const spec of sliderSpecs(p, r.uniforms, cur)) {
      const box = document.createElement("div");
      box.className = "play-slider";
      const lab = document.createElement("label");
      const nm = document.createElement("span");
      nm.textContent = spec.name.replace(/_/g, " ");
      const val = document.createElement("span");
      const pct = (v: number): string => `${Math.round(((v - spec.min) / (spec.max - spec.min || 1)) * 100)}%`;
      val.textContent = pct(spec.value);
      lab.append(nm, val);
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(spec.value);
      input.setAttribute("aria-label", spec.name);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        val.textContent = pct(v);
        sliderValues.set(p.id, { ...(sliderValues.get(p.id) ?? {}), [spec.name]: v });
        preview?.setUniform(spec.slot, [v]);
        const c = appState.client;
        if (c?.isConnected) c.live.setUniform(spec.slot, [v]);
      });
      box.append(lab, input);
      sliders.append(box);
    }
  }

  function renderCountdown(): void {
    const on = kioskStore.active && connected();
    countdown.hidden = !on;
    if (!on) return;
    const left = kioskStore.remaining();
    cdText.replaceChildren();
    const line = countdownLine(left, kioskStore.status);
    const t = formatCountdown(left);
    const i = left > 0 ? line.indexOf(t) : -1;
    if (i >= 0) {
      const strong = document.createElement("span");
      strong.className = "play-countdown-time";
      strong.textContent = t;
      cdText.append(line.slice(0, i), strong, line.slice(i + t.length));
    } else cdText.textContent = line;
    countdown.dataset["low"] = left <= 15 ? "1" : "0";
  }

  function showRevert(name: string): void {
    selected = null;
    renderTiles();
    void renderSliders();
    revertText.textContent = `👻 Back to the show${name ? ` (${attractDisplayName(name)})` : ""}. Tap an effect to play again!`;
    revert.hidden = false;
    window.clearTimeout(revertTimer);
    revertTimer = window.setTimeout(() => (revert.hidden = true), 12_000);
  }

  function renderMapHint(): void {
    // The preview shows once an effect is actually running in it (and stays
    // hidden where the preview VM can't load — the lights don't need it).
    previewBox.hidden = mapState.kind !== "map" || preview === null;
    mapHint.hidden = !(mapState.kind === "none" || mapState.kind === "unavailable");
    if (mapState.kind === "none") {
      mapHint.textContent =
        "This fixture has no layout yet, so there's no preview here — the lights still play every effect. " +
        "Owner: generate and upload a layout from the full app.";
    } else if (mapState.kind === "unavailable") {
      mapHint.textContent = `No on-screen preview (${mapState.why}) — the lights still play every effect.`;
    }
  }

  const rerender = (): void => {
    if (disposed) return;
    renderPill();
    renderConnect();
    renderCountdown();
    if (connected() && mapClient !== appState.client) void loadMap();
  };

  // -- deploy ------------------------------------------------------------------
  async function play(p: HalloweenPreset): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) {
      toast("Connect to the pumpkins first 🎃");
      return;
    }
    selected = p;
    deploying = p.id;
    revert.hidden = true;
    renderTiles();
    void renderSliders();
    try {
      const r = await compile(p);
      if (!r.ok) throw new Error(r.diagnostics[0]?.msg ?? "effect didn't compile");
      void swapPreview(r);
      const dev = await deviceUniforms(c);
      await withDeviceLock(() => c.submitEffect(presetEffectId(p), r.bytecode, true, 0));
      if (selected === p) {
        // Visitor values are live-only (kiosk firmware never persists them anyway).
        c.setUniforms(presetUniformValues(p, r.uniforms, sliderValues.get(p.id), dev), false);
      }
    } catch (e) {
      toast(`Couldn't start ${p.name}: ${msg(e)}`, { error: true });
    } finally {
      if (deploying === p.id) deploying = null;
      renderTiles();
    }
  }

  // -- map + preview -----------------------------------------------------------
  let mapView: MapView | null = null;
  let preview: FxPreview | null = null;
  let positions: Float32Array | null = null;
  let previewMap: OutputMap | null = null;
  let raf = 0;
  let startT = 0;
  let frame = 0;
  let lastT = 0;

  async function loadMap(): Promise<void> {
    const c = appState.client;
    mapClient = c;
    if (!c) return;
    mapState = { kind: "loading" };
    try {
      const id = await deviceMaps.ensureLocal(c);
      const rec = await mapStore.get(id);
      if (disposed || mapClient !== c) return;
      if (!rec) throw new Error("map not saved");
      // Acid Mode (and the effects workspace) pick up the same map.
      appState.selectedMapId = id;
      mapState = { kind: "map", map: rec.map, topology: rec.topology };
      startPreview(rec.map, rec.topology);
    } catch (e) {
      if (disposed || mapClient !== c) return;
      const code = (e as { code?: string }).code;
      if (code === "no_map" || /no stored map|no_map/i.test(msg(e))) mapState = { kind: "none" };
      else if (code === "unsupported") mapState = { kind: "unavailable", why: "this firmware can't share its layout" };
      else mapState = { kind: "unavailable", why: "couldn't read the layout" };
    }
    renderMapHint();
  }

  function startPreview(map: OutputMap, topology?: Topology): void {
    previewMap = map;
    positions = new Float32Array(map.leds.length * 3);
    map.leds.forEach((l, i) => {
      positions![i * 3] = l.xyz[0];
      positions![i * 3 + 1] = l.xyz[1];
      positions![i * 3 + 2] = l.xyz[2];
    });
    renderMapHint();
    try {
      if (!mapView) {
        mapView = new MapView(canvas, map);
        mapView.showStats = false;
        mapView.start();
      } else mapView.update(map);
      mapView.setLedColors(new Uint8Array(map.leds.length * 3));
    } catch {
      mapState = { kind: "unavailable", why: "no 3D graphics on this phone" };
      renderMapHint();
      return;
    }
    void extractTopology(map)
      .catch(() => undefined)
      .then((t) => {
        if (disposed || previewMap !== map) return;
        preview?.setTopology(deriveLedTopology(map, topology ?? t));
      });
    if (!raf) raf = requestAnimationFrame(tick);
  }

  async function swapPreview(r: FxCompiled): Promise<void> {
    if (!previewMap) return;
    const next = await FxPreview.create(r.bytecode).catch(() => null);
    if (!next || disposed) {
      next?.dispose();
      renderMapHint();
      return;
    }
    const p = selected;
    const vals = p ? presetUniformValues(p, r.uniforms, sliderValues.get(p.id)) : [];
    for (const v of vals) next.setUniform(v.slot, v.value);
    if (previewMap) {
      const map = previewMap;
      void extractTopology(map)
        .catch(() => undefined)
        .then((t) => {
          if (!disposed && preview === next) next.setTopology(deriveLedTopology(map, t));
        });
    }
    preview?.dispose();
    preview = next;
    startT = performance.now();
    frame = 0;
    renderMapHint();
  }

  function tick(t: number): void {
    raf = requestAnimationFrame(tick);
    const dt = lastT === 0 ? 16 : Math.min(100, t - lastT);
    lastT = t;
    if (!preview || !mapView || !previewMap || !positions) return;
    preview.tick((t - startT) / 1000, dt / 1000, frame++, previewMap.leds.length);
    mapView.setLedColors(preview.shadeAll(positions));
  }

  // -- wiring ------------------------------------------------------------------
  const unsubApp = appState.subscribe(rerender);
  const unsubAttempt = onConnectAttempt(rerender);
  const unsubKiosk = kioskStore.subscribe(renderCountdown);
  const unsubRevert = kioskStore.onRevert((s) => showRevert(s.attractName));
  let cdTimer = 0;

  // Keep the phone awake while playing (a locked phone drops the BLE link).
  // Best-effort: re-acquired when the page becomes visible again.
  type WakeLock = { release(): Promise<void> };
  let wake: WakeLock | null = null;
  const nav = navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<WakeLock> } };
  const acquireWake = (): void => {
    if (disposed || wake || document.hidden || !nav.wakeLock) return;
    nav.wakeLock.request("screen").then(
      (w) => {
        if (disposed) void w.release().catch(() => undefined);
        else wake = w;
      },
      () => undefined,
    );
  };
  const onVisible = (): void => {
    wake = null; // the browser releases it when hidden
    acquireWake();
  };

  return {
    el,
    onMount: () => {
      acquireWake();
      document.addEventListener("visibilitychange", onVisible);
      rerender();
      cdTimer = window.setInterval(renderCountdown, 250);
      // iPhone app: no chooser and no gesture needed — connect straight away.
      const a = connectAttempt();
      if (isNativeBle() && !appState.client && a.state !== "picking") void startPlayConnect(fixture);
    },
    onUnmount: () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      void wake?.release().catch(() => undefined);
      unsubApp();
      unsubAttempt();
      unsubKiosk();
      unsubRevert();
      window.clearInterval(cdTimer);
      window.clearTimeout(revertTimer);
      cancelAnimationFrame(raf);
      preview?.dispose();
      mapView?.stop();
      worker?.dispose();
    },
  };
}
