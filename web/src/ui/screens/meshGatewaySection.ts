/**
 * Device settings: the "Mesh" section (docs/design/mesh.md §9.1, mesh M5). Shown when the
 * connected fixture reports it is meshed with others: how many, whether their clocks are
 * synced, and one switch, "Control the whole mesh", that sends effect, slider, brightness
 * and crossfade changes through this fixture to every fixture in its mesh (they change on
 * the same frame). The member list and per-fixture targets are M8's.
 */

import { Switch } from "../kit";
import { meshPeers, meshSummary, type MeshStateInfo } from "../../net/mesh";

export interface MeshSectionClient {
  getMesh(): Promise<MeshStateInfo>;
  readonly meshAll: boolean;
  setMeshAll(on: boolean): void;
}

let stylesInstalled = false;
function installStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const st = document.createElement("style");
  st.textContent = `
.mesh-section { display: flex; flex-direction: column; gap: 12px; }
.mesh-status-line { font-size: 0.875rem; color: var(--text-dim); }
.mesh-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mesh-row-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.mesh-row-title { font-size: 0.9375rem; }
.mesh-row-hint { font-size: 0.8125rem; color: var(--text-dim); }
`;
  document.head.append(st);
}

/** The section, or null-content (empty, hidden) until the fixture says it is meshed.
 * `onChange` sees the switch (the card's connected line follows it). */
export function MeshGatewaySection(
  client: MeshSectionClient,
  opts: { onChange?: (on: boolean) => void; onShown?: (shown: boolean) => void } = {},
): HTMLElement {
  installStyles();
  const el = document.createElement("div");
  el.className = "mesh-section";
  el.hidden = true;

  const render = (s: MeshStateInfo): void => {
    const summary = meshSummary(s);
    el.replaceChildren();
    if (summary === null) {
      el.hidden = true;
      opts.onShown?.(false);
      return;
    }
    el.hidden = false;
    opts.onShown?.(true);
    const n = meshPeers(s).length;
    const h = document.createElement("div");
    h.className = "device-detail-cap";
    h.textContent = "Mesh";
    const line = document.createElement("div");
    line.className = "mesh-status-line";
    line.textContent = summary;

    const row = document.createElement("div");
    row.className = "mesh-row";
    const text = document.createElement("div");
    text.className = "mesh-row-text";
    const title = document.createElement("span");
    title.className = "mesh-row-title";
    title.id = "mesh-all-title";
    title.textContent = "Control the whole mesh";
    const hint = document.createElement("span");
    hint.className = "mesh-row-hint";
    hint.textContent =
      `Effect, slider, brightness and crossfade changes also go to the ${n} other fixture${n === 1 ? "" : "s"}, ` +
      "on the same frame. New effects reach only this fixture for now, unless they are very small.";
    text.append(title, hint);
    const sw = Switch({
      on: client.meshAll,
      label: "Control the whole mesh",
      onChange: (v) => {
        client.setMeshAll(v);
        opts.onChange?.(v);
      },
    });
    sw.el.setAttribute("aria-labelledby", title.id);
    row.append(text, sw.el);
    el.append(h, line, row);
  };

  // No mesh on this player (error "unsupported"), or no answer: nothing to show.
  const hide = (): void => {
    el.hidden = true;
    opts.onShown?.(false);
  };
  try {
    void client.getMesh().then(render).catch(hide);
  } catch {
    hide();
  }
  return el;
}
