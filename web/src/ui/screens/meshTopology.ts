/**
 * The mesh map (#/mesh/topology, reached from the device sheet's Mesh section): the
 * fixtures of the connected fixture's mesh in 3D at their room positions (from room
 * localization), the radio links between them coloured by signal or by hops, and each
 * fixture's health (time sync, frame rate, last error). Tap a fixture, on the map or in the
 * list under it, for its details. Fixtures without a room pose are placed from their links
 * (force-directed) and drawn hollow.
 *
 * It re-reads `get_mesh{topology}` every few seconds while open. Older firmware reports no
 * topology: its fixtures are still listed and placed from the gateway's signal.
 */

import { appState } from "../app/state";
import type { Router, Screen } from "../app/router";
import { Button, EmptyState, Sheet, icon } from "../kit";
import { MeshTopoView, type LinkColouring } from "../meshTopoView";
import { deviceStore } from "../../store/deviceStore";
import { meshStore } from "../../store/meshStore";
import type { MeshStateInfo } from "../../net/mesh";
import { installMeshStyles } from "./meshUi.css";
import { nodeLabel } from "./meshModel";
import {
  HOP_COLORS,
  SIGNAL_COLORS,
  SIGNAL_TEXT,
  hopText,
  meshTopoModel,
  nodeDetails,
  type TopoModel,
  type TopoNode,
} from "./meshTopoModel";

/** What the screen reads (the connected LedMapperClient; the demo's fake). */
export interface MeshTopologyClient {
  getMeshTopology(timeoutMs?: number): Promise<MeshStateInfo>;
}

