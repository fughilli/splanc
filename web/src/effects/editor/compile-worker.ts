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

import type { FxCompiled, FxDiagnostic, FxSymbol, FxUniform } from "../../fx/preview";
import type { WatchInfo } from "../../fx/watch";
import { compilerAssetBase } from "./workerAssets";
import { compilerDownloadMessage, createRetryingLoader, retryUrl, WasmDownloadError, type WasmLoadStatus } from "../../fx/wasmLoad";

/** A compile request (`src`), a disassemble request (`fxb`), or a prefetch of the
 * compiler bundle (`warm`, no reply of its own). Discriminated by `kind`; the
 * untagged legacy `{id, src}` shape is treated as a compile. */
export type CompileRequest =
  | { id: number; kind?: "compile"; src: string }
  // The Watch pane's host build (fx_compile_watch): flat UTF-16 (start, end) pairs.
  | { id: number; kind: "watch"; src: string; ranges: Uint32Array }
  | { id: number; kind: "disassemble"; fxb: Uint8Array }
  | { id: number; kind: "warm" };

/** Replies, plus unsolicited `status` updates on the compiler download (id 0). */
export type CompileResponse =
  | { id: number; kind?: "compile"; result: FxCompiled }
  | { id: number; kind: "watch"; result: FxCompiled; watches: WatchInfo[] }
  | { id: number; kind: "disassemble"; text: string }
  | { id: 0; kind: "status"; status: WasmLoadStatus };

interface CompilerResult {
  readonly ok: boolean;
  readonly bytecode: Uint8Array;
  readonly manifest: string;
  readonly diagnostics: string;
  readonly warnings?: string;
  readonly watches?: string;
}
interface CompilerModule {
  default(wasm: string): Promise<unknown>;
  fx_compile(src: string): CompilerResult;
  /** Absent from compiler bundles that predate the Watch pane. */
  fx_compile_watch?(src: string, ranges: Uint32Array): CompilerResult;
  fx_disassemble(fxb: Uint8Array): string;
}

// This runs in a Web Worker — there is no `document` to resolve against (unlike
// src/assetBase.ts). Vite emits this worker chunk at <deploy-root>/assets/<hash>.js
// (default assetsDir "assets"), so the deploy root — where the fx-compiler
// bundle is staged next to the app — is one level up from the worker's own URL.
// Resolving against self.location makes the compiler load whether the app is at
// an origin root or a subpath (GitHub Pages project site + per-PR previews).
function fxCompilerBase(): string {
  return compilerAssetBase(self.location.href);
}

const post = (resp: CompileResponse): void => (self as unknown as Worker).postMessage(resp);

// Retrying, cache-busting load (src/fx/wasmLoad.ts): one failed download must not
// poison the worker's module map for the rest of the session.
const compiler = createRetryingLoader<CompilerModule>({
  load: async (attempt) => {
    const base = fxCompilerBase();
    const mod = (await import(/* @vite-ignore */ retryUrl(`${base}/fx_compiler_wasm_pkg.js`, attempt))) as CompilerModule;
    await mod.default(retryUrl(`${base}/fx_compiler_wasm_pkg_bg.wasm`, attempt));
    return mod;
  },
  onStatus: (status) => post({ id: 0, kind: "status", status }),
});

const loadCompiler = (): Promise<CompilerModule> => compiler.get();

function toCompiled(r: CompilerResult): FxCompiled {
  // The FX debugger's symbol table (absent from compilers that predate it).
  const syms = r.ok ? (r as { symbols?: unknown }).symbols : undefined;
  return {
    ok: r.ok,
    bytecode: r.bytecode,
    uniforms: r.ok ? (JSON.parse(r.manifest) as FxUniform[]) : [],
    diagnostics: JSON.parse(r.diagnostics) as FxDiagnostic[],
    // (absent in compiler bundles that predate warnings)
    warnings: r.warnings ? (JSON.parse(r.warnings) as FxDiagnostic[]) : [],
    ...(typeof syms === "string" ? { symbols: JSON.parse(syms) as FxSymbol[] } : {}),
  };
}

self.onmessage = (ev: MessageEvent<CompileRequest>): void => {
  const req = ev.data;
  if (req.kind === "warm") {
    compiler.warm();
    return;
  }
  void (async () => {
    if (req.kind === "disassemble") {
      let text: string;
      try {
        const mod = await loadCompiler();
        text = mod.fx_disassemble(req.fxb);
      } catch (e) {
        text = `; disassembly failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      post({ id: req.id, kind: "disassemble", text });
      return;
    }
    if (req.kind === "watch") {
      let result: FxCompiled;
      let watches: WatchInfo[] = [];
      try {
        const mod = await loadCompiler();
        if (!mod.fx_compile_watch) throw new Error("this compiler build has no watch build");
        const r = mod.fx_compile_watch(req.src, req.ranges);
        result = toCompiled(r);
        watches = r.watches ? (JSON.parse(r.watches) as WatchInfo[]) : [];
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        result = { ok: false, bytecode: new Uint8Array(0), uniforms: [], diagnostics: [{ line: 0, col: 0, msg: text }], warnings: [] };
      }
      post({ id: req.id, kind: "watch", result, watches });
      return;
    }
    let result: FxCompiled;
    try {
      const mod = await loadCompiler();
      result = toCompiled(mod.fx_compile(req.src));
    } catch (e) {
      // A wasm panic or load failure — surface as an error diagnostic rather
      // than throwing, so the editor stays alive. A failed DOWNLOAD is flagged
      // (compilerUnavailable) so the screens and the AI tools say it's the
      // network, being retried — not an error in the effect.
      const download = e instanceof WasmDownloadError;
      const text = e instanceof Error ? e.message : String(e);
      result = {
        ok: false,
        bytecode: new Uint8Array(0),
        uniforms: [],
        diagnostics: [
          { line: 0, col: 0, msg: download ? compilerDownloadMessage(text) : `compiler error: ${text}` },
        ] satisfies FxDiagnostic[],
        warnings: [],
        ...(download ? { compilerUnavailable: text } : {}),
      };
    }
    post({ id: req.id, result });
  })();
};
