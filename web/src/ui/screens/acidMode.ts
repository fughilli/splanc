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
import { FxPreview, deriveLedTopology, warningsFeedback, type FxUniform, type LedTopology } from "../../fx/preview";
import { MapView } from "../mapview";
import { generateFixture } from "../../effects/fixtures";
import { extractTopology } from "../../topology/extract";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import {
  chatTurn,
  editorContext,
  type ChatMessage,
  type MidiMappingCall,
  type MeasureOnDeviceCall,
} from "../../effects/ai/generate";
import { isAiConfigured, type AiProvider } from "../../effects/ai/provider";
import { captureDemoPreview, isDemoAiBusy, makeDemoProvider, DEMO_AI_ENDPOINT } from "../../effects/ai/providers/demo";
import {
  ACID_FREE_TIMEOUT_MS,
  ACID_PLAY_BUDGET_LEDS,
  ACID_PLAY_EXAMPLES,
  ACID_PLAY_MAX_BUDGET_FRACTION,
  ACID_PLAY_SYSTEM,
  ACID_PLAY_TURN,
  ACID_PLAY_HISTORY_WISHES,
  ACID_SYSTEM,
  scriptAccepted,
  trimToRecentWishes,
} from "../../effects/ai/acidPersona";
import { fallbackTarget, resolveFleetTargets } from "../../effects/fleet";
import { estimateAcrossDevices, describeFleet } from "../../effects/multiDevice";
import { costTableStore } from "../../store/costTableStore";
import { builtinCostsToPrompt } from "../../effects/perfContext";
import { estimateFrameTime } from "../../effects/costModel";
import {
  canMeasure,
  measureOnDevice,
  perfDeviceFromClient,
  resolveUniforms,
  withDeviceLock,
} from "../../effects/devicePerf";
import { isDrivable, MidiRouter } from "../../midi/router";
import { midiStore, type UniformBinding } from "../../store/midiStore";
import { midiManager, controlLabel } from "../../midi/manager";
import { effectStore } from "../../store/effectStore";
import { chatLogStore, newChatLogSessionId } from "../../store/chatLogStore";
import { registerChatDriver } from "../../net/remoteChat";
import { mapStore } from "../../store/mapStore";
import { deviceMaps } from "./deviceMapCard";
import { appState } from "../app/state";
import { StatusPill, confirmDialog, icon, toast, type PillState } from "../kit";
import { aiSummary, appFileBugHook, confirmFilingText } from "../../bugs/appBugReport";
import { installAcidStyles } from "./acidMode.css";
import { narrateTool } from "../acid/narrate";
import { createVoice, voiceSupported, type VoiceSession } from "../acid/voice";
import { guardVerdict } from "../acid/playGuard";
import { createAcidKioskCountdown, type AcidPlayExtra } from "../acid/playExtras";
import type { Router, Screen } from "../app/router";

// Stable id the acid-mode effect is stored + uploaded under, so a session can
// pick up where it left off and the effect is later findable in the library.
const ACID_EFFECT_ID = "acid-mode";
const ACID_EFFECT_NAME = "Acid Mode";

// Personas live in effects/ai/acidPersona.ts (pure, unit-tested): ACID_SYSTEM for
// the owner's hands-free mode, ACID_PLAY_SYSTEM for a Halloween visitor.

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface AcidModeOptions {
  /** `#/acid?play=1`: a visitor at a kiosk install — minimal chrome, a Halloween
   * persona, the free AI with a one-request turn budget, and guarded uploads. */
  play?: boolean;
}

