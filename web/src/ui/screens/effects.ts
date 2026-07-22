/**
 * Effects preview (design doc §4.4 / §7.4) — the offline effect simulator in
 * the workspace, driven by the MapStore-selected map (not a synthetic fixture).
 * Runs the EXACT firmware Sim (WASM, effects/sim.ts) and renders glowing LEDs
 * via MapView.setLedColors. Controls are data-driven through the uniform seam
 * (effects/uniforms.ts): today's pulse/flood params expressed as a schema, so a
 * future runtime that publishes real schemas needs zero new UI. Links out to
 * /editor.html for the shader editor (owned by another task).
 *
 * Fully offline: no device, no network beyond the /pulse WASM bundle.
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { extractTopology } from "../../topology/extract";
import { EffectSimulation, loadPulseWasm, type EffectParams } from "../../effects/sim";
import {
  defaultValues,
  renderUniformControls,
  type UniformSpec,
  type UniformValues,
} from "../../effects/uniforms";
import { MapView } from "../mapview";
import { Button, Card, EmptyState } from "../kit";
import { mapStore } from "../../store/mapStore";
import { appState } from "../app/state";
import type { Router, Screen } from "../app/router";

type PulseModule = Awaited<ReturnType<typeof loadPulseWasm>>;

const PALETTES: Record<string, number[]> = {
  Rainbow: [0xff0000, 0xff8800, 0xffff00, 0x00ff00, 0x0088ff, 0x8800ff],
  Fire: [0xff2200, 0xff6600, 0xffaa00, 0xffdd44],
  Ice: [0x0044ff, 0x00aaff, 0x66ddff, 0xffffff],
  Cyan: [0x00ffdd],
  White: [0xffffff],
};

// Hard-coded uniform schema for the pulse/flood reference effects (§7.6). When
// the runtime lands, an effect publishes its own schema and this is replaced.
const SCHEMA: UniformSpec[] = [
  { name: "effect", label: "Effect", type: "enum", default: "pulse", options: ["pulse", "flood"] },
  { name: "palette", label: "Palette", type: "enum", default: "Rainbow", options: Object.keys(PALETTES) },
  { name: "speed", label: "Speed (m/s)", type: "float", default: 0.4, min: 0.05, max: 2, step: 0.05 },
  { name: "glow", label: "Glow radius (m)", type: "float", default: 0.08, min: 0.01, max: 0.5, step: 0.01 },
  { name: "intensity", label: "Intensity", type: "float", default: 1, min: 0, max: 1, step: 0.02 },
  { name: "agents", label: "Agents", type: "int", default: 2, min: 1, max: 8 },
  { name: "split", label: "Split prob", type: "float", default: 0.25, min: 0, max: 1, step: 0.05 },
  { name: "decay", label: "Flood decay (m, 0=auto)", type: "float", default: 0, min: 0, max: 2, step: 0.05 },
];

function toEffectParams(v: UniformValues): EffectParams {
  const effect = (v["effect"] as string) === "flood" ? "flood" : "pulse";
  const palette = PALETTES[String(v["palette"] ?? "Rainbow")] ?? [0xffffff];
  return {
    effect,
    intensity: Number(v["intensity"] ?? 1),
    glow: Number(v["glow"] ?? 0.08),
    speed: Number(v["speed"] ?? 0.4),
    agentCount: Number(v["agents"] ?? 2),
    lead: 0,
    split: Number(v["split"] ?? 0.25),
    decay: Number(v["decay"] ?? 0),
    palette,
    seed: 1,
  };
}

export function EffectsScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--effects";

  const canvas = document.createElement("canvas");
  canvas.className = "effects-canvas";
  canvas.width = 640;
  canvas.height = 420;

  const controlsWrap = document.createElement("div");
  controlsWrap.className = "effects-controls";

  el.append(canvas);

  let mod: PulseModule | null = null;
  let map: OutputMap | null = null;
  let topology: Topology | null = null;
  let sim: EffectSimulation | null = null;
  let view: MapView | null = null;
  let playing = true;
  let raf = 0;
  let lastT = 0;
  const values = defaultValues(SCHEMA);

  function rebuildSim(): void {
    sim?.dispose();
    sim = null;
    if (mod === null || map === null || topology === null) return;
    try {
      sim = new EffectSimulation(mod, map, topology, toEffectParams(values));
    } catch {
      view?.setLedColors(null);
    }
  }

  function retune(): void {
    if (sim === null) rebuildSim();
    else sim.setConfig(toEffectParams(values));
  }

  function buildControls(): void {
    controlsWrap.innerHTML = "";
    // Play/pause + scrub-free timeline header (design doc §4.4).
    const bar = document.createElement("div");
    bar.className = "effects-bar";
    const playBtn = Button({
      label: playing ? "Pause" : "Play",
      icon: playing ? "pause" : "play",
      variant: "quiet",
      onClick: () => {
        playing = !playing;
        buildControls();
      },
    });
    const editorLink = Button({
      label: "Shader editor",
      icon: "edit",
      variant: "quiet",
      onClick: () => {
        // Link to /editor.html (owned by another task); carry the map id so it
        // can pick up the same fixture if it supports it.
        const q = appState.selectedMapId ? `?map=${encodeURIComponent(appState.selectedMapId)}` : "";
        window.location.href = `/editor.html${q}`;
      },
    });
    bar.append(playBtn, editorLink);
    controlsWrap.append(bar);

    // Data-driven uniform panel (schema → controls → re-run).
    controlsWrap.append(
      Card(
        renderUniformControls(SCHEMA, values, (name, value) => {
          values[name] = value;
          if (name === "effect") rebuildSim();
          else retune();
          // When a device is connected, the same uniforms could drive live
          // retune via setPlayback (design doc §4.4). Offline preview only here.
        }),
      ),
    );
  }

  async function load(): Promise<void> {
    const id = appState.selectedMapId;
    if (id === null) {
      el.append(
        EmptyState({
          icon: "sparkles",
          title: "Select a map to preview effects",
          action: Button({ label: "Browse maps", icon: "map", onClick: () => router.navigate("/maps") }),
        }),
      );
      return;
    }
    const rec = await mapStore.get(id);
    if (!rec) {
      el.append(EmptyState({ icon: "sparkles", title: "Map not found" }));
      return;
    }
    map = rec.map;
    topology =
      rec.topology && rec.topology.segments.length > 0
        ? rec.topology
        : await extractTopology(rec.map).catch(() => null);

    view = new MapView(canvas, map);
    view.setLedColors(new Uint8Array(map.leds.length * 3));
    view.start();

    el.append(controlsWrap);
    buildControls();

    try {
      mod = await loadPulseWasm();
      rebuildSim();
    } catch {
      const warn = document.createElement("div");
      warn.className = "screen-sub";
      warn.textContent = "Effects engine (WASM) could not load — is /pulse/ served?";
      controlsWrap.prepend(warn);
    }

    lastT = 0;
    const tick = (t: number): void => {
      raf = requestAnimationFrame(tick);
      const dt = lastT === 0 ? 16 : Math.min(100, t - lastT);
      lastT = t;
      if (!playing || sim === null || view === null) return;
      sim.step(dt);
      view.setLedColors(sim.render());
    };
    raf = requestAnimationFrame(tick);
  }

  return {
    el,
    onMount: () => void load(),
    onUnmount: () => {
      if (raf) cancelAnimationFrame(raf);
      sim?.dispose();
      view?.stop();
      view = null;
    },
  };
}
