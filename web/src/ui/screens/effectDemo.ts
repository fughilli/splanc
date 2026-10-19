/** Website entry: make an editable copy without changing the original scene. */
import { effectStore, isBuiltinEffect } from "../../store/effectStore";
import type { Router, Screen } from "../app/router";
import { EffectEditorScreen } from "./effectEditor";

export function EffectDemoScreen(router: Router, effectId: string): Screen {
  if (!isBuiltinEffect(effectId)) return EffectEditorScreen(router, effectId, { demo: true });
  const el = document.createElement("div");
  el.className = "screen";
  el.textContent = "Opening your effects workspace…";
  let disposed = false;
  return {
    el,
    onMount: () => {
      void effectStore.duplicate(effectId).then(id => {
        if (disposed) return;
        if (!id) throw new Error("Demo effect not found");
        // Replace the immutable entry in history, so refresh keeps this copy.
        history.replaceState(null, "", `#/effects/edit/${encodeURIComponent(id)}?workspace=demo`);
        router.navigate(`/effects/edit/${encodeURIComponent(id)}?workspace=demo`);
      }).catch(() => {
        if (!disposed) el.textContent = "Could not open the demo. Please reload to try again.";
      });
    },
    onUnmount: () => { disposed = true; },
  };
}
