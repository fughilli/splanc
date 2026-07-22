/**
 * In-shell effect editor (replaces the detached /editor.html) — a first-class,
 * routed screen at #/effects/edit/:id. It loads the effect's `source` from the
 * EffectStore, compiles it off-thread (FxCompilerWorker) on idle, previews it
 * with the EXACT firmware VM (FxPreview) over a map, and autosaves edits back to
 * the store. When a device is connected (appState.client) it can push the
 * compiled .fxb and live uniform values.
 *
 * The editor NEVER requires selecting a map first: it defaults to the seeded
 * sample map (or a generated fixture if the library is empty). The AI generate
 * box (ask → stream → deferred compile → repair) surfaces the BYO-key input and
 * a first-run hint when no key is set.
 *
 * Wiring is ported from src/effects/editor/main.ts — same modules, reshaped into
 * the app shell with kit components and CSS tokens.
 */

import type { OutputMap } from "@ledmapper/protocol";
import { FxPreview, type FxUniform } from "../../fx/preview";
import { MapView } from "../mapview";
import { generateFixture } from "../../effects/fixtures";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { UniformPanel } from "../../effects/editor/uniform-panel";
import {
  askTurn,
  generate,
  getApiKey,
  repairTurn,
  type Turn,
} from "../../effects/ai/generate";
import { effectStore } from "../../store/effectStore";
import { mapStore } from "../../store/mapStore";
import { appState } from "../app/state";
import { Button, Card, Field } from "../kit";
import { openAiKeySheet } from "./aiKeySheet";
import type { Router, Screen } from "../app/router";

