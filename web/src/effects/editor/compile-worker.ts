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

import type { FxCompiled, FxDiagnostic, FxExport, FxUniform } from "../../fx/preview";

/** A compile request (`src`) or a disassemble request (`fxb`). Discriminated by
 * `kind`; the untagged legacy `{id, src}` shape is treated as a compile. */
export type CompileRequest =
  | { id: number; kind?: "compile"; src: string }
  | { id: number; kind: "disassemble"; fxb: Uint8Array };

export type CompileResponse =
  | { id: number; kind?: "compile"; result: FxCompiled }
  | { id: number; kind: "disassemble"; text: string };

interface CompilerResult {
  readonly ok: boolean;
  readonly bytecode: Uint8Array;
  readonly manifest: string;
  readonly exports: string;
  readonly diagnostics: string;
}
interface CompilerModule {
  default(wasm: string): Promise<unknown>;
  fx_compile(src: string): CompilerResult;
  fx_disassemble(fxb: Uint8Array): string;
}

let modP: Promise<CompilerModule> | null = null;

// This runs in a Web Worker — there is no `document` to resolve against (unlike
// src/assetBase.ts). Vite emits this worker chunk at <deploy-root>/assets/<hash>.js
// (default assetsDir "assets"), so the deploy root — where the fx-compiler
// bundle is staged next to the app — is one level up from the worker's own URL.
// Resolving against self.location makes the compiler load whether the app is at
// an origin root or a subpath (GitHub Pages project site + per-PR previews).
function fxCompilerBase(): string {
  return new URL("../fx-compiler", self.location.href).href.replace(/\/+$/, "");
}

function loadCompiler(base = fxCompilerBase()): Promise<CompilerModule> {
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
    exports: r.ok ? (JSON.parse(r.exports) as FxExport[]) : [],
    diagnostics: JSON.parse(r.diagnostics) as FxDiagnostic[],
  };
}

self.onmessage = (ev: MessageEvent<CompileRequest>): void => {
  const req = ev.data;
  void (async () => {
    if (req.kind === "disassemble") {
      let text: string;
      try {
        const mod = await loadCompiler();
        text = mod.fx_disassemble(req.fxb);
      } catch (e) {
        text = `; disassembly failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      const resp: CompileResponse = { id: req.id, kind: "disassemble", text };
      (self as unknown as Worker).postMessage(resp);
      return;
    }
    let result: FxCompiled;
    try {
      const mod = await loadCompiler();
      result = toCompiled(mod.fx_compile(req.src));
    } catch (e) {
      // A wasm panic or load failure — surface as an error diagnostic rather
      // than throwing, so the editor stays alive.
      result = {
        ok: false,
        bytecode: new Uint8Array(0),
        uniforms: [],
        exports: [],
        diagnostics: [
          { line: 0, col: 0, msg: `compiler error: ${e instanceof Error ? e.message : String(e)}` },
        ] satisfies FxDiagnostic[],
      };
    }
    const resp: CompileResponse = { id: req.id, result };
    (self as unknown as Worker).postMessage(resp);
  })();
};
