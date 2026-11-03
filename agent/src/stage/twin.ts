/**
 * The stage's live twin: the effect each player is running, on the device's own
 * VM over that player's real map, ticked at a steady rate and streamed to the TV
 * as per-LED colours. It follows deploys, crossfades and uniform changes made
 * through the stage's agent (it does not read frames back from the fixture).
 */

import { coerce, type ManifestUniform, type UniformInput } from "../uniforms";
import { createSim, deriveLedTopology } from "../fxhost";
import type { Hub } from "../hub";
import type { StageBus } from "./bus";

type Sim = Awaited<ReturnType<typeof createSim>>;

interface Live {
  id: string;
  name: string;
  effect: string;
  source: string;
  sim: Sim;
  manifest: ManifestUniform[];
  pos: Float32Array;
  n: number;
  t: number;
  frame: number;
}

/** The two axes with the largest extent, the up axis (+Y) vertical when it is one
 * of them (the same view as fxhost.renderPng), normalised to 0..1 with the aspect
 * kept. Flat [x0, y0, x1, y1, ...], y down. */
export function project(pos: Float32Array): { xy: number[]; aspect: number } {
  const n = pos.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  const ext = [0, 1, 2].map((k) => (n ? max[k]! - min[k]! : 0));
  const order = [0, 1, 2].sort((a, b) => ext[b]! - ext[a]!);
  let [h, v] = [order[0]!, order[1]!];
  if (h === 1) [h, v] = [v, h];
  const span = Math.max(ext[h]!, ext[v]!, 1e-6);
  const w = ext[h]! / span;
  const ht = ext[v]! / span;
  const xy: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (pos[i * 3 + h]! - min[h]!) / span;
    const y = (pos[i * 3 + v]! - min[v]!) / span;
    xy.push(+(w > 0 ? x / w : 0.5).toFixed(4), +(1 - (ht > 0 ? y / ht : 0.5)).toFixed(4));
  }
  return { xy, aspect: ht > 0 ? w / ht : 8 };
}

export class Twin {
  private live = new Map<string, Live>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly bus: StageBus,
    private readonly fps = 20,
  ) {}

  /** Run `source` for every selected player (after a deploy / crossfade). */
  async load(
    sel: string | string[] | undefined,
    effect: string,
    source: string,
    uniforms?: Record<string, UniformInput>,
    refreshMap = false,
  ): Promise<void> {
    const built = await this.hub.each(sel, async (s, p) => {
      const c = await s.compile(source);
      if (!c.ok) throw new Error("does not compile");
      const bundle = await s.mappingBundle(refreshMap);
      const leds = bundle.map?.leds ?? [];
      if (leds.length === 0) throw new Error("no stored map");
      const sim = await createSim(c.fxb, s.toolchain);
      for (const u of c.uniforms) sim.setUniform(u.slot, u.default);
      sim.setTopology(deriveLedTopology(bundle.map, bundle.topology ?? undefined));
      const pos = new Float32Array(leds.length * 3);
      leds.forEach((l, i) => pos.set(l.xyz, i * 3));
      return { id: p.id, name: p.name, sim, manifest: c.uniforms, pos, n: leds.length };
    });
    for (const b of built) {
      if (!b.ok || !b.result) {
        this.bus.emit({ type: "twin_note", player: b.player.name, text: `no live preview: ${b.error ?? "?"}` });
        continue;
      }
      const r = b.result;
      this.live.get(r.id)?.sim.dispose();
      const l: Live = { ...r, effect, source, t: 0, frame: 0 };
      this.live.set(r.id, l);
      if (uniforms) this.applyOne(l, uniforms);
      this.bus.emit({ type: "twin_layout", player: r.id, name: r.name, effect, ...project(r.pos) });
    }
    this.start();
  }

  /**
   * Show every player's stored map, dim, until an effect runs on it; with
   * `refresh`, re-read the maps from the players first (after a mapping pass in
   * the app) and restart the live effects on the new positions.
   */
  async showMaps(refresh: boolean): Promise<void> {
    const r = await this.hub.each("all", async (s, p) => {
      const bundle = await s.mappingBundle(refresh);
      const leds = bundle.map?.leds ?? [];
      const pos = new Float32Array(leds.length * 3);
      leds.forEach((l, i) => pos.set(l.xyz, i * 3));
      return { id: p.id, name: p.name, pos };
    });
    for (const b of r) {
      if (!b.ok || !b.result || b.result.pos.length === 0) continue;
      const { id, name, pos } = b.result;
      const l = this.live.get(id);
      if (l && refresh) await this.load(id, l.effect, l.source);
      else if (!l) this.bus.emit({ type: "twin_layout", player: id, name, effect: null, ...project(pos) });
    }
  }

  /** The effect last loaded for a player (for rollback bookkeeping). */
  current(id: string): { effect: string; source: string } | undefined {
    const l = this.live.get(id);
    return l ? { effect: l.effect, source: l.source } : undefined;
  }

  /** Mirror a set_uniforms / ramp_uniforms target (applied at once). */
  setUniforms(sel: string | string[] | undefined, values: Record<string, UniformInput>): void {
    const names = sel === undefined ? undefined : new Set(Array.isArray(sel) ? sel : [sel]);
    for (const l of this.live.values()) {
      if (names && !names.has(l.name) && !names.has(l.id) && !names.has("all")) continue;
      this.applyOne(l, values);
    }
  }

  private applyOne(l: Live, values: Record<string, UniformInput>): void {
    const byName = new Map(l.manifest.map((u) => [u.name, u]));
    for (const [k, v] of Object.entries(values)) {
      const u = byName.get(k);
      if (!u) continue;
      try {
        l.sim.setUniform(u.slot, coerce(u, v));
      } catch {
        /* out of range: the device refused it too */
      }
    }
  }

  /** The layouts a newly connected screen needs. */
  layouts(): Record<string, unknown>[] {
    return [...this.live.values()].map((l) => ({ type: "twin_layout", player: l.id, name: l.name, effect: l.effect, ...project(l.pos) }));
  }

  private start(): void {
    if (this.timer) return;
    const dt = 1 / this.fps;
    this.timer = setInterval(() => {
      for (const l of this.live.values()) {
        l.t += dt;
        l.sim.tick(l.t, dt, l.frame++, l.n);
        const rgb = l.sim.shadeAll(l.pos);
        this.bus.frame(l.id, Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength).toString("base64"));
      }
    }, 1000 / this.fps);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const l of this.live.values()) l.sim.dispose();
    this.live.clear();
  }
}
