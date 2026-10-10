import type { FxUniform } from "../fx/preview";

/** Values are named so recompiling a shader can safely reorder VM slots. */
export type SceneUniforms = Record<string, number[]>;

export interface EffectScene {
  /** Stable fixture identifier, rather than a browser-local IndexedDB id. */
  mapId: string;
  uniforms: SceneUniforms;
}

export function captureUniforms(
  manifest: FxUniform[],
  values: { slot: number; value: number[] }[],
): SceneUniforms {
  const bySlot = new Map(values.map(value => [value.slot, value.value]));
  return Object.fromEntries(manifest.map(uniform => [
    uniform.name, (bySlot.get(uniform.slot) ?? uniform.default).slice(),
  ]));
}

/** Ignore removed or incompatible uniforms; use the compiler's defaults. */
export function sceneUniformValues(manifest: FxUniform[], saved: SceneUniforms): {
  slot: number; value: number[];
}[] {
  return manifest.map(uniform => {
    const candidate = saved[uniform.name];
    const value = Array.isArray(candidate) && candidate.length === uniform.width &&
      candidate.every(Number.isFinite) ? candidate : uniform.default;
    return { slot: uniform.slot, value: value.slice() };
  });
}
