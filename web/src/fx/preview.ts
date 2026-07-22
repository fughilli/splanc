/**
 * Effects runtime — browser seam (docs/design/effects-runtime.md,
 * effects-compiler.md). Loads the compiler wasm (//fx_compiler:fx_compiler_web,
 * served at /fx-compiler) and the VM wasm (//firmware/fx_vm:fx_vm_web, at
 * /fx-vm), and wraps them:
 *   - compileScript(src) → { ok, bytecode, uniforms, diagnostics }
 *   - FxPreview: runs the EXACT firmware VM over a map's LED positions each
 *     tick → flat RGB, fed to MapView.setLedColors() for an offline preview.
 * Running the same VM as the device means the preview can't drift. Mirrors the
 * pulse-wasm loading pattern in effects/sim.ts.
 */

export type FxUiKind =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "color" }
  | { kind: "toggle" }
  | { kind: "dropdown"; options: string[] };

export interface FxUniform {
  name: string;
  slot: number;
  width: number;
  ui: FxUiKind;
  default: number[];
}

export interface FxDiagnostic {
  line: number;
  col: number;
  msg: string;
}

export interface FxCompiled {
  ok: boolean;
  bytecode: Uint8Array;
  uniforms: FxUniform[];
  diagnostics: FxDiagnostic[];
}

interface CompilerResult {
  readonly ok: boolean;
  readonly bytecode: Uint8Array;
  readonly manifest: string;
  readonly diagnostics: string;
}
interface CompilerModule {
  default(wasm: string): Promise<unknown>;
  fx_compile(src: string): CompilerResult;
}
interface FxPreviewWasm {
  set_uniform(slot: number, vals: Float32Array): void;
  update(time: number, dt: number, frame: number, ledCount: number): void;
  shade_all(positions: Float32Array): Uint8Array;
  free(): void;
}
interface VmModule {
  default(wasm: string): Promise<unknown>;
  FxPreview: new (fxb: Uint8Array) => FxPreviewWasm;
}

let compilerMod: Promise<CompilerModule> | null = null;
let vmMod: Promise<VmModule> | null = null;

function loadCompiler(base = "/fx-compiler"): Promise<CompilerModule> {
  if (compilerMod === null) {
    compilerMod = (async () => {
      const mod = (await import(/* @vite-ignore */ `${base}/fx_compiler_wasm_pkg.js`)) as CompilerModule;
      await mod.default(`${base}/fx_compiler_wasm_pkg_bg.wasm`);
      return mod;
    })();
  }
  return compilerMod;
}

function loadVm(base = "/fx-vm"): Promise<VmModule> {
  if (vmMod === null) {
    vmMod = (async () => {
      const mod = (await import(/* @vite-ignore */ `${base}/fx_vm_wasm_pkg.js`)) as VmModule;
      await mod.default(`${base}/fx_vm_wasm_pkg_bg.wasm`);
      return mod;
    })();
  }
  return vmMod;
}

/** Compile GLSL-ish effect source to `.fxb` bytecode + a uniform manifest. */
export async function compileScript(src: string): Promise<FxCompiled> {
  const mod = await loadCompiler();
  const r = mod.fx_compile(src);
  return {
    ok: r.ok,
    bytecode: r.bytecode,
    uniforms: r.ok ? (JSON.parse(r.manifest) as FxUniform[]) : [],
    diagnostics: JSON.parse(r.diagnostics) as FxDiagnostic[],
  };
}

/** Offline preview: the exact device VM run over a map in the browser. */
export class FxPreview {
  private constructor(private readonly inner: FxPreviewWasm) {}

  static async create(bytecode: Uint8Array): Promise<FxPreview> {
    const mod = await loadVm();
    return new FxPreview(new mod.FxPreview(bytecode));
  }

  setUniform(slot: number, vals: number[]): void {
    this.inner.set_uniform(slot, new Float32Array(vals));
  }

  /** Advance one frame (runs update()). */
  tick(time: number, dt: number, frame: number, ledCount: number): void {
    this.inner.update(time, dt, frame, ledCount);
  }

  /** Shade every LED. `positions` is flat xyz (3*N); returns flat RGB (3*N). */
  shadeAll(positions: Float32Array): Uint8Array {
    return this.inner.shade_all(positions);
  }

  dispose(): void {
    this.inner.free();
  }
}
