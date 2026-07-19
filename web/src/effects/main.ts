/**
 * Effects-simulator workspace (effects.html): experiment with pulse/flood
 * effects on synthetic or real (imported .binpb) fixtures. It runs the EXACT
 * firmware Sim (compiled to WASM), skeletonizes fixtures with the REAL topology
 * extractor, and previews the animation as glowing LEDs in the 3D MapView.
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { decodeMappingBundle } from "../net/proto";
import { edgeKey, extractTopology, type ExtractOptions } from "../topology/extract";
import { MapView } from "../ui/mapview";
import {
  FIXTURE_KINDS,
  generateFixture,
  type FixtureKind,
} from "./fixtures";
import { PALETTES } from "./palettes";
import { EffectSimulation, loadPulseWasm, type EffectParams } from "./sim";

type PulseModule = Awaited<ReturnType<typeof loadPulseWasm>>;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
};


// -- state ------------------------------------------------------------------
let mod: PulseModule | null = null;
let currentMap: OutputMap | null = null;
let currentTopology: Topology | null = null;
let sim: EffectSimulation | null = null;
let mapView: MapView | null = null;
let playing = true;
let effect: "pulse" | "flood" = "pulse";
let lastT = 0;

const err = $("err");
const setErr = (m: string): void => {
  err.textContent = m;
};

// -- control readers --------------------------------------------------------
function num(id: string): number {
  return parseFloat($<HTMLInputElement>(id).value);
}
function setV(id: string, text: string): void {
  const el = document.getElementById(`${id}-v`);
  if (el) el.textContent = text;
}

function extractOptions(): ExtractOptions {
  const radius = num("radius");
  const prune = num("prune");
  const loop = num("loop");
  const simplify = num("simplify");
  setV("radius", radius.toFixed(1));
  setV("prune", prune.toFixed(1));
  setV("loop", loop.toFixed(1));
  setV("simplify", simplify.toFixed(1));
  return {
    radiusFactor: radius,
    pruneFactor: prune,
    loopFactor: loop,
    simplifyFrac: simplify,
    forceEdges: [...forceEdges],
    cutEdges: [...cutEdges],
  };
}

// Manual topology edits (survive re-extraction; see topology/extract.ts).
const forceEdges = new Set<string>();
const cutEdges = new Set<string>();
let editSel: number[] = [];

function effectParams(): EffectParams {
  const intensity = num("intensity");
  const speed = num("speed");
  const glow = num("glow");
  const agents = num("agents");
  const lead = num("lead");
  const split = num("split");
  const decay = num("decay");
  const spawnRate = num("spawn");
  const floodCycle = num("cycle");
  const glowReach = num("reach");
  const trail = num("trail");
  const seed = num("seed");
  setV("intensity", intensity.toFixed(2));
  setV("speed", speed.toFixed(2));
  setV("glow", glow.toFixed(2));
  setV("agents", String(agents));
  setV("lead", lead > 0 ? lead.toFixed(2) : "auto");
  setV("split", split.toFixed(2));
  setV("decay", decay > 0 ? decay.toFixed(2) : "auto");
  setV("spawn", spawnRate > 0 ? `${spawnRate.toFixed(1)}/s` : "auto");
  setV("cycle", floodCycle === 0 ? "frozen" : String(floodCycle));
  setV("reach", `${glowReach.toFixed(1)}×`);
  setV("trail", trail > 0 ? trail.toFixed(2) : "off");
  setV("seed", String(seed));
  return {
    effect,
    intensity,
    glow,
    speed,
    agentCount: agents,
    lead,
    split,
    decay,
    spawnRate,
    floodCycle,
    glowReach,
    trail,
    palette: PALETTES[$<HTMLSelectElement>("palette").selectedIndex]?.rgb ?? [0xffffff],
    seed,
  };
}

// -- pipeline ---------------------------------------------------------------
function rebuildSim(): void {
  sim?.dispose();
  sim = null;
  if (mod === null || currentMap === null || currentTopology === null) return;
  try {
    sim = new EffectSimulation(mod, currentMap, currentTopology, effectParams());
    setErr("");
  } catch (e) {
    setErr(`no effect: ${e instanceof Error ? e.message : e}`);
    mapView?.setLedColors(null);
  }
}

// A config-only change (a live slider / palette / effect toggle): adopt it on
// the running sim so the animation isn't reset. Falls back to a build when
// there's no sim yet.
function retuneSim(): void {
  if (sim === null) {
    rebuildSim();
    return;
  }
  sim.setConfig(effectParams());
}

async function reextract(): Promise<void> {
  if (currentMap === null) return;
  currentTopology = await extractTopology(currentMap, extractOptions());
  mapView?.setTopology($<HTMLInputElement>("show-topo").checked ? currentTopology : null);
  rebuildSim();
}

function loadFixture(map: OutputMap): void {
  currentMap = map;
  if (mapView === null) {
    mapView = new MapView($<HTMLCanvasElement>("view"), map);
    mapView.setLedColors(new Uint8Array(map.leds.length * 3));
    mapView.start();
  } else {
    mapView.update(map);
    mapView.setTruth(null);
    mapView.setTrajectory(null);
  }
  void reextract();
}

// -- animation --------------------------------------------------------------
function tick(t: number): void {
  requestAnimationFrame(tick);
  const dt = lastT === 0 ? 16 : Math.min(100, t - lastT);
  lastT = t;
  if (!playing || sim === null || mapView === null || currentMap === null) return;
  sim.step(dt * num("tscale"));
  mapView.setLedColors(sim.render());
  const s = sim.stats();
  const hud =
    `${currentMap.leds.length} LEDs · ${currentTopology?.segments.length ?? 0} seg · ` +
    `${currentTopology?.branchPoints.length ?? 0} junc\n` +
    (effect === "pulse" ? `pulses: ${s.active}` : `flood front: ${(s.floodMm / 1000).toFixed(2)} m`);
  $("hud").textContent = hud;
}

// -- import -----------------------------------------------------------------
async function importFile(file: File): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const bundle = decodeMappingBundle(bytes);
    if (!bundle.map || bundle.map.leds.length === 0) throw new Error("bundle has no LEDs");
    loadFixture(bundle.map);
    // If the bundle carried a topology, prefer it over re-extraction so the
    // preview matches what the phone/player stored.
    if (bundle.topology && bundle.topology.segments.length > 0) {
      currentTopology = bundle.topology;
      mapView?.setTopology($<HTMLInputElement>("show-topo").checked ? currentTopology : null);
      rebuildSim();
    }
    setErr(`imported ${bundle.map.leds.length} LEDs`);
  } catch (e) {
    setErr(`import failed: ${e instanceof Error ? e.message : e}`);
  }
}

// -- wiring -----------------------------------------------------------------
function resizeCanvas(): void {
  const c = $<HTMLCanvasElement>("view");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(c.clientWidth * dpr));
  c.height = Math.max(1, Math.round(c.clientHeight * dpr));
}

function selectEffect(next: "pulse" | "flood"): void {
  effect = next;
  $("fx-pulse").classList.toggle("on", next === "pulse");
  $("fx-flood").classList.toggle("on", next === "flood");
  retuneSim(); // set_config re-inits the effect kind in place
}

function init(): void {
  // Populate fixture + palette selects.
  const kindSel = $<HTMLSelectElement>("fx-kind");
  for (const k of FIXTURE_KINDS) {
    const o = document.createElement("option");
    o.value = k.value;
    o.textContent = k.label;
    kindSel.appendChild(o);
  }
  const palSel = $<HTMLSelectElement>("palette");
  for (const p of PALETTES) {
    const o = document.createElement("option");
    o.textContent = p.name;
    palSel.appendChild(o);
  }

  const generate = (): void => {
    setV("count", String(Math.round(num("count"))));
    setV("fxseed", String(Math.round(num("fxseed"))));
    loadFixture(
      generateFixture(kindSel.value as FixtureKind, {
        count: num("count"),
        seed: num("fxseed"),
        jitterFrac: 0.06,
      }),
    );
  };

  $("gen").addEventListener("click", generate);
  kindSel.addEventListener("change", generate);
  $("import").addEventListener("click", () => $<HTMLInputElement>("file").click());
  $<HTMLInputElement>("file").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void importFile(f);
  });

  for (const id of ["radius", "prune", "loop", "simplify"]) {
    $(id).addEventListener("input", () => void reextract());
  }
  $("show-topo").addEventListener("change", () =>
    mapView?.setTopology($<HTMLInputElement>("show-topo").checked ? currentTopology : null),
  );

  // -- manual topology editing: tap two LEDs, then Connect / Cut ------------
  const editStatus = (): void => {
    const n = forceEdges.size + cutEdges.size;
    $("edit-status").textContent =
      editSel.length === 0
        ? `tap two LEDs · ${n} edit${n === 1 ? "" : "s"}`
        : editSel.length === 1
          ? `LED ${editSel[0]} → tap another · ${n} edit${n === 1 ? "" : "s"}`
          : `LED ${editSel[0]} ↔ ${editSel[1]} · Connect or Cut`;
    const two = editSel.length === 2;
    $<HTMLButtonElement>("edit-connect").disabled = !two;
    $<HTMLButtonElement>("edit-cut").disabled = !two;
  };
  const editMode = (): boolean => $<HTMLInputElement>("edit-mode").checked;
  $("edit-mode").addEventListener("change", () => {
    $("edit-panel").style.display = editMode() ? "block" : "none";
    editSel = [];
    mapView?.setEditSelection([]);
    editStatus();
  });
  $<HTMLCanvasElement>("view").addEventListener("click", (e) => {
    if (!editMode() || mapView === null) return;
    const c = $<HTMLCanvasElement>("view");
    const rect = c.getBoundingClientRect();
    const scale = c.width / Math.max(1, rect.width);
    const id = mapView.pickLedId((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale, 22 * scale);
    if (id === null) return;
    editSel = editSel.length >= 2 ? [id] : [...editSel, id];
    mapView.setEditSelection(editSel);
    editStatus();
  });
  const applyEdit = (connect: boolean): void => {
    if (editSel.length !== 2) return;
    const key = edgeKey(editSel[0]!, editSel[1]!);
    forceEdges.delete(key);
    cutEdges.delete(key);
    (connect ? forceEdges : cutEdges).add(key);
    editSel = [];
    mapView?.setEditSelection([]);
    editStatus();
    void reextract();
  };
  $("edit-connect").addEventListener("click", () => applyEdit(true));
  $("edit-cut").addEventListener("click", () => applyEdit(false));
  $("edit-clear").addEventListener("click", () => {
    forceEdges.clear();
    cutEdges.clear();
    editSel = [];
    mapView?.setEditSelection([]);
    editStatus();
    void reextract();
  });
  editStatus();
  // Live config: adopted smoothly on the running sim (no restart).
  const liveIds = ["intensity", "speed", "glow", "agents", "lead", "split", "decay", "spawn", "cycle", "reach", "trail"];
  for (const id of liveIds) {
    $(id).addEventListener("input", retuneSim);
  }
  $<HTMLSelectElement>("palette").addEventListener("change", retuneSim);
  // Seed feeds the PRNG at construction only, so it needs a fresh sim.
  $("seed").addEventListener("input", rebuildSim);
  $("tscale").addEventListener("input", () => setV("tscale", `${num("tscale").toFixed(1)}×`));

  $("fx-pulse").addEventListener("click", () => selectEffect("pulse"));
  $("fx-flood").addEventListener("click", () => selectEffect("flood"));
  $("playpause").addEventListener("click", () => {
    playing = !playing;
    $("playpause").textContent = playing ? "Pause" : "Play";
  });
  $("restart").addEventListener("click", rebuildSim);

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  requestAnimationFrame(tick);

  // Load the wasm, then seed with a default fixture.
  loadPulseWasm()
    .then((m) => {
      mod = m;
      generate();
    })
    .catch((e) => setErr(`failed to load effects wasm (is the server serving /pulse/?): ${e}`));
}

init();
