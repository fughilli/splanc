/**
 * Compile an effect source with the real `fx_compile` CLI (native Rust, the same
 * compiler the app uses via WASM) by piping the source on stdin. Exit 0 → the
 * program compiles; non-zero → the diagnostics land on stderr. Build it first
 * with `bazel build //fx_compiler:fx_compile`.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
// tools/model_eval/src → repo root → bazel-bin symlink.
const FX_COMPILE =
  process.env.FX_COMPILE ?? resolve(here, "../../../bazel-bin/fx_compiler/fx_compile");

export interface CompileResult {
  ok: boolean;
  diagnostics: string;
}

export function fxCompileAvailable(): boolean {
  return existsSync(FX_COMPILE);
}

export function compile(source: string): CompileResult {
  const r = spawnSync(FX_COMPILE, [], { input: source, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { ok: false, diagnostics: `fx_compile spawn error: ${r.error.message}` };
  return { ok: r.status === 0, diagnostics: (r.stderr ?? "").trim() };
}
