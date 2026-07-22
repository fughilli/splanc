/**
 * Effects-editor workspace (editor.html): write a GLSL-ish effect, compile it
 * in a background Web Worker (compile-worker.ts) on idle, preview it with the
 * EXACT firmware VM (FxPreview / fx_vm_web) over the current map, and — when a
 * device is connected — upload the compiled .fxb and push slider values live.
 *
 * Structure mirrors effects/main.ts: load a fixture (synthetic or imported
 * .binpb) into a MapView, then drive the preview each rAF tick. The compile →
 * uniform-panel + preview hot-reload path is the whole point (docs/design/
 * effects-compiler.md): preview and device consume the SAME manifest values.
 */

import type { OutputMap } from "@ledmapper/protocol";
import { FxPreview, type FxUniform } from "../../fx/preview";
import { defaultWsUrl, LedMapperClient } from "../../net/client";
import { decodeMappingBundle } from "../../net/proto";
import { MapView } from "../../ui/mapview";
import { FIXTURE_KINDS, generateFixture, type FixtureKind } from "../fixtures";
import {
  askTurn,
  generate,
  getApiKey,
  repairTurn,
  setApiKey,
  type Turn,
} from "../ai/generate";
import { FxCompilerWorker } from "./compiler";
import { UniformPanel } from "./uniform-panel";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
};

const DEFAULT_SCRIPT = `uniform float speed : 0.0 .. 5.0 = 1.0;
uniform float width : 0.02 .. 0.5 = 0.12;
uniform vec3 tint : color = 0.2, 0.6, 1.0;

void update() {}

vec3 shade(Led led) {
  float phase = fract(led.s - time * speed);
  float band = smoothstep(width, 0.0, abs(phase - 0.5));
  return tint * band;
}
`;

const COMPILE_DEBOUNCE_MS = 300;
const REPAIR_ROUNDS = 2;

// -- state ------------------------------------------------------------------
const worker = new FxCompilerWorker();
let currentMap: OutputMap | null = null;
let mapView: MapView | null = null;
let positions: Float32Array | null = null; // flat xyz, 3*N
let preview: FxPreview | null = null;
let lastManifest: FxUniform[] = [];
let lastT = 0;
let frame = 0;
let startT = 0;
let compileTimer: number | null = null;
let compileSeq = 0;
let aiTurns: Turn[] = [];
let device: LedMapperClient | null = null;

const codeEl = $<HTMLTextAreaElement>("code");
const statusEl = $("status");
const diagsEl = $<HTMLUListElement>("diags");

const panel = new UniformPanel($("uniforms"), (slot, value) => {
  preview?.setUniform(slot, value);
  // Live slider drags also flow to the device (identical manifest values).
  if (device?.isConnected) void device.setUniforms([{ slot, value }]).catch(() => undefined);
});

// -- fixture / map ----------------------------------------------------------
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
    mapView = new MapView($<HTMLCanvasElement>("view"), map);
    mapView.setLedColors(new Uint8Array(map.leds.length * 3));
    mapView.start();
  } else {
    mapView.update(map);
    mapView.setTruth(null);
    mapView.setTrajectory(null);
    mapView.setLedColors(new Uint8Array(map.leds.length * 3));
  }
}

function generateMap(): void {
  const kind = $<HTMLSelectElement>("fx-kind").value as FixtureKind;
  loadMap(generateFixture(kind, { count: 160, seed: 3, jitterFrac: 0.06 }));
}

async function importFile(file: File): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const bundle = decodeMappingBundle(bytes);
    if (!bundle.map || bundle.map.leds.length === 0) throw new Error("bundle has no LEDs");
    loadMap(bundle.map);
  } catch (e) {
    setStatus(`import failed: ${msg(e)}`, "err");
  }
}

// -- compile ----------------------------------------------------------------
function scheduleCompile(): void {
  if (compileTimer !== null) clearTimeout(compileTimer);
  compileTimer = window.setTimeout(() => void compileNow(), COMPILE_DEBOUNCE_MS);
}