const POLL_MS = 3000;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function MeshTopologyScreen(router: Router, client: MeshTopologyClient | null = appState.client): Screen {
  installMeshStyles();
  installTopoStyles();
  const el = h("div", "screen screen--meshtopo");
  const wrap = h("div", "mtopo");
  el.append(wrap);

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let model: TopoModel | null = null;
  let colouring: LinkColouring = "signal";
  let selected: number | null = null;
  let sheet: { close: () => void; node: number } | null = null;
  let names = new Map<number, string>();
  const selfName = (): string => {
    const id = deviceStore.activeId();
    return (id && deviceStore.get(id)?.label) || "This fixture";
  };
  const nameOf = (node: number): string => model?.nodes.find((n) => n.node === node)?.name ?? names.get(node) ?? nodeLabel(node);

  const view = new MeshTopoView((node) => {
    if (node !== null) openNode(node);
    else select(null);
  });

  // -- static parts -----------------------------------------------------------------
  const status = h("p", "mtopo-status", "Reading the mesh…");
  status.setAttribute("aria-live", "polite");
  const note = h("p", "mtopo-note");
  note.hidden = true;
  const card = h("div", "mtopo-card");
  card.append(view.canvas);
  const hint = h("p", "mtopo-hint", "Drag to turn the map, pinch or scroll to zoom, tap a fixture for its details.");

  const seg = h("div", "mtopo-seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Colour the links by");
  seg.dataset["layoutJoined"] = "";
  const segBtns: HTMLButtonElement[] = [];
  for (const [k, label] of [
    ["signal", "Signal"],
    ["hops", "Hops"],
  ] as [LinkColouring, string][]) {
    const b = h("button", "", label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset["colouring"] = k;
    b.addEventListener("click", () => {
      colouring = k;
      view.setColouring(k);
      syncSeg();
      renderLegend();
    });
    segBtns.push(b);
    seg.append(b);
  }
  const syncSeg = (): void => {
    for (const b of segBtns) {
      const on = b.dataset["colouring"] === colouring;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  syncSeg();
  const segRow = h("div", "mtopo-controls");
  segRow.append(h("span", "mtopo-controls-label", "Colour links by"), seg);
  const legend = h("ul", "mtopo-legend");
  const listTitle = h("h2", "mesh-sub", "Fixtures");
  const list = h("ul", "mesh-members mtopo-list");

  const renderLegend = (): void => {
    legend.replaceChildren();
    const item = (color: string, text: string, kind: "line" | "dot" | "ring" | "square" = "line"): void => {
      const li = h("li", "");
      const sw = h("span", `mtopo-swatch mtopo-swatch--${kind}`);
      sw.style.setProperty("--sw", color);
      li.append(sw, h("span", "", text));
      legend.append(li);
    };
    if (colouring === "signal") {
      item(SIGNAL_COLORS.strong, `${SIGNAL_TEXT.strong} (−60 dBm or better)`);
      item(SIGNAL_COLORS.fair, `${SIGNAL_TEXT.fair} (−60 to −75 dBm)`);
      item(SIGNAL_COLORS.weak, `${SIGNAL_TEXT.weak} (below −75 dBm)`);
    } else {
      item(HOP_COLORS[1]!, "1 hop from this phone's fixture");
      item(HOP_COLORS[2]!, "2 hops");
      item(HOP_COLORS[3]!, "3 or more hops");
    }
    item("#2fb36d", "Fixture healthy", "dot");
    item("#e0a100", "Not synced, quiet or not rendering", "dot");
    item("#2fb36d", "Hollow: no room position (placed from its links)", "ring");
    if (model?.bridges) item("#2fb36d", "Square: a Splanc bridge (no lights)", "square");
  };
  renderLegend();

  const select = (node: number | null): void => {
    selected = node;
    view.select(node);
    for (const b of list.querySelectorAll<HTMLButtonElement>("button[data-node]")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset["node"]) === node));
    }
  };

  const openNode = (node: number): void => {
    const n = model?.nodes.find((x) => x.node === node);
    if (!n || !model) return;
    select(node);
    sheet?.close();
    const sh = Sheet(n.self ? `${n.name} (this one)` : n.name, {
      onClose: () => {
        if (sheet?.node === node) sheet = null;
        if (selected === node) select(null);
      },
    });
    sheet = { close: sh.close, node };
    const body = h("div", "mesh-sheet mtopo-sheet");
    body.dataset["node"] = String(node);
    for (const [k, v] of nodeDetails(n, model, nameOf)) {
      const r = h("div", "mesh-kv");
      r.append(h("span", "", k), h("span", "", v));
      body.append(r);
    }
    sh.body.append(body);
  };

  const memberRow = (n: TopoNode): HTMLLIElement => {
    const li = h("li", "");
    const b = h("button", "mesh-member mtopo-member");
    b.type = "button";
    b.dataset["node"] = String(n.node);
    b.setAttribute("aria-pressed", String(n.node === selected));
    const bridge = n.kind === "bridge";
    const dot = h("span", `mesh-member-dot mtopo-dot mtopo-dot--${n.health}${bridge ? " mtopo-dot--bridge" : n.placed === "layout" ? " mtopo-dot--hollow" : ""}`);
    const text = h("span", "mesh-row-text");
    const where = bridge
      ? "no lights"
      : n.pose === "set"
        ? n.room
          ? `in ${n.room}`
          : "placed in the room"
        : n.noTopology
          ? "no map data (older firmware)"
          : "no room position";
    text.append(
      h("span", "mesh-member-name", n.self ? `${n.name} (this one)` : n.name),
      h("span", "mesh-member-detail", `${n.healthText} · ${hopText(n.hops)} · ${where}`),
    );
    const chev = h("span", "mesh-member-chev");
    chev.append(icon("chevron"));
    b.append(dot, text, chev);
    b.addEventListener("click", () => openNode(n.node));
    li.append(b);
    return li;
  };

  const showEmpty = (title: string, lead: string): void => {
    wrap.replaceChildren(
      EmptyState({ icon: "graph", title }),
      h("p", "mtopo-status", lead),
      (() => {
        const a = h("div", "mesh-actions");
        a.append(Button({ label: "Back", variant: "primary", onClick: () => router.back() }));
        return a;
      })(),
    );
  };

  let mounted = false;
  const render = (s: MeshStateInfo): void => {
    if (disposed) return;
    if (!s.on || !s.member) {
      mounted = false;
      showEmpty("This fixture is not in a mesh", "Create a mesh or add this fixture to one from its Mesh section, then come back to see the map.");
      return;
    }
    const hadBridges = model?.bridges ?? 0;
    model = meshTopoModel(s, (n) => names.get(n), selfName());
    if (!mounted) {
      mounted = true;
      wrap.replaceChildren(status, note, card, hint, segRow, legend, listTitle, list);
    }
    if (model.bridges !== hadBridges) renderLegend();
    const fixtures = model.nodes.filter((x) => x.kind === "fixture");
    const n = fixtures.length;
    const posed = fixtures.filter((x) => x.placed === "room").length;
    const b = model.bridges;
    listTitle.textContent = b ? (b === 1 ? "Fixtures and the bridge" : "Fixtures and bridges") : "Fixtures";
    hint.textContent = `Drag to turn the map, pinch or scroll to zoom, tap a fixture${b ? (b === 1 ? " or the bridge" : " or a bridge") : ""} for its details.`;
    status.textContent =
      `${n} fixture${n === 1 ? "" : "s"}${b ? (b === 1 ? " and the bridge" : ` and ${b} bridges`) : ""} · ` +
      `${model.links.length} radio link${model.links.length === 1 ? "" : "s"} · ` +
      (posed === n ? "all placed in the room" : posed === 0 ? "none placed in the room yet" : `${posed} of ${n} placed in the room`);
    const notes: string[] = [];
    if (model.noTopology > 0) {
      notes.push(
        `${model.noTopology === 1 ? "One fixture runs" : `${model.noTopology} fixtures run`} older firmware that sends no map data: ` +
          "it is placed from the signal this phone's fixture hears. Update its firmware for its links and room position.",
      );
    }
    if (posed < n && model.noTopology < n - posed && fixtures.some((x) => x.placed === "layout" && !x.noTopology)) {
      notes.push("Hollow fixtures have no room position yet: localize the room (Maps → Localize room…) to place them.");
    }
    note.textContent = notes.join(" ");
    note.hidden = notes.length === 0;
    view.update(model);
    list.replaceChildren(...model.nodes.map(memberRow));
    if (selected !== null && !model.nodes.some((x) => x.node === selected)) select(null);
    else select(selected);
  };

  const refresh = async (): Promise<void> => {
    if (!client) {
      showEmpty("Not connected", "Connect to a fixture that is in a mesh to see the mesh map.");
      return;
    }
    const s = await client.getMeshTopology();
    if (s.on && s.meshId !== undefined) {
      const rec = await meshStore.list().then((all) => all.find((x) => x.meshId === (s.meshId ?? 0) >>> 0)).catch(() => undefined);
      names = new Map((rec?.members ?? []).filter((m) => m.label).map((m) => [m.node, m.label]));
    }
    render(s);
  };

  const tick = (): void => {
    if (disposed) return;
    void refresh()
      .catch((e: unknown) => {
        if (!mounted) showEmpty("Couldn't read the mesh", `The fixture didn't answer (${(e as Error).message}). Check the connection and try again.`);
        else status.textContent = "Couldn't refresh the map; trying again…";
      })
      .finally(() => {
        if (!disposed && client) timer = setTimeout(tick, POLL_MS);
      });
  };

  return {
    el,
    onMount: () => tick(),
    onUnmount: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      sheet?.close();
      view.dispose();
    },
  };
}

