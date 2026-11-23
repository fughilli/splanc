/**
 * The app's driver compiler for the Sensors page + kit onboarding: the effect
 * compiler worker (fx_compiler wasm), which also compiles sensor drivers
 * (`export` / `void poll()`). Browser-only (import.meta worker URL), so it is
 * excluded from the CJS unit-test build; tests inject a stub DriverCompile.
 */

import { FxCompilerWorker } from "../../effects/editor/compiler";
import type { DriverCompile } from "../../power/touchDriver";

export function workerDriverCompile(): { compile: DriverCompile; dispose: () => void } {
  const w = new FxCompilerWorker();
  w.warm();
  return {
    compile: async (src) => {
      const r = await w.compile(src);
      const d = r.diagnostics[0];
      return {
        ok: r.ok,
        bytecode: r.bytecode,
        ...(r.ok ? {} : { error: r.compilerUnavailable ?? (d ? `line ${d.line}: ${d.msg}` : "compile failed") }),
      };
    },
    dispose: () => w.dispose(),
  };
}
