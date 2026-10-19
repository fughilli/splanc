/**
 * Host-side effect tooling: the SAME compiler and VM wasm the web editor uses
 * (//fx_compiler:fx_compiler_web, //firmware/fx_vm:fx_vm_web), loaded from the
 * bundle's compiler/ and simulator/ directories, behind web/src/fx/preview.ts's
 * compileScript / FxPreview / deriveLedTopology (so the bridge's preview is the
 * device VM, bit for bit, like the editor's).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileScript,
  deriveLedTopology,
  FxPreview,
  installFxModules,
  type FxCompiled,
} from "../../web/src/fx/preview";
import { parseFxbTextures, type FxbTexture } from "../../web/src/net/fxbTextures";
import type { MappingBundle } from "../../web/src/net/proto";
import { encodePng } from "./png";
import { coerce, type ManifestUniform, type UniformInput } from "./uniforms";

interface WasmPkg {
  initSync(arg: { module: BufferSource }): unknown;
}

let loaded: Promise<void> | null = null;

/** Load the compiler + VM wasm from `<root>/compiler` and `<root>/simulator`. */
export function loadFxHost(root: string): Promise<void> {
  if (loaded === null) {
    loaded = (async () => {
      const load = async (dir: string, name: string): Promise<WasmPkg> => {
        const url = pathToFileURL(join(root, dir, `${name}.js`)).href;
        const mod = (await import(/* @vite-ignore */ url)) as WasmPkg;
        mod.initSync({ module: readFileSync(join(root, dir, `${name}_bg.wasm`)) });
        return mod;
      };
      const compiler = await load("compiler", "fx_compiler_wasm_pkg");
      const vm = await load("simulator", "fx_vm_wasm_pkg");
      installFxModules({ compiler: compiler as never, vm: vm as never });
    })();
  }
  return loaded;
}

export interface CompileOutcome {
  ok: boolean;
  diagnostics: { line: number; col: number; msg: string }[];
  uniforms: ManifestUniform[];
  bytecodeBytes: number;
  textures: FxbTexture[];
  fxb: Uint8Array;
}

/** Compile effect source with the host compiler matching this bundle's firmware. */
export async function compile(source: string): Promise<CompileOutcome> {
  const r: FxCompiled = await compileScript(source);
  return {
    ok: r.ok,
    diagnostics: r.diagnostics,
    uniforms: r.uniforms as unknown as ManifestUniform[],
    bytecodeBytes: r.bytecode.length,
    textures: r.ok ? parseFxbTextures(r.bytecode) : [],
    fxb: r.bytecode,
  };
}

export interface PreviewFrame {
  time: number;
  /** Per-LED linear RGB, 0..255, LED order (map order). */
  colors: [number, number, number][];
  png: Buffer;
}

/** Run the device VM over a fixture's real map + topology at the given times. */
export async function preview(opts: {
  fxb: Uint8Array;
  manifest: ManifestUniform[];
  bundle: MappingBundle;
  times: number[];
  uniforms?: Record<string, UniformInput>;
  fps?: number;
  imageWidth?: number;
}): Promise<PreviewFrame[]> {
  const { fxb, manifest, bundle } = opts;
  const leds = bundle.map?.leds ?? [];
  const n = leds.length;
  if (n === 0) throw new Error("the fixture map has no LEDs to preview on");
  const fps = opts.fps ?? 30;
  const times = [...opts.times].sort((a, b) => a - b);
  if (times.some((t) => !(t >= 0) || t > 600)) throw new Error("preview times must lie in 0..600 s");

  const sim = await FxPreview.create(fxb);
  try {
    for (const u of manifest) sim.setUniform(u.slot, u.default);
    const byName = new Map(manifest.map((u) => [u.name, u]));
    for (const [name, v] of Object.entries(opts.uniforms ?? {})) {
      const u = byName.get(name);
      if (!u) throw new Error(`unknown uniform "${name}"`);
      sim.setUniform(u.slot, coerce(u, v));
    }
    sim.setTopology(deriveLedTopology(bundle.map, bundle.topology ?? undefined));
    const pos = new Float32Array(n * 3);
    leds.forEach((l, i) => pos.set(l.xyz, i * 3));

    const out: PreviewFrame[] = [];
    const dt = 1 / fps;
    let frame = 0;
    let t = 0;
    let rgb = sim.shadeAll(pos);
    for (const target of times) {
      // Step the VM forward at the frame rate (state integrators see real dt).
      while (t + dt / 2 < target) {
        t += dt;
        sim.tick(t, dt, frame++, n);
      }
      if (frame === 0) sim.tick(target, dt, frame++, n);
      rgb = sim.shadeAll(pos);
      const colors: [number, number, number][] = [];
      for (let i = 0; i < n; i++) colors.push([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!]);
      out.push({ time: target, colors, png: renderPng(pos, colors, opts.imageWidth ?? 480) });
    }
    return out;
  } finally {
    sim.dispose();
  }
}

/**
 * Orthographic view of the LED positions: the two axes with the largest extent,
 * the up axis (+Y in both map frames) vertical when it is one of them. Each LED
 * is a lit disc on a dark background.
 */
export function renderPng(pos: Float32Array, colors: [number, number, number][], width: number): Buffer {
  const n = colors.length;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k]!;
      min[k] = Math.min(min[k]!, v);
      max[k] = Math.max(max[k]!, v);
    }
  }
  const ext = [0, 1, 2].map((k) => max[k]! - min[k]!);
  // Vertical axis: Y (up) unless the fixture is flat in Y, then the widest other.
  const order = [0, 1, 2].sort((a, b) => ext[b]! - ext[a]!);
  let v = 1;
  let h = 0;
  if (ext[1]! < 0.15 * Math.max(...ext)) {
    [h, v] = [order[0]!, order[1]!];
  } else {
    h = ext[0]! >= ext[2]! ? 0 : 2;
  }
  const pad = 12;
  const span = Math.max(ext[h]!, ext[v]!, 1e-3);
  const scale = (width - 2 * pad) / span;
  const height = Math.max(32, Math.round(ext[v]! * scale + 2 * pad));
  const img = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) img.set([16, 16, 20, 255], i * 4);
  const r = Math.max(2, Math.min(8, Math.round((width / Math.sqrt(Math.max(n, 1))) * 0.25)));
  for (let i = 0; i < n; i++) {
    const cx = pad + (pos[i * 3 + h]! - min[h]!) * scale;
    const cy = height - pad - (pos[i * 3 + v]! - min[v]!) * scale;
    const [cr, cg, cb] = colors[i]!;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        img.set([cr, cg, cb, 255], (y * width + x) * 4);
      }
    }
  }
  return encodePng(width, height, img);
}