let stylesInstalled = false;

function installTopoStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.append(st);
}

const CSS = `
.screen--meshtopo { padding: 16px; box-sizing: border-box; }
.mtopo { display: flex; flex-direction: column; gap: 12px; max-width: 960px; margin: 0 auto; }
.mtopo-status { margin: 0; font-size: 0.9375rem; color: var(--text); line-height: 1.45; }
.mtopo-note { margin: 0; font-size: 0.8125rem; color: var(--text-dim); line-height: 1.45; }
.mtopo-hint { margin: 0; font-size: var(--f-caption); color: var(--text-dim); }
.mtopo-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  overflow: hidden; height: clamp(300px, 80vw, 520px);
}
.mesh-topo-view { display: block; width: 100%; height: 100%; cursor: grab; }
.mesh-topo-view:active { cursor: grabbing; }
.mtopo-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.mtopo-controls-label { font-size: 0.875rem; color: var(--text-dim); }
.mtopo-seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-ctrl); overflow: hidden; }
.mtopo-seg button {
  background: var(--surface-2, var(--surface)); color: var(--text-dim); border: 0; border-left: 1px solid var(--border);
  font: inherit; font-size: 0.875rem; padding: 0 16px; min-height: 40px; min-width: 72px; cursor: pointer;
}
.mtopo-seg button:first-child { border-left: 0; }
.mtopo-seg button.on { background: var(--accent); color: #fff; }
.mtopo-legend {
  list-style: none; margin: 0; padding: 0; display: grid; gap: 8px 16px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); font-size: 0.8125rem; color: var(--text-dim);
}
.mtopo-legend li { display: flex; align-items: center; gap: 8px; }
.mtopo-swatch { flex: none; display: inline-block; }
.mtopo-swatch--line { width: 22px; height: 4px; border-radius: 2px; background: var(--sw); }
.mtopo-swatch--dot { width: 12px; height: 12px; border-radius: 50%; background: var(--sw); margin: 0 5px; }
.mtopo-swatch--ring { width: 12px; height: 12px; box-sizing: border-box; border-radius: 50%; border: 2px dashed var(--sw); margin: 0 5px; }
.mtopo-swatch--square { width: 14px; height: 14px; border-radius: 4px; background: var(--sw); margin: 0 4px; }
.mtopo-list { margin-bottom: 8px; }
.mtopo-member[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.mtopo-dot--ok { background: #2fb36d; }
.mtopo-dot--warn { background: #e0a100; }
.mtopo-dot--bad { background: #e5484d; }
.mtopo-dot--hollow { background: transparent; border: 2px dashed currentColor; width: 12px; height: 12px; box-sizing: border-box; }
.mtopo-dot--hollow.mtopo-dot--ok { color: #2fb36d; }
.mtopo-dot--hollow.mtopo-dot--warn { color: #e0a100; }
.mtopo-dot--hollow.mtopo-dot--bad { color: #e5484d; }
.mtopo-dot--bridge { border-radius: 3px; }
.mtopo-sheet .mesh-kv > span:last-child { text-align: right; }
@media (min-width: 900px) {
  .screen--meshtopo { padding: 24px; }
}
`;
