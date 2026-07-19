/**
 * Host binding to the effects Sim compiled from firmware/pulse to WASM
 * (//firmware/pulse:pulse_web, served at /pulse/). The workspace drives the
 * EXACT firmware simulation so its preview can never drift from a player.
 *
 * `EffectSimulation` builds a wasm `EffectSim` from a fixture (map + extracted
 * topology) + effect params, then each animation tick `step`s it and `render`s
 * a flat RGB buffer aligned to `map.leds` order (ready for MapView.setLedColors).
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";

export interface EffectParams {
  effect: "pulse" | "flood";
  /** [0,1] */ intensity: number;
  /** meters */ glow: number;
  /** m/s */ speed: number;
  agentCount: number;
  /** meters; ≤0 derives from glow */ lead: number;
  /** [0,1]; <0 uses the default */ split: number;
  /** meters; ≤0 derives from glow */ decay: number;
  /** pulse spawns/sec; ≤0 derives from agentCount */ spawnRate: number;
  /** flood: termini advanced per restart; 0 = frozen */ floodCycle: number;
  /** pulse bloom reach as a multiple of glow; ≤0 = default */ glowReach: number;
  /** pulse comet-trail length, meters; 0 = point source */ trail: number;
  /** 0xRRGGBB palette */ palette: number[];
  seed: number;
}

interface WasmEffectSim {
  step(dtMs: number): void;
  set_config(
    effect: number,
    intensity: number,
    glowM: number,
    speedMs: number,
    agentCount: number,
    leadM: number,
    splitProb: number,
    decayM: number,
    spawnRate: number,
    floodCycle: number,
    glowReach: number,
    trailM: number,
    paletteRgb: Uint32Array,
  ): void;
  render(): Uint8Array;
  active_pulses(): number;
  flood_front_mm(): number;
  free(): void;
}

interface PulseModule {
  default(wasm: string): Promise<unknown>;
  EffectSim: new (
    segA: Int32Array,
    segB: Int32Array,
    segLenMm: Uint32Array,
    ledSeg: Uint32Array,
    ledSMm: Uint32Array,
    ledDperpMm: Uint32Array,
    effect: number,
    intensity: number,
    glowM: number,
    speedMs: number,
    agentCount: number,
    leadM: number,
    splitProb: number,
    decayM: number,
    spawnRate: number,
    floodCycle: number,
    glowReach: number,
    trailM: number,
    paletteRgb: Uint32Array,
    seed: number,
  ) => WasmEffectSim;
}

let modP: Promise<PulseModule> | null = null;

/** Load + init the pulse wasm bundle once (cached). */
export function loadPulseWasm(base = "/pulse"): Promise<PulseModule> {
  if (modP === null) {
    modP = (async () => {
      const mod = (await import(/* @vite-ignore */ `${base}/pulse_wasm_pkg.js`)) as PulseModule;
      await mod.default(`${base}/pulse_wasm_pkg_bg.wasm`);
      return mod;
    })();
  }
  return modP;
}

const mm = (m: number): number => Math.max(0, Math.round(m * 1000));

export class EffectSimulation {
  private readonly sim: WasmEffectSim;

  /** Build a sim from a fixture + params. Throws if the topology has no
   * segments (nothing to animate). */
  constructor(mod: PulseModule, map: OutputMap, topo: Topology, p: EffectParams) {
    if (topo.segments.length === 0) throw new Error("topology has no segments");

    const segA = Int32Array.from(topo.segments, (s) => s.a);
    const segB = Int32Array.from(topo.segments, (s) => s.b);
    const segLen = Uint32Array.from(topo.segments, (s) => mm(s.length));

    // Per-LED association resolved to sim segment INDEX, in map.leds order so
    // render() output lines up 1:1 with the LEDs (and MapView.setLedColors).
    const segIndexById = new Map(topo.segments.map((s, i) => [s.id, i]));
    const assocByLed = new Map(topo.associations.map((a) => [a.ledId, a]));
    const n = map.leds.length;
    const ledSeg = new Uint32Array(n);
    const ledS = new Uint32Array(n);
    const ledD = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const a = assocByLed.get(map.leds[i]!.id);
      const idx = a ? segIndexById.get(a.segmentId) : undefined;
      if (a !== undefined && idx !== undefined) {
        ledSeg[i] = idx;
        ledS[i] = mm(a.footArclength);
        ledD[i] = mm(a.dPerp);
      } else {
        ledSeg[i] = 0;
        ledS[i] = 0;
        ledD[i] = 0x7fffffff; // unassociated → far off any segment → black
      }
    }

    this.sim = new mod.EffectSim(
      segA,
      segB,
      segLen,
      ledSeg,
      ledS,
      ledD,
      p.effect === "flood" ? 1 : 0,
      p.intensity,
      p.glow,
      p.speed,
      Math.max(1, Math.round(p.agentCount)),
      p.lead,
      p.split,
      p.decay,
      p.spawnRate,
      p.floodCycle,
      p.glowReach,
      p.trail,
      Uint32Array.from(p.palette),
      p.seed >>> 0,
    );
  }

  step(dtMs: number): void {
    this.sim.step(Math.max(0, Math.round(dtMs)));
  }

  /** Adopt new effect params on the running sim WITHOUT resetting animation
   * state (smooth live tuning). A change of effect kind re-inits that effect. */
  setConfig(p: EffectParams): void {
    this.sim.set_config(
      p.effect === "flood" ? 1 : 0,
      p.intensity,
      p.glow,
      p.speed,
      Math.max(1, Math.round(p.agentCount)),
      p.lead,
      p.split,
      p.decay,
      p.spawnRate,
      p.floodCycle,
      p.glowReach,
      p.trail,
      Uint32Array.from(p.palette),
    );
  }

  /** Flat RGB, one triple per LED in map.leds order. */
  render(): Uint8Array {
    return this.sim.render();
  }

  stats(): { active: number; floodMm: number } {
    return { active: this.sim.active_pulses(), floodMm: this.sim.flood_front_mm() };
  }

  dispose(): void {
    this.sim.free();
  }
}
