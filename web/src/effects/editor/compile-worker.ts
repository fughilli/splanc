/**
 * Effects compiler Web Worker (docs/design/effects-compiler.md, DECISION: run
 * the compiler on a background thread). Loads the fx_compiler wasm
 * (//fx_compiler:fx_compiler_web, served at /fx-compiler) OFF the main thread,
 * so a compile can never jank the rAF preview loop even on a slow phone.
 *
 * Protocol: the main thread posts {id, src}; the worker replies
 * {id, result} where result is the flat FxCompiled shape (ok, bytecode,
 * uniforms, diagnostics). Diagnostics carry UTF-16 columns exactly as the wasm
 * binding emits them (the compiler already converts UTF-8 byte cols → UTF-16).
 *
 * The wasm loader mirrors preview.ts / sim.ts: import the bindgen glue, init
 * with the sibling .wasm, cache the module promise.
 */

import type { FxCompiled, FxDiagnostic, FxUniform } from "../../fx/preview";

export interface CompileRequest {
  id: number;
  src: string;
}
export interface CompileResponse {
  id: number;
  result: FxCompiled;
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

let modP: Promise<CompilerModule> | null = null;

function loadCompiler(base = "/fx-compiler"): Promise<CompilerModule> {
  if (modP === null) {
    modP = (async () => {
      const mod = (await import(
        /* @vite-ignore */ `${base}/fx_compiler_wasm_pkg.js`
      )) as CompilerModule;
      await mod.default(`${base}/fx_compiler_wasm_pkg_bg.wasm`);
      return mod;
    })();
  }
  return modP;
}

function toCompiled(r: CompilerResult): FxCompiled {
  return {
    ok: r.ok,
    bytecode: r.bytecode,
    uniforms: r.ok ? (JSON.parse(r.manifest) as FxUniform[]) : [],
    diagnostics: JSON.parse(r.diagnostics) as FxDiagnostic[],
  };
}

self.onmessage = (ev: MessageEvent<CompileRequest>): void => {
  const { id, src } = ev.data;
  void (async () => {
    let result: FxCompiled;
    try {
      const mod = await loadCompiler();
      result = toCompiled(mod.fx_compile(src));
    } catch (e) {
      // A wasm panic or load failure — surface as an error diagnostic rather
      // than throwing, so the editor stays alive.
      result = {
        ok: false,
        bytecode: new Uint8Array(0),
        uniforms: [],
        diagnostics: [
          { line: 0, col: 0, msg: `compiler error: ${e instanceof Error ? e.message : String(e)}` },
        ] satisfies FxDiagnostic[],
      };
    }
    const resp: CompileResponse = { id, result };
    (self as unknown as Worker).postMessage(resp);
  })();
};