export function AcidModeScreen(router: Router, opts: AcidModeOptions = {}): Screen {
  installAcidStyles();
  const play = opts.play === true;

  const el = document.createElement("div");
  el.className = play ? "screen screen--acid acid--play" : "screen screen--acid";
  el.dataset["state"] = "idle";

  // No provider configured → the hosted demo AI (docs/design/effects-demo.md):
  // zero setup for a stranger. Play mode sees previews too (the owner, 2026-10-31:
  // a visitor's conversation should be as good as the editor's).
  const demoProvider = makeDemoProvider(DEMO_AI_ENDPOINT, {
    timeoutMs: ACID_FREE_TIMEOUT_MS,
    ...(play ? { maxTokens: ACID_PLAY_TURN.maxTokens } : {}),
  });
  const freeAi = (): AiProvider | undefined => (isAiConfigured() ? undefined : demoProvider);

  // -- live preview state (mirrors the editor's headless preview path) --------
  const worker = new FxCompilerWorker();
  let currentMap: OutputMap | null = null;
  let mapView: MapView | null = null;
  let positions: Float32Array | null = null;
  let preview: FxPreview | null = null;
  let currentTopo: LedTopology | null = null;
  let topoToken = 0;
  let lastBytecode: Uint8Array | null = null;
  /** The last clean compile's warnings (the estimate's findings read the perf ones). */
  let lastWarnings: { line: number; col: number; msg: string }[] = [];
  /** The program last uploaded to the device (measure_on_device skips re-upload). */
  let uploadedFxb: Uint8Array | null = null;
  let lastUniforms: FxUniform[] = [];
  let currentSource = "";
  /** The last source that compiled AND passed the guard (what the fixture plays). */
  let lastGoodSource = "";
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
    if (c?.isConnected) c.live.setUniform(u.slot, u.value);
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
  exitBtn.textContent = play ? "← Back to the show" : "I'm good ✕";
  exitBtn.addEventListener("click", () => router.back());
  top.append(pill.el);
  // Kiosk idle countdown, supplied by play mode (see acid/playExtras.ts).
  let kioskExtra: AcidPlayExtra | null = null;
  if (play) {
    kioskExtra = createAcidKioskCountdown();
    if (kioskExtra) {
      kioskExtra.el.classList.add("acid-kiosk");
      top.append(kioskExtra.el);
    }
  }
  top.append(exitBtn);

  const syncPill = (): void => {
    const s = appState.status;
    pill.set(s.state as PillState, s.text);
  };
  const unsubPill = appState.subscribe(() => {
    syncPill();
    if (play && !playMapIsFixture) void loadFixtureMap();
  });
  syncPill();

  const title = document.createElement("h1");
  title.className = "acid-title";
  title.textContent = play ? "🎤 Acid Mode" : "Acid Mode";
  const sub = document.createElement("p");
  sub.className = "acid-sub";
  sub.textContent = play
    ? "Tap the mic and tell the lights what to do. Try:"
    : "Tap the mic and just tell me what you want your lights to do.";

  // Play mode: three tappable example prompts (also the no-mic path).
  const examples = document.createElement("div");
  examples.className = "acid-examples";
  if (play) {
    for (const ex of ACID_PLAY_EXAMPLES) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "acid-example";
      chip.textContent = `“${ex}”`;
      chip.addEventListener("click", () => void ask(ex));
      examples.appendChild(chip);
    }
  }

  // "AI is busy" card: the shared free quota ran out or every model is down.
  const busyCard = document.createElement("div");
  busyCard.className = "acid-busy";
  busyCard.hidden = true;
  const busyText = document.createElement("p");
  busyText.textContent = play
    ? "The AI is busy right now — try one of the spooky presets!"
    : "The free AI is busy right now. Try again in a minute, or set up your own AI provider.";
  const busyBtn = document.createElement("button");
  busyBtn.type = "button";
  busyBtn.className = "acid-busy-btn";
  busyBtn.textContent = play ? "🎃 Spooky presets" : "AI settings";
  busyBtn.addEventListener("click", () => {
    if (play) router.back();
    else location.hash = "#/settings/ai";
  });
  busyCard.append(busyText, busyBtn);

  // Small free-AI disclosure (only shown while the free demo AI is in use).
  const freeNote = document.createElement("details");
  freeNote.className = "acid-free-note";
  const freeSummary = document.createElement("summary");
  freeSummary.textContent = "Free AI · shared & limited";
  const freeText = document.createElement("p");
  freeText.textContent =
    "Your words and the effect code go to OpenRouter and its free model providers, which may use them for model improvement. Don’t share private or personal information.";
  freeNote.append(freeSummary, freeText);

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
  let acidHasRealStatus = false;
  function showThinking(label: string): void {
    // "Thinking…" is soft: once a streamed status (tool verb / model summary)
    // shows, don't let a later "Thinking…" flick over it (reset each tool round).
    if (label === "Thinking…" && acidHasRealStatus) return;
    if (label !== "Thinking…") acidHasRealStatus = true;
    if (liveThink === null) {
      liveThink = document.createElement("div");
      liveThink.className = "acid-msg acid-msg--think acid-live";
    }
    liveThink.textContent = label;
    feed.appendChild(liveThink); // moves it to the bottom
    scrollFeed();
  }
  function clearThinking(): void {
    acidHasRealStatus = false;
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
  /** Set by a recognition error so the following end/final doesn't overwrite it. */
  let voiceError: string | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | undefined;

  /** One visible state for the whole surface: idle → listening → thinking → done. */
  type AcidState = "idle" | "listening" | "thinking" | "done" | "busy";
  function setState(state: AcidState, hint?: string): void {
    el.dataset["state"] = state;
    if (doneTimer !== undefined) clearTimeout(doneTimer);
    micBtn.classList.toggle("acid-mic--listening", state === "listening");
    micBtn.classList.toggle("acid-mic--thinking", state === "thinking");
    micBtn.setAttribute("aria-label", state === "listening" ? "Stop listening" : "Tap to talk");
    micHint.textContent =
      hint ??
      (state === "listening"
        ? "Listening… tap when you're done"
        : state === "thinking"
          ? "✨ Making it…"
          : state === "done"
            ? "✓ Done! Tap to try another"
            : "Tap to talk");
    // "Done" relaxes back to idle so the next visitor sees a plain prompt.
    if (state === "done") doneTimer = setTimeout(() => setState("idle"), 8000);
  }
  function setMicListening(on: boolean): void {
    setState(on ? "listening" : busy ? "thinking" : "idle");
  }

  if (voiceSupported()) {
    voice = createVoice({
      onPartial: (t) => {
        micHint.textContent = t || "Listening…";
      },
      onFinal: (t) => {
        const said = t.trim();
        if (said) {
          voiceError = null;
          void ask(said);
          return;
        }
        // Keep an error's hint (web fires onerror THEN onend → onFinal("")).
        if (voiceError !== null) setState("idle", voiceError);
        else setState("idle", "Didn't hear anything — tap and talk");
      },
      onError: (e) => {
        if (e === "not-allowed" || e === "service-not-allowed") {
          voiceError = "Mic is blocked — type it below instead";
          fallback.style.display = ""; // reveal the text box
        } else if (e === "no-speech") voiceError = "Didn't hear anything — tap and talk";
        else if (e === "aborted") voiceError = null;
        else voiceError = "Didn't catch that — tap to try again";
        setState("idle", voiceError ?? undefined);
      },
    });
    // The first tap starts listening (the browser asks for the mic once, here,
    // inside the gesture); a second tap ends the utterance.
    micBtn.addEventListener("click", () => {
      if (busy) return;
      if (voice!.listening) voice!.stop();
      else {
        voiceError = null;
        setState("listening");
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
    micHint.textContent = play
      ? "Tap an idea above, or type your own below."
      : "Type below — voice input isn't supported in this browser.";
  }

  overlay.append(top, title, sub);
  if (play) overlay.append(examples);
  overlay.append(feed, busyCard, micBtn, micHint, fallback, freeNote);
  el.append(canvas, scrim, overlay);

  // -- the agent turn ---------------------------------------------------------
  const chatHistory: ChatMessage[] = [];
  // Persisted-log bookkeeping (see chatLogStore) — one session per acid screen.
  const chatLogSessionId = newChatLogSessionId();
  let chatTurns = 0;
  let unregisterChatDriver: (() => void) | null = null;

  async function ask(text: string): Promise<void> {
    if (busy) return;
    const provider = freeAi();
    freeNote.hidden = provider === undefined;
    busyCard.hidden = true;
    appendMsg("you", text);

    // Ground the turn in the current effect (if any) so refinements build on it.
    // Play mode grounds in the last GOOD effect (what the lights play) and keeps
    // the conversation (each visitor is on their own phone), trimmed to the last
    // ACID_PLAY_HISTORY_WISHES wishes so requests stay quick.
    const groundSource = play ? lastGoodSource : currentSource;
    const ctx = editorContext({
      source: groundSource || "(no effect yet)",
      compileSummary: play
        ? groundSource ? "OK (playing now)" : "nothing playing yet"
        : lastBytecode
          ? `OK — ${lastUniforms.length} uniforms, ${lastBytecode.length} bytes`
          : "nothing compiled yet",
    });
    if (play) trimToRecentWishes(chatHistory, ACID_PLAY_HISTORY_WISHES - 1);
    const historyBefore = chatHistory.length;
    const previewNote = play
      ? playMapIsFixture
        ? `\n\nPreview: the fixture's real layout (${currentMap?.leds.length ?? 0} LEDs).`
        : "\n\nPreview: a stand-in grid (the fixture's layout isn't available)."
      : "";
    chatHistory.push({ role: "user", content: `${ctx}${previewNote}\n\nUser (spoken): ${text}` });

    busy = true;
    micBtn.disabled = true;
    setState("thinking");
    chatTurns += 1;
    let turnError: string | undefined;
    const goodBefore = lastGoodSource;
    showThinking("Thinking");

    let deviceCosts: string | undefined;
    if (!play) {
      try {
        const { table, stored } = await costTableStore.resolveTable();
        deviceCosts = builtinCostsToPrompt(table, stored !== null);
      } catch {
        deviceCosts = undefined;
      }
    }

    try {
      const finalText = await chatTurn(
        chatHistory,
        {
          onThinking: () => showThinking("Thinking…"),
          // Live streamed status (thinking → tool verb → the model's summary).
          onStatus: (label) => showThinking(label),
          onToolUse: (name) => {
            clearThinking();
            appendMsg("think", narrateTool(name));
          },
          onSetScript: (source) => onSetScript(source),
          onCapturePreview: async () => capturePreviewPng(provider !== undefined),
          // Tool groups. The free relay allows only set_script, capture_preview,
          // estimate_performance and the two MIDI tools, so measure_on_device and
          // file_bug are configured-provider only (an anonymous visitor must not
          // file GitHub issues). Play mode keeps just set_script: the guard runs
          // the estimate itself, and every extra tool round is another request.
          ...(play
            ? {}
            : {
                onListMidi: async () => midiListSummary(),
                onSetMidiMapping: async (mappings: MidiMappingCall[]) => applyMidiMappings(mappings),
                onEstimatePerformance: async () => estimateFleetReport(),
              }),
          ...(provider === undefined && canMeasure(perfDeviceFromClient(appState.client))
            ? { onMeasureOnDevice: async (args: MeasureOnDeviceCall) => measureOnFixture(args) }
            : {}),
          ...(provider === undefined
            ? {
                onFileBug: appFileBugHook({
                  surface: "web-acid",
                  source: () => currentSource,
                  client: () => appState.client,
                  ai: aiSummary,
                  confirm: (issue) => confirmDialog({ ...confirmFilingText(issue), trippy: true }),
                }),
              }
            : {}),
        },
        deviceCosts,
        play ? ACID_PLAY_SYSTEM : ACID_SYSTEM,
        provider,
        play ? { ...ACID_PLAY_TURN, finishAfterScript: scriptAccepted } : {},
      );
      clearThinking();
      if (play && lastGoodSource === goodBefore) {
        // Nothing new reached the lights (compile error / guard): say so kindly.
        appendMsg("agent", "That one didn't come out right, so the lights kept the last effect. Try saying it another way!");
        setState("idle");
      } else {
        appendMsg("agent", finalText || "Done.");
        setState("done");
      }
    } catch (e) {
      clearThinking();
      turnError = msg(e);
      // Never leave a half-finished turn in a play conversation.
      if (play) chatHistory.length = Math.min(chatHistory.length, historyBefore);
      if (isDemoAiBusy(e)) {
        // Quota / rate limit / every model down or slow: point at the presets.
        busyCard.hidden = false;
        setState("busy", e.retryAfterS ? `Try again in ${Math.ceil(e.retryAfterS)}s` : "Try again in a minute");
      } else {
        appendMsg("agent", play ? "Hmm, that didn't work — try again, or pick a preset!" : `Hmm, that didn't work: ${turnError}`);
        setState("idle");
      }
    } finally {
      busy = false;
      micBtn.disabled = false;
      scrollFeed();
      // Snapshot the transcript for off-device debugging. Best-effort.
      void chatLogStore.record({
        id: chatLogSessionId,
        screen: "acidMode",
        effectId: ACID_EFFECT_ID,
        effectName: "Acid Mode",
        turns: chatTurns,
        errored: turnError !== undefined,
        lastError: turnError,
        messages: chatHistory,
      });
    }
  }

  // -- tool fulfilment (headless) --------------------------------------------
  async function onSetScript(source: string): Promise<string> {
    currentSource = source;
    const r = await worker.compile(source);
    if (!r.ok) {
      const first = r.diagnostics[0];
      lastBytecode = null;
      return `Compile failed${first ? ` — line ${first.line}: ${first.msg}` : ""}. Fix and retry.`;
    }
    // Play mode: refuse a dark or hopelessly slow effect before it touches the
    // preview or the fixture, so the last good effect keeps playing.
    if (play) {
      const refused = await playGuard(r.bytecode, r.uniforms);
      if (refused !== null) {
        appendMsg("think", "🔁 Not quite right — trying again");
        return refused;
      }
    }
    lastBytecode = r.bytecode;
    lastWarnings = r.warnings ?? [];
    lastUniforms = r.uniforms;
    lastGoodSource = source;
    await swapPreview(r.bytecode, r.uniforms);
    midiRouter.setManifest(r.uniforms);
    midiStore.autoBind(ACID_EFFECT_ID, r.uniforms.filter(isDrivable).map((u) => u.name));

    // Persist so the effect survives the session + is findable in the library
    // (not for a kiosk visitor: their phone's library is not the owner's).
    if (!play) void persistSource(source);

    // Upload to the device (with default uniform values), if connected.
    let deviceNote = "not connected — wrote it but can't send it to a device yet";
    const c = appState.client;
    if (c?.isConnected) {
      try {
        await withDeviceLock(() => c.submitEffect(ACID_EFFECT_ID, r.bytecode, true));
        uploadedFxb = r.bytecode;
        const defaults = r.uniforms.map((u) => ({ slot: u.slot, value: u.default }));
        if (defaults.length > 0) c.setUniforms(defaults);
        deviceNote = "uploaded + now playing on your device";
        appendMsg("think", "📤 Sent it to your lights");
      } catch (e) {
        deviceNote = `upload failed: ${msg(e)}`;
        appendMsg("think", "⚠️ Couldn't reach your device");
      }
    } else {
      appendMsg("think", "💡 Wrote it (no device connected)");
    }
    return `Compiled OK — ${r.uniforms.length} uniforms, ${r.bytecode.length} bytes; ${deviceNote}.${warningsFeedback(r.warnings)}`;
  }

  /** Run a candidate on a throwaway preview: sample a few frames for darkness and
   * estimate its C6 cost for an unmapped curtain + rope (playGuard.ts). */
  async function playGuard(bytecode: Uint8Array, uniforms: FxUniform[]): Promise<string | null> {
    const frames: Uint8Array[] = [];
    if (currentMap !== null && positions !== null) {
      let probe: FxPreview | null = null;
      try {
        probe = await FxPreview.create(bytecode);
        for (const u of uniforms) probe.setUniform(u.slot, u.default);
        if (currentTopo !== null) probe.setTopology(currentTopo);
        const n = currentMap.leds.length;
        // Advance ~2 s at 30 fps, sampling a few frames (fade-ins start dark).
        for (let f = 0; f <= 60; f++) {
          probe.tick(f / 30, 1 / 30, f, n);
          if (f === 1 || f === 20 || f === 40 || f === 60) frames.push(probe.shadeAll(positions).slice());
        }
      } catch {
        // A preview failure is not proof of darkness; let the estimate decide.
      } finally {
        probe?.dispose();
      }
    }
    let fraction = Number.NaN;
    try {
      const { table, stored } = await costTableStore.resolveTable();
      const leds = Math.max(currentMap?.leds.length ?? 0, ACID_PLAY_BUDGET_LEDS);
      const est = estimateAcrossDevices(bytecode, [fallbackTarget(table, leds, stored !== null)]);
      fraction = est.binding?.budget.fraction ?? Number.NaN;
    } catch {
      fraction = 0; // no cost model available: don't block on it
    }
    return guardVerdict({ frames, budgetFraction: fraction, maxBudgetFraction: ACID_PLAY_MAX_BUDGET_FRACTION });
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

  /** Render the live preview to a PNG data URL for the vision tool (a bounded
   * JPEG for the free relay, which caps request size). */
  function capturePreviewPng(bounded = false): string {
    if (preview !== null && mapView !== null && currentMap !== null && positions !== null) {
      const time = (performance.now() - startT) / 1000;
      preview.tick(time, 1 / 60, frame++, currentMap.leds.length);
      mapView.setLedColors(preview.shadeAll(positions));
    }
    return bounded ? captureDemoPreview(canvas) : canvas.toDataURL("image/png");
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
    return describeFleet(estimateAcrossDevices(lastBytecode, targets), {
      bytecode: lastBytecode,
      source: currentSource,
      warnings: lastWarnings,
    });
  }

  /** measure_on_device: set_script already uploads, so this usually just
   * captures the device's perf stream for the playing program. */
  async function measureOnFixture(args: MeasureOnDeviceCall): Promise<string> {
    const bytecode = lastBytecode;
    if (bytecode === null) return "Nothing compiles yet — author an effect first.";
    const { table, stored } = await costTableStore.resolveTable();
    const { values, unknown } = resolveUniforms(args.uniforms, lastUniforms);
    const r = await measureOnDevice(perfDeviceFromClient(appState.client), {
      effectId: ACID_EFFECT_ID,
      bytecode,
      alreadyRunning: uploadedFxb === bytecode,
      seconds: args.seconds,
      uniforms: values,
      table,
      calibrated: stored !== null,
      predict: (ledCount) => {
        const est = estimateFrameTime({ bytecode, ledCount, table });
        return { totalMs: est.totalMs, lowMs: est.errorBand.lowMs, highMs: est.errorBand.highMs };
      },
    });
    if (r.deployed) uploadedFxb = bytecode;
    return unknown.length > 0 ? `${r.text}\n(Ignored unknown uniforms: ${unknown.join(", ")}.)` : r.text;
  }

  // -- map + animation loop ---------------------------------------------------
  function loadMap(map: OutputMap, topology?: Topology): void {
    mapView?.setMesh(null);
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
    if (topo === undefined) {
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

  /** Play mode: show the connected Halloween fixture's own layout (the map it
   * stores; play mode's screen fetched it already, else fetch it now). Keeps the
   * stand-in grid when there's no fixture or it has no map. */
  let playMapIsFixture = false;
  let fixtureMapClient: unknown = null;
  async function loadFixtureMap(): Promise<void> {
    const c = appState.client;
    if (!c || c === fixtureMapClient) return;
    fixtureMapClient = c;
    try {
      const id = await deviceMaps.ensureLocal(c);
      const rec = await mapStore.get(id);
      if (disposed || appState.client !== c || !rec) return;
      loadMap(rec.map, rec.topology);
      mapView?.setMesh(rec.mesh ?? null);
      playMapIsFixture = true;
    } catch {
      // No stored map / older firmware / link dropped: the grid stays.
    }
  }

  // Pick the most-recent map for the backdrop, else a sample fixture.
  async function initMap(): Promise<void> {
    // Play mode: a serpentine grid reads like the curtain (and doubles as the
    // darkness probe's positions) until the connected fixture's own layout loads.
    if (play) {
      loadMap(generateFixture("grid", { count: 240, seed: 31, jitterFrac: 0.04 }));
      void loadFixtureMap();
      return;
    }
    try {
      const id = appState.selectedMapId ?? (await mapStore.list({ sort: "updated" }))[0]?.id ?? null;
      const rec = id ? await mapStore.get(id) : undefined;
      if (disposed) return;
      if (rec) {
        loadMap(rec.map, rec.topology);
        mapView?.setMesh(rec.mesh ?? null);
      }
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
      // Remote chat drive (repro-on-device): feed queued prompts into ask().
      unregisterChatDriver = registerChatDriver((text) => ask(text));
      freeNote.hidden = isAiConfigured();
      if (!play && !isAiConfigured()) {
        appendMsg("agent", "Using the free AI — no setup needed. (Add your own in ⋯ → AI settings for more.)");
      }
    },
    onUnmount: () => {
      disposed = true;
      unregisterChatDriver?.();
      kioskExtra?.dispose?.();
      if (doneTimer !== undefined) clearTimeout(doneTimer);
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