async function compileNow(): Promise<void> {
  const src = codeEl.value;
  const seq = ++compileSeq;
  const r = await worker.compile(src);
  if (seq !== compileSeq) return; // a newer edit superseded this compile

  renderDiagnostics(r.diagnostics);

  if (!r.ok) {
    const first = r.diagnostics[0];
    setStatus(
      first ? `line ${first.line + 1}: ${first.msg}` : "compile failed",
      "err",
    );
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
  // Push the panel's live values into the fresh VM so preview matches the UI.
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

// -- animation --------------------------------------------------------------
function tick(t: number): void {
  requestAnimationFrame(tick);
  const dt = lastT === 0 ? 16 : Math.min(100, t - lastT);
  lastT = t;
  if (preview === null || mapView === null || currentMap === null || positions === null) return;
  const time = (t - startT) / 1000;
  preview.tick(time, dt / 1000, frame++, currentMap.leds.length);
  mapView.setLedColors(preview.shadeAll(positions));
  $("hud").textContent = `${currentMap.leds.length} LEDs · ${lastManifest.length} uniforms`;
}

// -- AI ---------------------------------------------------------------------
async function runAi(): Promise<void> {
  const key = $<HTMLInputElement>("ai-key").value.trim();
  if (key) setApiKey(key);
  if (!getApiKey()) {
    setAiNotes("Enter an Anthropic API key first.");
    return;
  }
  const ask = $<HTMLTextAreaElement>("ai-ask").value.trim();
  if (!ask) return;
  const btn = $<HTMLButtonElement>("ai-gen");
  btn.disabled = true;
  setAiNotes("Generating…");
  // Follow-ups include the current script so the model refines rather than
  // restarts (multi-turn conversation kept in the workspace).
  const turn = askTurn(ask, aiTurns.length > 0 ? codeEl.value : undefined);

  try {
    let result = await streamInto([...aiTurns, turn]);
    aiTurns = [...aiTurns, turn, { role: "assistant", content: result.script }];

    // Auto-repair loop: on compile errors, feed diagnostics back for N rounds.
    for (let round = 0; round < REPAIR_ROUNDS; round++) {
      const c = await worker.compile(codeEl.value);
      if (c.ok) break;
      setAiNotes(`Repairing (round ${round + 1})…`);
      const rt = repairTurn(codeEl.value, c.diagnostics);
      result = await streamInto([...aiTurns, rt]);
      aiTurns = [...aiTurns, rt, { role: "assistant", content: result.script }];
    }
    setAiNotes(result.notes || "Done.");
  } catch (e) {
    setAiNotes(`AI error: ${msg(e)}`);
  } finally {
    btn.disabled = false;
    scheduleCompile();
  }
}

/**
 * Stream a generation into the editor live, but only trigger a compile once the
 * stream settles (deferred) — DECISION: live feed, defer compilation until the
 * agent finishes so the user doesn't see errors thrashing.
 */
async function streamInto(turns: Turn[]): Promise<{ script: string; notes: string }> {
  const result = await generate(turns, {
    onScript: (partial) => {
      codeEl.value = partial;
    },
  });
  codeEl.value = result.script;
  return result;
}

// -- device -----------------------------------------------------------------
async function connectDevice(url: string): Promise<void> {
  device = new LedMapperClient(url, { clientName: "effects-editor" });
  device.events.onConnected = () => setDevStatus("Connected.");
  device.events.onDisconnected = () => setDevStatus("Disconnected.");
  try {
    await device.connect();
    $<HTMLButtonElement>("dev-send").disabled = false;
    $<HTMLButtonElement>("dev-hydrate").disabled = false;
  } catch (e) {
    setDevStatus(`connect failed: ${msg(e)}`);
  }
}

async function sendToDevice(): Promise<void> {
  if (device === null || !device.isConnected) return;
  const r = await worker.compile(codeEl.value);
  if (!r.ok) {
    setDevStatus("Fix compile errors before sending.");
    return;
  }
  setDevStatus("Uploading…");
  try {
    await device.submitEffect("editor", r.bytecode, true);
    // Push current live uniform values so the device matches the preview.
    if (panel.values().length > 0) await device.setUniforms(panel.values());
    setDevStatus("Sent · effect active.");
  } catch (e) {
    setDevStatus(`upload failed: ${msg(e)}`);
  }
}

async function hydrateFromDevice(): Promise<void> {
  if (device === null || !device.isConnected) return;
  try {
    const r = await device.getEffectUniforms();
    panel.hydrate(r.current.map((c) => ({ slot: c.slot, value: c.value })));
    for (const { slot, value } of r.current) preview?.setUniform(slot, value);
    setDevStatus("Loaded uniforms from device.");
  } catch (e) {
    setDevStatus(`load failed: ${msg(e)}`);
  }
}

// -- small helpers ----------------------------------------------------------
function setStatus(text: string, cls: "ok" | "err"): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}
function setAiNotes(text: string): void {
  $("ai-notes").textContent = text;
}
function setDevStatus(text: string): void {
  $("dev-status").textContent = text;
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function resizeCanvas(): void {
  const c = $<HTMLCanvasElement>("view");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(c.clientWidth * dpr));
  c.height = Math.max(1, Math.round(c.clientHeight * dpr));
}

// -- init -------------------------------------------------------------------
function init(): void {
  const kindSel = $<HTMLSelectElement>("fx-kind");
  for (const k of FIXTURE_KINDS) {
    const o = document.createElement("option");
    o.value = k.value;
    o.textContent = k.label;
    kindSel.appendChild(o);
  }
  kindSel.value = "tree";

  codeEl.value = DEFAULT_SCRIPT;
  const savedKey = getApiKey();
  if (savedKey) $<HTMLInputElement>("ai-key").value = savedKey;

  codeEl.addEventListener("input", scheduleCompile);
  $("gen").addEventListener("click", generateMap);
  kindSel.addEventListener("change", generateMap);
  $("import").addEventListener("click", () => $<HTMLInputElement>("file").click());
  $<HTMLInputElement>("file").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void importFile(f);
  });
  $("ai-gen").addEventListener("click", () => void runAi());
  $("ai-key").addEventListener("change", () =>
    setApiKey($<HTMLInputElement>("ai-key").value.trim()),
  );
  $("dev-send").addEventListener("click", () => void sendToDevice());
  $("dev-hydrate").addEventListener("click", () => void hydrateFromDevice());

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  requestAnimationFrame(tick);

  generateMap();
  scheduleCompile();

  // Only connect to a device when explicitly targeted (?url=wss://player/ws);
  // the editor is fully usable offline otherwise.
  const url = new URLSearchParams(location.search).get("url");
  if (url) void connectDevice(url === "1" ? defaultWsUrl() : url);
}

init();
