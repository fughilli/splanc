/**
 * Match a sensor driver's exports to an effect's uniforms (FUG-107).
 *
 * A driver's `poll()` writes named `export`s; an effect reads live values from
 * named `uniform`s. To make a sensor drive an effect, the device copies each
 * export into a uniform every poll (client.submitDriver bindings). The mapping
 * is by NAME — an `export float temperature` feeds `uniform float temperature`
 * — which is the convention the AI is told to follow, so a driver and an effect
 * authored independently line up automatically. Pure + UI-independent so it is
 * unit-tested directly.
 */

import type { FxExport, FxUniform } from "../fx/preview";
import type { DriverBindingFlat } from "../net/proto";

export interface BindingResult {
  /** The export→uniform slot bindings to send with submit_driver. */
  bindings: DriverBindingFlat[];
  /** Export names with no compatible uniform (unmatched or width mismatch). */
  unmatched: string[];
}

/**
 * Build the bindings that wire `exports` into `uniforms` by name. An export is
 * bound only when a uniform of the SAME name AND width exists (a scalar export
 * can't drive a vec3 uniform). Unbound exports are returned in `unmatched` so
 * the UI can prompt the user to add or rename a uniform.
 */
export function computeBindings(exports: FxExport[], uniforms: FxUniform[]): BindingResult {
  const byName = new Map(uniforms.map((u) => [u.name, u]));
  const bindings: DriverBindingFlat[] = [];
  const unmatched: string[] = [];
  for (const e of exports) {
    const u = byName.get(e.name);
    if (u !== undefined && u.width === e.width) {
      bindings.push({ exportSlot: e.slot, width: e.width, uniformSlot: u.slot });
    } else {
      unmatched.push(e.name);
    }
  }
  return { bindings, unmatched };
}