const COMPILE_DEBOUNCE_MS = 300;
const SAVE_DEBOUNCE_MS = 800;
const REPAIR_ROUNDS = 2;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function EffectEditorScreen(router: Router, effectId: string): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--fxedit";

  // -- live state -----------------------------------------------------------
  const worker = new FxCompilerWorker();
  let currentMap: OutputMap | null = null;
  let mapView: MapView | null = null;
  let positions: Float32Array | null = null;
  let preview: FxPreview | null = null;
  let lastManifest: FxUniform[] = [];
  let lastT = 0;
  let frame = 0;
  let startT = 0;
  let compileTimer: number | null = null;
  let saveTimer: number | null = null;
  let compileSeq = 0;
  let aiTurns: Turn[] = [];
  let raf = 0;
  let disposed = false;

  // -- DOM ------------------------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.className = "fxedit-canvas";
  canvas.width = 640;
  canvas.height = 420;

  const nameField = Field({ label: "Effect name", placeholder: "My effect" });
  nameField.el.classList.add("fxedit-name");
  nameField.input.addEventListener("change", () => {
    void effectStore.rename(effectId, nameField.input.value.trim() || "Untitled effect");
  });

  const codeEl = document.createElement("textarea");
  codeEl.className = "fxedit-code";
  codeEl.spellcheck = false;
  codeEl.autocapitalize = "off";
  codeEl.setAttribute("autocomplete", "off");

  const statusEl = document.createElement("div");
  statusEl.className = "fxedit-status";

  const uniformsHost = document.createElement("div");
  uniformsHost.className = "uniform-panel";
  const uniHint = document.createElement("p");
  uniHint.className = "fxedit-muted";
  uniHint.textContent = "Compile a script to see its controls.";
  uniformsHost.appendChild(uniHint);

  const diagsEl = document.createElement("ul");
  diagsEl.className = "fxedit-diags";

  const panel = new UniformPanel(uniformsHost, (slot, value) => {
    preview?.setUniform(slot, value);
    const c = appState.client;
    if (c?.isConnected) void c.setUniforms([{ slot, value }]).catch(() => undefined);
  });

  // -- AI section -----------------------------------------------------------
  const aiHint = document.createElement("div");
  aiHint.className = "fxedit-aihint";
  const aiAsk = document.createElement("textarea");
  aiAsk.className = "fxedit-ask";
  aiAsk.rows = 2;
  aiAsk.placeholder = "gentle blue breathing along the trunk";
  const aiNotes = document.createElement("div");
  aiNotes.className = "fxedit-muted";
  const aiBtn = Button({ label: "Generate with AI", icon: "sparkles", onClick: () => void runAi() });

  function refreshAiHint(): void {
    aiHint.replaceChildren();
    if (getApiKey()) return;
    const span = document.createElement("span");
    span.textContent = "Add your Anthropic key to generate effects with AI. ";
    const link = document.createElement("button");
    link.type = "button";
    link.className = "fxedit-link";
    link.textContent = "Add key";
    link.addEventListener("click", () => openAiKeySheet(() => refreshAiHint()));
    aiHint.append(span, link);
  }

  // -- device section -------------------------------------------------------
  const devStatus = document.createElement("div");
  devStatus.className = "fxedit-muted";
  const sendBtn = Button({ label: "Send to device", icon: "upload", onClick: () => void sendToDevice() });
  const hydrateBtn = Button({ label: "Load uniforms", icon: "download", variant: "quiet", onClick: () => void hydrateFromDevice() });

  function refreshDevice(): void {
    const connected = appState.client?.isConnected ?? false;
    sendBtn.disabled = !connected;
    hydrateBtn.disabled = !connected;
    if (!connected) devStatus.textContent = "Connect a device (tap the status pill) to send this effect.";
  }

  // -- map picker -----------------------------------------------------------
  const mapPicker = document.createElement("select");
  mapPicker.className = "fxedit-mappick";

  async function populateMapPicker(): Promise<string | null> {
    const maps = await mapStore.list({ sort: "updated" });
    mapPicker.replaceChildren();
    const fixtureOpt = document.createElement("option");
    fixtureOpt.value = "__fixture__";
    fixtureOpt.textContent = "Sample fixture (tree)";
    mapPicker.appendChild(fixtureOpt);
    for (const m of maps) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.name;
      mapPicker.appendChild(o);
    }
    // Default: the workspace-selected map, else the first library map, else the
    // synthetic fixture — so the editor is always usable with no setup.
    return appState.selectedMapId ?? maps[0]?.id ?? null;
  }

  mapPicker.addEventListener("change", () => void selectMap(mapPicker.value));

  async function selectMap(id: string): Promise<void> {
    if (id === "__fixture__") {
      loadMap(generateFixture("tree", { count: 160, seed: 3, jitterFrac: 0.06 }));
      return;
    }
    const rec = await mapStore.get(id);
    if (rec) loadMap(rec.map);
    else loadMap(generateFixture("tree", { count: 160, seed: 3, jitterFrac: 0.06 }));
  }

  function loadMap(map: OutputMap): void {
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
      mapView.setLedColors(new Uint8Array(map.leds.length * 3));
      mapView.start();
    } else {
      mapView.update(map);
      mapView.setLedColors(new Uint8Array(map.leds.length * 3));
    }
  }

  // -- compile --------------------------------------------------------------
  function setStatus(text: string, cls: "ok" | "err"): void {
    statusEl.textContent = text;
    statusEl.className = `fxedit-status fxedit-status--${cls}`;
  }

  function scheduleCompile(): void {
    if (compileTimer !== null) clearTimeout(compileTimer);
    compileTimer = window.setTimeout(() => void compileNow(), COMPILE_DEBOUNCE_MS);
  }

  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void effectStore.save(effectId, codeEl.value);
    }, SAVE_DEBOUNCE_MS);
  }

  async function compileNow(): Promise<void> {
    const src = codeEl.value;
    const seq = ++compileSeq;
    const r = await worker.compile(src);
    if (seq !== compileSeq || disposed) return;

    renderDiagnostics(r.diagnostics);
    if (!r.ok) {
      const first = r.diagnostics[0];
      setStatus(first ? `line ${first.line + 1}: ${first.msg}` : "compile failed", "err");
      return;
    }
    setStatus(`compiled · ${r.uniforms.length} uniforms`, "ok");
    panel.setManifest(r.uniforms);
    lastManifest = r.uniforms;
    await swapPreview(r.bytecode);
  }

  async function swapPreview(bytecode: Uint8Array): Promise<void> {
    preview?.dispose();
    preview = await FxPreview.create(bytecode);
    if (disposed) {
      preview.dispose();
      preview = null;
      return;
    }
    for (const { slot, value } of panel.values()) preview.setUniform(slot, value);
    startT = performance.now();
    frame = 0;
  }

  function renderDiagnostics(diags: { line: number; col: number; msg: string }[]): void {
    diagsEl.replaceChildren();
    for (const d of diags) {
      const li = document.createElement("li");
      li.textContent = `line ${d.line + 1}, col ${d.col + 1}: ${d.msg}`;
      diagsEl.appendChild(li);
    }
  }

  // -- animation ------------------------------------------------------------
  function tick(t: number): void {
    raf = requestAnimationFrame(tick);
    const dt = lastT === 0 ? 16 : Math.min(100, t - lastT);
    lastT = t;
    if (preview === null || mapView === null || currentMap === null || positions === null) return;
    const time = (t - startT) / 1000;
    preview.tick(time, dt / 1000, frame++, currentMap.leds.length);
    mapView.setLedColors(preview.shadeAll(positions));
  }

  // -- AI -------------------------------------------------------------------
  async function runAi(): Promise<void> {
    if (!getApiKey()) {
      openAiKeySheet(() => refreshAiHint());
      return;
    }
    const ask = aiAsk.value.trim();
    if (!ask) return;
    aiBtn.disabled = true;
    aiNotes.textContent = "Generating…";
    const turn = askTurn(ask, aiTurns.length > 0 ? codeEl.value : undefined);
    try {
      let result = await streamInto([...aiTurns, turn]);
      aiTurns = [...aiTurns, turn, { role: "assistant", content: result.script }];
      for (let round = 0; round < REPAIR_ROUNDS; round++) {
        const c = await worker.compile(codeEl.value);
        if (c.ok) break;
        aiNotes.textContent = `Repairing (round ${round + 1})…`;
        const rt = repairTurn(codeEl.value, c.diagnostics);
        result = await streamInto([...aiTurns, rt]);
        aiTurns = [...aiTurns, rt, { role: "assistant", content: result.script }];
      }
      aiNotes.textContent = result.notes || "Done.";
    } catch (e) {
      aiNotes.textContent = `AI error: ${msg(e)}`;
    } finally {
      aiBtn.disabled = false;
      scheduleCompile();
      scheduleSave();
    }
  }

  async function streamInto(turns: Turn[]): Promise<{ script: string; notes: string }> {
    const result = await generate(turns, {
      onScript: (partial) => {
        codeEl.value = partial;
      },
    });
    codeEl.value = result.script;
    return result;
  }

  // -- device ---------------------------------------------------------------
  async function sendToDevice(): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    const r = await worker.compile(codeEl.value);
    if (!r.ok) {
      devStatus.textContent = "Fix compile errors before sending.";
      return;
    }
    devStatus.textContent = "Uploading…";
    try {
      await c.submitEffect(effectId, r.bytecode, true);
      if (panel.values().length > 0) await c.setUniforms(panel.values());
      devStatus.textContent = "Sent · effect active.";
    } catch (e) {
      devStatus.textContent = `upload failed: ${msg(e)}`;
    }
  }

  async function hydrateFromDevice(): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    try {
      const r = await c.getEffectUniforms();
      panel.hydrate(r.current.map((x) => ({ slot: x.slot, value: x.value })));
      for (const { slot, value } of r.current) preview?.setUniform(slot, value);
      devStatus.textContent = "Loaded uniforms from device.";
    } catch (e) {
      devStatus.textContent = `load failed: ${msg(e)}`;
    }
  }

  // -- layout ---------------------------------------------------------------
  function fieldset(legend: string, ...children: (Node | string)[]): HTMLElement {
    const wrap = Card();
    const h = document.createElement("div");
    h.className = "fxedit-legend";
    h.textContent = legend;
    wrap.append(h, ...children);
    return wrap;
  }

  const mapRow = document.createElement("label");
  mapRow.className = "fxedit-fieldrow";
  const mapCap = document.createElement("span");
  mapCap.textContent = "Preview map";
  mapRow.append(mapCap, mapPicker);

  const editorWrap = document.createElement("div");
  editorWrap.className = "fxedit-editor";
  editorWrap.append(codeEl, statusEl);

  el.append(
    canvas,
    nameField.el,
    editorWrap,
    fieldset("Preview", mapRow),
    fieldset(
      "AI (bring your own key)",
      aiHint,
      aiAsk,
      buttonRow(aiBtn),
      aiNotes,
    ),
    fieldset("Uniforms", uniformsHost),
    fieldset("Diagnostics", diagsEl),
    fieldset("Device", buttonRow(sendBtn, hydrateBtn), devStatus),
  );

  function buttonRow(...btns: HTMLElement[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "fxedit-btnrow";
    row.append(...btns);
    return row;
  }

  let unsubAppState: (() => void) | null = null;

  async function load(): Promise<void> {
    const rec = await effectStore.get(effectId);
    if (!rec) {
      el.replaceChildren();
      const warn = document.createElement("div");
      warn.className = "screen-sub";
      warn.textContent = "Effect not found.";
      const back = Button({ label: "Back to effects", icon: "back", onClick: () => router.navigate("/effects") });
      el.append(warn, back);
      return;
    }
    nameField.input.value = rec.name;
    codeEl.value = rec.source;

    const defaultMapId = await populateMapPicker();
    mapPicker.value = defaultMapId ?? "__fixture__";
    await selectMap(mapPicker.value);

    refreshAiHint();
    refreshDevice();
    unsubAppState = appState.subscribe(() => refreshDevice());

    codeEl.addEventListener("input", () => {
      scheduleCompile();
      scheduleSave();
    });

    raf = requestAnimationFrame(tick);
    scheduleCompile();
  }

  return {
    el,
    onMount: () => void load(),
    onUnmount: () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (compileTimer !== null) clearTimeout(compileTimer);
      if (saveTimer !== null) clearTimeout(saveTimer);
      // Flush any pending edit so nothing is lost on navigate-away.
      void effectStore.save(effectId, codeEl.value);
      unsubAppState?.();
      preview?.dispose();
      worker.dispose();
      mapView?.stop();
      mapView = null;
    },
  };
}
