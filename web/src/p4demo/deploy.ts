/**
 * Deploys the demo's effects to the lamp the same way the app's effect editor does:
 * compile the source in the in-browser wasm compiler (effects/editor/compiler.ts, a
 * Web Worker loading /fx-compiler) and upload the .fxb over the player connection
 * (LedMapperClient.submitEffect, activate = true).
 *
 * Browser-only (the compiler worker is an import.meta URL), so it's kept out of the
 * unit-test compile like the editor itself.
 */

import { FxCompilerWorker } from "../effects/editor/compiler";
import type { LampLink } from "./lamp";
import { EFFECT_IDS, type EffectKey } from "./demo";
import { EFFECT_SOURCES } from "./effects";

let worker: FxCompilerWorker | null = null;
const compiled = new Map<EffectKey, Promise<Uint8Array>>();

/** Compile (once per page) the effect's source to .fxb. Rejects with the compiler's
 * first diagnostic. */
export function compileEffect(key: EffectKey): Promise<Uint8Array> {
  let p = compiled.get(key);
  if (!p) {
    worker ??= new FxCompilerWorker();
    p = worker.compile(EFFECT_SOURCES[key]).then((r) => {
      if (!r.ok) {
        const d = r.diagnostics[0];
        throw new Error(`${key} doesn't compile: ${d ? `${d.line}:${d.col} ${d.msg}` : "unknown error"}`);
      }
      return r.bytecode;
    });
    p.catch(() => compiled.delete(key));
    compiled.set(key, p);
  }
  return p;
}

/** Compile and upload `key` to the lamp as its running effect. */
export async function deployEffect(lamp: LampLink, key: EffectKey): Promise<void> {
  const fxb = await compileEffect(key);
  await lamp.submitEffect(EFFECT_IDS[key], fxb);
}
