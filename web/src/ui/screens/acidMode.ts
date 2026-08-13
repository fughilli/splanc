/**
 * Acid Mode (FUG-106) — the "I'm too zonked to figure out this UI right now"
 * surface. A full-screen, hands-free mode reachable from the ⋯ menu or by
 * vigorously shaking the device (see acid/shake.ts). It shows ONLY a device
 * connectivity indicator and a big voice-input button; everything else is done
 * by a lighting agent on the other end of the mic.
 *
 * The agent runs the SAME tool-use loop as the effect editor (effects/ai:
 * chatTurn) so it can author effects, compile them, upload them to the device,
 * configure MIDI, and check performance — but here the tools are fulfilled
 * headlessly and every step is narrated to a plain-language "stream of
 * consciousness" feed so a hands-off user can follow along. The live LED preview
 * doubles as the trippy backdrop AND the agent's eyes (capture_preview).
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { FxPreview, deriveLedTopology, type FxUniform, type LedTopology } from "../../fx/preview";
import { MapView } from "../mapview";
import { generateFixture } from "../../effects/fixtures";
import { extractTopology } from "../../topology/extract";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import {
  chatTurn,
  editorContext,
  getApiKey,
  type ChatMessage,
  type MidiMappingCall,
} from "../../effects/ai/generate";
import { resolveFleetTargets } from "../../effects/fleet";
import { estimateAcrossDevices, describeFleet } from "../../effects/multiDevice";
import { costTableStore } from "../../store/costTableStore";
import { builtinCostsToPrompt } from "../../effects/perfContext";
import { isDrivable, MidiRouter } from "../../midi/router";
import { midiStore, type UniformBinding } from "../../store/midiStore";
import { midiManager, controlLabel } from "../../midi/manager";
import { effectStore } from "../../store/effectStore";
import { mapStore } from "../../store/mapStore";
import { appState } from "../app/state";
import { StatusPill, icon, toast, type PillState } from "../kit";
import { openAiKeySheet } from "./aiKeySheet";
import { installAcidStyles } from "./acidMode.css";
import { narrateTool } from "../acid/narrate";
import { createVoice, voiceSupported, type VoiceSession } from "../acid/voice";
import type { Router, Screen } from "../app/router";

// Stable id the acid-mode effect is stored + uploaded under, so a session can
// pick up where it left off and the effect is later findable in the library.
const ACID_EFFECT_ID = "acid-mode";
const ACID_EFFECT_NAME = "Acid Mode";

// Persona appended to the agent's system prompt (see generate.chatTurn's
// systemExtra): the user is hands-off, so be proactive and narrate plainly.
const ACID_SYSTEM = `You are now driving "Acid Mode": a hands-free, voice-only surface. The user cannot see or use the normal editor UI right now — they just talk to you and watch a live preview of their LEDs. So:
- Be decisive and PROACTIVE. When they describe a vibe ("something chill and blue", "make it pulse to the beat"), just author it with set_script and send it — don't ask which map or open a dialog. Pick sensible defaults.
- After set_script, the effect is uploaded to their device automatically; a quick capture_preview to confirm it looks right is welcome when visuals matter.
- If they mention knobs/MIDI/controllers, wire them with list_midi_controls + set_midi_mapping.
- Keep spoken replies SHORT, warm, and jargon-free — one or two sentences a zonked human can follow. No code in your replies; the code lives in set_script.`;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AcidModeScreen(router: Router): Screen {
  installAcidStyles();

  const el = document.createElement("div");
  el.className = "screen screen--acid";

  // -- live preview state (mirrors the editor's headless preview path) --------
  const worker = new FxCompilerWorker();
  let currentMap: OutputMap | null = null;
  let mapView: MapView | null = null;
  let positions: Float32Array | null = null;
  let preview: FxPreview | null = null;
  let currentTopo: LedTopology | null = null;
  let topoToken = 0;
  let lastBytecode: Uint8Array | null = null;
  let lastUniforms: FxUniform[] = [];
  let currentSource = "";
  let startT = 0;
  let frame = 0;
  let lastT = 0;
  let raf = 0;
  let disposed = false;

  // -- backdrop canvas + scrim ------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.className = "acid-canvas";
  const scrim = document.createElement("div");
  scrim.className = "acid-scrim";

  // MIDI: turn knobs into live uniform moves (preview + device), just like the
  // editor, but with no on-screen panel to reflect.
  const midiRouter = new MidiRouter((u) => {
    preview?.setUniform(u.slot, u.value);
    const c = appState.client;
    if (c?.isConnected) void c.setUniforms([{ slot: u.slot, value: u.value }]).catch(() => undefined);
  });
  midiRouter.setEffect(ACID_EFFECT_ID);

  // -- overlay: pill + exit ---------------------------------------------------
  const overlay = document.createElement("div");
  overlay.className = "acid-overlay";

  const top = document.createElement("div");
  top.className = "acid-top";
  const pill = StatusPill();
  pill.el.classList.add("acid-pill");
  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.className = "acid-exit";
  exitBtn.textContent = "I'm good ✕";
  exitBtn.addEventListener("click", () => router.back());
  top.append(pill.el, exitBtn);

  const syncPill = (): void => {
    const s = appState.status;
    pill.set(s.state as PillState, s.text);
  };
  const unsubPill = appState.subscribe(syncPill);
  syncPill();

  const title = document.createElement("h1");
  title.className = "acid-title";
  title.textContent = "Acid Mode";
  const sub = document.createElement("p");
  sub.className = "acid-sub";
  sub.textContent = "Tap the mic and just tell me what you want your lights to do.";

  // -- stream-of-consciousness feed ------------------------------------------
  const feed = document.createElement("div");
  feed.className = "acid-feed";

  function scrollFeed(): void {
    feed.scrollTop = feed.scrollHeight;
  }
  function appendMsg(kind: "you" | "agent" | "think", text: string): HTMLElement {
    const m = document.createElement("div");
    m.className = `acid-msg acid-msg--${kind}`;
    m.textContent = text;
    feed.appendChild(m);
    scrollFeed();
    return m;
  }

  // A single live "thinking…" indicator that hops to the bottom while the agent
  // reasons, then gives way to the concrete tool-narration lines.
  let liveThink: HTMLElement | null = null;
  function showThinking(label: string): void {
    if (liveThink === null) {
      liveThink = document.createElement("div");
      liveThink.className = "acid-msg acid-msg--think acid-live";
    }
    liveThink.textContent = label;
    feed.appendChild(liveThink); // moves it to the bottom
    scrollFeed();
  }
  function clearThinking(): void {
    if (liveThink !== null) {
      liveThink.remove();
      liveThink = null;
    }
  }

  // -- mic + fallback ---------------------------------------------------------
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.className = "acid-mic";
  micBtn.setAttribute("aria-label", "Hold to talk");
  micBtn.appendChild(icon("mic"));

  const micHint = document.createElement("div");
  micHint.className = "acid-mic-hint";
  micHint.textContent = "Tap to talk";

  let busy = false;
  let voice: VoiceSession | null = null;

  function setMicListening(on: boolean): void {
    micBtn.classList.toggle("acid-mic--listening", on);
    micHint.textContent = on ? "Listening… tap to stop" : busy ? "Working…" : "Tap to talk";
  }

  if (voiceSupported()) {
    voice = createVoice({
      onPartial: (t) => {
        micHint.textContent = t || "Listening…";
      },
      onFinal: (t) => {
        setMicListening(false);
        const said = t.trim();
        if (said) void ask(said);
      },
      onError: (e) => {
        setMicListening(false);
        micHint.textContent = e === "not-allowed" ? "Mic permission denied" : "Didn't catch that";
      },
    });
    micBtn.addEventListener("click", () => {
      if (busy) return;
      if (voice!.listening) voice!.stop();
      else {
        setMicListening(true);
        voice!.start();
      }
    });
  }

  // Text fallback when speech recognition isn't available (e.g. Firefox).
  const fallback = document.createElement("form");
  fallback.className = "acid-fallback";
  const fallbackInput = document.createElement("input");
  fallbackInput.type = "text";
  fallbackInput.placeholder = "…or type what you want here";
  fallback.appendChild(fallbackInput);
  fallback.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const said = fallbackInput.value.trim();
    if (said && !busy) {
      fallbackInput.value = "";
      void ask(said);
    }
  });
  // With no speech recognition, hide the inert mic and lean on the text box.
  if (voiceSupported()) {
    fallback.style.display = "none";
  } else {
    micBtn.style.display = "none";
    micHint.textContent = "Type below — voice input isn't supported in this browser.";
  }

  overlay.append(top, title, sub, feed, micBtn, micHint, fallback);
  el.append(canvas, scrim, overlay);

  // -- the agent turn ---------------------------------------------------------
  const chatHistory: ChatMessage[] = [];

  async function ask(text: string): Promise<void> {
    if (busy) return;
    if (!getApiKey()) {
      appendMsg("agent", "I need an Anthropic API key first — pop it in and try again.");
      openAiKeySheet();
      return;
    }
    appendMsg("you", text);

    // Ground the turn in the current effect (if any) so refinements build on it.
    const ctx = editorContext({
      source: currentSource || "(no effect yet)",
      compileSummary: lastBytecode
        ? `OK — ${lastUniforms.length} uniforms, ${lastBytecode.length} bytes`
        : "nothing compiled yet",
    });
    chatHistory.push({ role: "user", content: `${ctx}\n\nUser (spoken): ${text}` });

    busy = true;
    micBtn.disabled = true;
    showThinking("Thinking");

    let deviceCosts: string | undefined;
    try {
      const { table, stored } = await costTableStore.resolveTable();
      deviceCosts = builtinCostsToPrompt(table, stored !== null);
    } catch {
      deviceCosts = undefined;
    }

    try {
      const finalText = await chatTurn(
        chatHistory,
        {
          onThinking: () => showThinking("Thinking"),
          onToolUse: (name) => {
            clearThinking();
            appendMsg("think", narrateTool(name));
          },
          onSetScript: (source) => onSetScript(source),
          onCapturePreview: async () => capturePreviewPng(),
          onListMidi: async () => midiListSummary(),
          onSetMidiMapping: async (mappings) => applyMidiMappings(mappings),
          onEstimatePerformance: async () => estimateFleetReport(),
        },
        deviceCosts,
        ACID_SYSTEM,
      );
      clearThinking();
      appendMsg("agent", finalText || "Done.");
    } catch (e) {
      clearThinking();
      appendMsg("agent", `Hmm, that didn't work: ${msg(e)}`);
    } finally {
      busy = false;
      micBtn.disabled = false;
      setMicListening(false);
      scrollFeed();
    }
  }

  // -- tool fulfilment (headless) --------------------------------------------
  async function onSetScript(source: string): Promise<string> {
    currentSource = source;
    const r = await worker.compile(source);
    if (!r.ok) {
      const first = r.diagnostics[0];
      lastBytecode = null;
      return `Compile failed${first ? ` — line ${first.line + 1}: ${first.msg}` : ""}. Fix and retry.`;
    }
    lastBytecode = r.bytecode;
    lastUniforms = r.uniforms;
    await swapPreview(r.bytecode, r.uniforms);
    midiRouter.setManifest(r.uniforms);
    midiStore.autoBind(ACID_EFFECT_ID, r.uniforms.filter(isDrivable).map((u) => u.name));

    // Persist so the effect survives the session + is findable in the library.
    void persistSource(source);

    // Upload to the device (with default uniform values), if connected.
    let deviceNote = "not connected — wrote it but can't send it to a device yet";
    const c = appState.client;
    if (c?.isConnected) {
      try {
        await c.submitEffect(ACID_EFFECT_ID, r.bytecode, true);
        const defaults = r.uniforms.map((u) => ({ slot: u.slot, value: u.default }));
        if (defaults.length > 0) await c.setUniforms(defaults);
        deviceNote = "uploaded + now playing on your device";
        appendMsg("think", "📤 Sent it to your lights");
      } catch (e) {
        deviceNote = `upload failed: ${msg(e)}`;
        appendMsg("think", "⚠️ Couldn't reach your device");
      }
    } else {
      appendMsg("think", "💡 Wrote it (no device connected)");
    }
    return `Compiled OK — ${r.uniforms.length} uniforms, ${r.bytecode.length} bytes; ${deviceNote}.`;
  }

  /** Save the acid effect to the library under a stable id (create if new).
   * `effectStore.save` no-ops for an unknown id, so create it the first time. */
  async function persistSource(source: string): Promise<void> {
    try {
      const existing = await effectStore.get(ACID_EFFECT_ID);
      if (existing) await effectStore.save(ACID_EFFECT_ID, source);
      else {
        const now = new Date().toISOString();
        await effectStore.createWithId({
          id: ACID_EFFECT_ID,
          name: ACID_EFFECT_NAME,
          source,
          tags: ["acid"],
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch {
      // Persistence is best-effort; a failed save must not break the session.
    }
  }

  async function swapPreview(bytecode: Uint8Array, uniforms: FxUniform[]): Promise<void> {
    preview?.dispose();
    preview = await FxPreview.create(bytecode);
    if (disposed) {
      preview.dispose();
      preview = null;
      return;
    }
    for (const u of uniforms) preview.setUniform(u.slot, u.default);
    if (currentTopo !== null) preview.setTopology(currentTopo);
    startT = performance.now();
    frame = 0;
  }

  /** Render the live preview to a PNG data URL for the vision tool. */
  function capturePreviewPng(): string {
    if (preview !== null && mapView !== null && currentMap !== null && positions !== null) {
      const time = (performance.now() - startT) / 1000;
      preview.tick(time, 1 / 60, frame++, currentMap.leds.length);
      mapView.setLedColors(preview.shadeAll(positions));
    }
    return canvas.toDataURL("image/png");
  }

  function midiListSummary(): string {
    void midiManager.enable().catch(() => undefined);
    const uniforms = lastUniforms.filter(isDrivable).map((u) => ({
      name: u.name,
      type: u.ui.kind,
      ...(u.ui.kind === "slider" ? { min: u.ui.min, max: u.ui.max } : {}),
    }));
    const controls = midiStore.semantics().map((s) => ({
      name: s.name,
      source: `${s.control.device} · ${controlLabel(s.control)}`,
    }));
    const current = midiStore.bindings(ACID_EFFECT_ID).map((b) => ({
      uniform: b.uniform,
      control: b.semantic,
    }));
    return JSON.stringify(
      { uniforms, namedControls: controls, currentMappings: current, midiEnabled: midiManager.enabled },
      null,
      2,
    );
  }

  function applyMidiMappings(mappings: MidiMappingCall[]): string {
    const drivable = new Set(lastUniforms.filter(isDrivable).map((u) => u.name));
    const applied: UniformBinding[] = [];
    const skipped: string[] = [];
    for (const m of mappings) {
      if (!drivable.has(m.uniform)) {
        skipped.push(`${m.uniform} (not drivable)`);
        continue;
      }
      applied.push({
        uniform: m.uniform,
        semantic: m.control,
        ...(typeof m.min === "number" ? { min: m.min } : {}),
        ...(typeof m.max === "number" ? { max: m.max } : {}),
        ...(m.invert ? { invert: true } : {}),
      });
    }
    midiStore.replaceBindings(ACID_EFFECT_ID, applied);
    return `Applied ${applied.length} mapping(s)${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}.`;
  }

  async function estimateFleetReport(): Promise<string> {
    if (lastBytecode === null) return "Nothing compiles yet — author an effect first.";
    const fallbackLeds = currentMap ? currentMap.leds.length : 256;
    const targets = await resolveFleetTargets(fallbackLeds);
    return describeFleet(estimateAcrossDevices(lastBytecode, targets));
  }

  // -- map + animation loop ---------------------------------------------------
  function loadMap(map: OutputMap, topology?: Topology): void {
    currentMap = map;
    positions = new Float32Array(map.leds.length * 3);
    for (let i = 0; i < map.leds.length; i++) {
      const p = map.leds[i]!.xyz;
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
    }
    if (mapView === null) {
      mapView = new MapView(canvas, map);
      // Acid Mode is a full-screen immersive visual — drop the solver-stats
      // footer + "drag orbit …" hint regardless of the Appearance default.
      mapView.showStats = false;
      mapView.setLedColors(new Uint8Array(map.leds.length * 3));
      mapView.start();
    } else {
      mapView.update(map);
      mapView.setLedColors(new Uint8Array(map.leds.length * 3));
    }
    void refreshTopology(map, topology);
  }

  async function refreshTopology(map: OutputMap, topology?: Topology): Promise<void> {
    const token = ++topoToken;
    let topo = topology;
    if (!topo || topo.segments.length === 0) {
      topo = await extractTopology(map).catch(() => undefined);
    }
    if (token !== topoToken || disposed || currentMap !== map) return;
    currentTopo = deriveLedTopology(map, topo);
    preview?.setTopology(currentTopo);
  }

  function tick(t: number): void {
    raf = requestAnimationFrame(tick);
    const dt = lastT === 0 ? 16 : Math.min(100, t - lastT);
    lastT = t;
    if (preview === null || mapView === null || currentMap === null || positions === null) return;
    const time = (t - startT) / 1000;
    preview.tick(time, dt / 1000, frame++, currentMap.leds.length);
    mapView.setLedColors(preview.shadeAll(positions));
  }

  // Pick the most-recent map for the backdrop, else a sample fixture.
  async function initMap(): Promise<void> {
    try {
      const id = appState.selectedMapId ?? (await mapStore.list({ sort: "updated" }))[0]?.id ?? null;
      const rec = id ? await mapStore.get(id) : undefined;
      if (disposed) return;
      if (rec) loadMap(rec.map, rec.topology);
      else loadMap(generateFixture("tree", { count: 160, seed: 3, jitterFrac: 0.06 }));
    } catch {
      if (!disposed) loadMap(generateFixture("tree", { count: 160, seed: 3, jitterFrac: 0.06 }));
    }
  }

  return {
    el,
    onMount: () => {
      void initMap();
      raf = requestAnimationFrame(tick);
      midiRouter.attach();
      if (!getApiKey()) {
        appendMsg(
          "agent",
          "Heads up: add an Anthropic API key (⋯ → AI settings) and I can start making lights for you.",
        );
      }
    },
    onUnmount: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unsubPill();
      midiRouter.detach();
      voice?.stop();
      preview?.dispose();
      mapView?.stop();
      worker.dispose();
      toast("Left Acid Mode");
    },
  };
}
