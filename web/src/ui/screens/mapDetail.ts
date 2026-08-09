/**
 * Map Detail / mapping workspace (design doc §4.3 / §7.4) — the working surface
 * for a single captured map: inspect the 3D solve, edit + clean the skelgraph
 * topology, send to / pull from a device, jump to Effects, and manage metadata.
 *
 * Reuses MapView (3D), topology/extract.ts (unchanged, incl. cooperative
 * AbortSignal + onProgress), and net/client for upload/download. The topology
 * panel exposes the full ExtractOptions set behind a "Fine-tune" disclosure
 * with a single Cleanup knob up front (owner guidance in §9 Q4).
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import {
  extractTopology,
  type ExtractOptions,
  type TopologyDebug,
} from "../../topology/extract";
import { fmtLen, summarizeTopologyDebug } from "../../topology/debugSummary";
import {
  autoscaleToUnitBox,
  mapBounds,
  recenterToCentroid,
  transformMap,
  type MapXform,
} from "../../geom/mapTransform";
import { MapView } from "../mapview";
import { Button, Card, Slider, toast, icon, type IconName } from "../kit";
import { mapStore, type StoredMap } from "../../store/mapStore";
import { appState } from "../app/state";
import { openDeviceSheet } from "./deviceSheet";
import type { Router, Screen } from "../app/router";

// The five raw ExtractOptions and the single-knob "Cleanup" curve over them.
// Cleanup 0..1 sweeps the two perceptually-dominant knobs (radius + prune);
// Fine-tune reveals all five (owner: expose the full set + a reticle overlay).
interface RawOpts {
  radiusFactor: number;
  pruneFactor: number;
  loopFactor: number;
  simplifyFrac: number;
  maxPolyline: number;
}

const DEFAULTS: RawOpts = {
  radiusFactor: 2.5,
  pruneFactor: 3,
  loopFactor: 2,
  simplifyFrac: 0.5,
  maxPolyline: 64,
};

function cleanupToOptions(cleanup: number, base: RawOpts): RawOpts {
  // cleanup 0 = light touch (small radius, little pruning); 1 = aggressive.
  return {
    ...base,
    radiusFactor: 1.6 + cleanup * 4.4, // 1.6 .. 6.0
    pruneFactor: cleanup * 6, // 0 .. 6
  };
}

export function MapDetailScreen(
  router: Router,
  mapId: string,
  opts: { topologyOpen?: boolean } = {},
): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--detail";

  const canvas = document.createElement("canvas");
  canvas.className = "detail-canvas";
  canvas.width = 640;
  canvas.height = 420;

  const metaStrip = document.createElement("div");
  metaStrip.className = "detail-meta metric";

  // 3D view controls: toggle grid + world triad + camera path. Small round
  // buttons overlaid in the viewport corner (not eating scroll-column height).
  const viewToggles = document.createElement("div");
  viewToggles.className = "detail-viewtoggles";

  // The viewport "stage": the canvas plus its corner overlay controls. In the
  // wide layout this sits beside the editor panels (see .detail-main).
  const stage = document.createElement("div");
  stage.className = "detail-stage";
  stage.append(canvas, viewToggles, metaStrip);

  const actions = document.createElement("div");
  actions.className = "detail-actions";

  // Editor panels live stacked (absolutely) inside a collapsible region between
  // the 3D view and the action tiles. The region's split divider rolls the active
  // panel out/up (animated height); the two panels crossfade when switching.
  const topoPanel = document.createElement("div");
  topoPanel.className = "detail-topo detail-panel";

  const xformPanel = document.createElement("div");
  xformPanel.className = "detail-topo detail-xform detail-panel";

  const panelRegion = document.createElement("div");
  panelRegion.className = "detail-panelregion";
  panelRegion.append(xformPanel, topoPanel);
  // Once the region has fully rolled up (height reached 0), drop scroll mode and
  // release the frozen 3D-view height — deferred to here (not on the toggle) so
  // closing rolls up cleanly instead of the view snapping back mid-animation.
  panelRegion.addEventListener("transitionend", (e) => {
    if (e.propertyName === "height" && activePanel === "none") {
      el.classList.remove("detail--panel-open");
      stage.style.height = "";
    }
  });

  const main = document.createElement("div");
  main.className = "detail-main";
  main.append(stage);

  el.append(main, panelRegion, actions);

  // The map + topology being edited live on `rec`/`currentTopology` (in memory);
  // transforms mutate those and re-render, and Save persists them. `dirty` gates
  // the Save button; Reset re-reads the stored record.
  let dirty = false;

  let view: MapView | null = null;
  let rec: StoredMap | null = null;
  let currentTopology: Topology | null = null;
  let topoAbort: AbortController | null = null;
  let fineTune = false;
  let cleanup = 0.5;
  const raw = { ...DEFAULTS };

  // The Transform / Topology action tiles double as mutually-exclusive toggles:
  // the open panel's tile lights up (accent), and opening one closes the other.
  let xformTile: HTMLElement | null = null;
  let topoTile: HTMLElement | null = null;
  // Topology "Save" (floppy) — greyed until the working topology differs from the
  // one stored in the record. `storedTopoSig` is that record's signature.
  let topoSaveBtn: HTMLButtonElement | null = null;
  let storedTopoSig = "";
  // Transform "Save" tile — greyed until there are unsaved transform edits.
  let xformSaveTile: HTMLElement | null = null;
  // Cleanup slider (the all-in-one) — greyed while the Fine-tune section is open,
  // since fine-tune drives the extraction directly then.
  let cleanupSliderEl: HTMLElement | null = null;
  let cleanupInput: HTMLInputElement | null = null;

  // Diagnostics (Debug section): master toggle gates the extra `debug: true`
  // compute; the three layer flags drive the MapView overlay. All off ⇒ no cost.
  let diagnostics = false;
  const debugFlags = { coincident: false, edges: false, chords: false };
  let lastDebug: TopologyDebug | null = null;
  // Stage scrubber: 0 = off (show the final topology); 1..N select stages[idx-1].
  let stageIdx = 0;

  // Show the currently-selected pipeline stage (or clear it when off / no report).
  const applyStage = (): void => {
    const stages = lastDebug?.stages ?? [];
    view?.setStage(stageIdx > 0 ? (stages[stageIdx - 1] ?? null) : null);
  };

  // Text pill toggle (used for in-panel diagnostics layer toggles).
  const setToggle = (label: string, on: boolean, fn: (v: boolean) => void): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toggle-chip" + (on ? " toggle-chip--on" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      on = !on;
      b.classList.toggle("toggle-chip--on", on);
      fn(on);
    });
    return b;
  };

  // Small round overlay toggle (icon + tooltip) for the viewport corner.
  const iconToggle = (
    name: IconName,
    title: string,
    on: boolean,
    fn: (v: boolean) => void,
  ): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "viewtoggle" + (on ? " viewtoggle--on" : "");
    b.title = title;
    b.setAttribute("aria-label", title);
    b.setAttribute("aria-pressed", String(on));
    b.appendChild(icon(name));
    b.addEventListener("click", () => {
      on = !on;
      b.classList.toggle("viewtoggle--on", on);
      b.setAttribute("aria-pressed", String(on));
      fn(on);
    });
    return b;
  };

  // An icon+label action tile (shared `.k-actiontile` look). Toggle tiles get
  // their `--on` (accent) state driven by setActivePanel().
  const actionTile = (name: IconName, label: string, onClick: () => void): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "k-actiontile";
    b.append(icon(name));
    const s = document.createElement("span");
    s.textContent = label;
    b.appendChild(s);
    b.addEventListener("click", onClick);
    return b;
  };

  // A collapsible-section header: a chevron (rotates when open) + a label. The
  // caller wires the click to toggle its body and the `--open` class.
  const collapsibleHeader = (label: string, open: boolean): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "topo-disclosure" + (open ? " topo-disclosure--open" : "");
    b.append(icon("chevron"));
    const s = document.createElement("span");
    s.textContent = label;
    b.appendChild(s);
    return b;
  };

  // Signature of a topology (cheap content fingerprint) so "Save" can grey out
  // when the working topology already matches the one stored on the record.
  const topoSig = (t: Topology | null): string => {
    if (!t || t.segments.length === 0) return "none";
    let verts = 0;
    let len = 0;
    for (const s of t.segments) {
      verts += s.polyline.length;
      len += s.length;
    }
    return `${t.segments.length}|${t.branchPoints.length}|${verts}|${len.toFixed(4)}|${t.associations.length}`;
  };
  const refreshTopoSave = (): void => {
    if (!topoSaveBtn) return;
    const cur = topoSig(currentTopology);
    topoSaveBtn.disabled = cur === "none" || cur === storedTopoSig;
  };
  const refreshXformSave = (): void => {
    xformSaveTile?.classList.toggle("k-actiontile--disabled", !dirty);
  };

  async function load(): Promise<void> {
    rec = (await mapStore.get(mapId)) ?? null;
    if (rec === null) {
      el.append(Card("Map not found."));
      return;
    }
    appState.setSelectedMap(mapId);
    const map: OutputMap = rec.map;
    view = new MapView(canvas, map);
    view.setTrajectory(map.trajectory ?? null);
    view.start();
    metaStrip.textContent =
      `${map.ledCount} LEDs · rms ${(rec.rmsReprojPx || 0).toFixed(1)} px · ${new Date(rec.updatedAt).toLocaleDateString()}`;

    // Seed the toggle pressed-state from the view's grid/triad, which MapView
    // initialised from the Appearance defaults — so an on-by-default overlay
    // shows the button lit and can be toggled back off from here.
    viewToggles.append(
      iconToggle("grid", "Grid", view.showGrid, (v) => setViewFlag("showGrid", v)),
      iconToggle("triad", "World triad", view.showTriad, (v) => setViewFlag("showTriad", v)),
      iconToggle("camera-path", "Camera path", false, (v) => {
        if (view) view.showTrajectory = v;
      }),
    );

    // Primary paths — icon+label tiles (like the app's other action grids).
    // Transform / Topology are toggles (light up when their panel is open);
    // Push / Pull are one-shot actions. Effects navigation lives in the bottom
    // tab strip, so it's not repeated here.
    const grid = document.createElement("div");
    grid.className = "k-actiongrid";
    xformTile = actionTile("move", "Transform", toggleXform);
    topoTile = actionTile("tree", "Topology", toggleTopo);
    grid.append(
      xformTile,
      topoTile,
      actionTile("map-to-device", "Push", () => void sendToDevice()),
      actionTile("map-from-device", "Pull", () => void pullFromDevice()),
    );
    actions.append(grid);

    // Seed topology: prefer a stored one (pulled/imported maps carry it) over
    // re-extraction, matching §4.3 "skip re-extraction unless the user opts to".
    if (rec.topology && rec.topology.segments.length > 0) {
      currentTopology = rec.topology;
      view.setTopology(currentTopology);
    }
    storedTopoSig = topoSig(rec.topology ?? null);
    buildTopoPanel();
    // Deep-linked / remounted onto the topology route: open the panel WITHOUT
    // navigating — navigating to the route we're already on would re-resolve the
    // router and remount this screen in an infinite loop (blank/thrashing page).
    if (opts.topologyOpen) openTopoPanel();
  }

  function setViewFlag(flag: "showGrid" | "showTriad", v: boolean): void {
    // MapView may not implement these yet; set defensively so the build stays
    // green whether or not the renderer has the grid/triad (owner request).
    if (view) (view as unknown as Record<string, boolean>)[flag] = v;
  }

  // Only one editor panel is open at a time. Switching crossfades the panels
  // while the region's split divider animates to the new height (roll out / up).
  let activePanel: "none" | "xform" | "topo" = "none";

  // Set the region to the active panel's full natural height (absolute panels
  // size to their content) — the region never scrolls internally; the overall
  // screen scrolls. Open/close/switch and in-panel expansions animate the height.
  function refreshPanelHeight(): void {
    if (activePanel === "none") {
      panelRegion.style.height = "0px";
      return;
    }
    const panel = activePanel === "xform" ? xformPanel : topoPanel;
    panelRegion.style.height = `${panel.scrollHeight}px`;
  }

  function setActivePanel(which: "none" | "xform" | "topo"): void {
    const wasOpen = activePanel !== "none";
    activePanel = which;
    if (which === "xform" && !xformBuilt) {
      buildTransformPanel();
      xformBuilt = true;
    }
    // On first open: freeze the 3D view at its current fill height and switch to
    // scroll mode, so the view keeps its size and the tiles displace downward
    // instead of the view shrinking. Released once the region fully rolls up
    // (finalizeClose, on the height transition end) so closing doesn't jump.
    if (which !== "none" && !wasOpen) {
      stage.style.height = `${stage.offsetHeight}px`;
      el.classList.add("detail--panel-open");
    }
    // Crossfade to the active panel; roll the divider to the new height.
    xformPanel.classList.toggle("detail-panel--show", which === "xform");
    topoPanel.classList.toggle("detail-panel--show", which === "topo");
    panelRegion.classList.toggle("detail-panelregion--open", which !== "none");
    refreshPanelHeight();
    // Light up the active toggle tile (Transform / Topology are mutually exclusive).
    xformTile?.classList.toggle("k-actiontile--on", which === "xform");
    topoTile?.classList.toggle("k-actiontile--on", which === "topo");
  }

  // Open the topology panel (no routing — the /topology route deep-links it on
  // mount via opts.topologyOpen). Opening it closes the Transform panel.
  function openTopoPanel(): void {
    setActivePanel("topo");
    if (currentTopology === null) void previewTopology();
  }

  function toggleTopo(): void {
    if (activePanel === "topo") setActivePanel("none");
    else openTopoPanel();
  }

  // -- transform tools (translate / rotate / scale + auto-fixes) --------------
  // A purely local panel (no routing — it isn't deep-linked). Transforms mutate
  // the in-memory rec.map (+ currentTopology) and re-render; Save persists.
  let xformBuilt = false;
  const xformDirty = document.createElement("span");

  function toggleXform(): void {
    setActivePanel(activePanel === "xform" ? "none" : "xform");
  }

  function markDirty(): void {
    dirty = true;
    xformDirty.textContent = "• unsaved";
    refreshTopoSave(); // a transform also moves/scales the topology
    refreshXformSave();
  }

  /** Apply a transform to the working map (and topology) and re-render. */
  function applyXform(x: MapXform): void {
    if (rec === null) return;
    const out = transformMap(rec.map, currentTopology ?? undefined, x);
    rec.map = out.map;
    if (out.topology) currentTopology = out.topology;
    view?.update(rec.map);
    if (currentTopology) view?.setTopology(currentTopology);
    markDirty();
  }

  /** Compose per-axis rotations (degrees) about the map centroid and apply. */
  function applyRotateXYZ(deg: [number, number, number]): void {
    if (rec === null) return;
    const pivot = pivotCentroid();
    let map = rec.map;
    let topo: Topology | undefined = currentTopology ?? undefined;
    let changed = false;
    (["x", "y", "z"] as const).forEach((axis, i) => {
      if (!deg[i]) return;
      const out = transformMap(map, topo, { rot: { axis, deg: deg[i]! }, pivot });
      map = out.map;
      topo = out.topology;
      changed = true;
    });
    if (!changed) return;
    rec.map = map;
    if (topo) currentTopology = topo;
    view?.update(rec.map);
    if (currentTopology) view?.setTopology(currentTopology);
    markDirty();
  }

  function pivotCentroid(): [number, number, number] {
    const b = rec ? mapBounds(rec.map) : null;
    return b ? b.centroid : [0, 0, 0];
  }

  function autoSnap(): void {
    if (rec === null) return;
    const out = recenterToCentroid(rec.map, currentTopology ?? undefined);
    rec.map = out.map;
    if (out.topology) currentTopology = out.topology;
    view?.update(rec.map);
    if (currentTopology) view?.setTopology(currentTopology);
    markDirty();
    toast("Centered on origin");
  }

  function autoScale(): void {
    if (rec === null) return;
    const out = autoscaleToUnitBox(rec.map, currentTopology ?? undefined);
    rec.map = out.map;
    if (out.topology) currentTopology = out.topology;
    view?.update(rec.map);
    if (currentTopology) view?.setTopology(currentTopology);
    markDirty();
    toast("Scaled to unit box");
  }

  async function resetEdits(): Promise<void> {
    const fresh = await mapStore.get(mapId);
    if (!fresh) return;
    rec = fresh;
    currentTopology =
      fresh.topology && fresh.topology.segments.length > 0 ? fresh.topology : null;
    view?.update(rec.map);
    view?.setTopology(currentTopology);
    dirty = false;
    xformDirty.textContent = "";
    refreshTopoSave();
    refreshXformSave();
    toast("Reverted edits");
  }

  async function saveEdits(): Promise<void> {
    if (rec === null || !dirty) return;
    await mapStore.setMap(mapId, rec.map, currentTopology ?? undefined);
    dirty = false;
    xformDirty.textContent = "";
    refreshXformSave();
    // The record now holds these edits, so the topology matches too.
    storedTopoSig = topoSig(currentTopology);
    refreshTopoSave();
    toast("Transform saved");
  }

  function buildTransformPanel(): void {
    // A labelled X/Y/Z entry row with an Apply button. `def` is the identity value
    // (0 for move/rotate deltas, 1 for scale) the fields reset to after applying.
    const xyzRow = (
      label: string,
      def: number,
      onApply: (v: [number, number, number]) => void,
    ): HTMLElement => {
      const row = document.createElement("div");
      row.className = "xform-row";
      const l = document.createElement("span");
      l.className = "xform-label";
      l.textContent = label;
      const fields = document.createElement("div");
      fields.className = "xform-fields";
      const inputs: HTMLInputElement[] = [];
      for (const axis of ["X", "Y", "Z"]) {
        const field = document.createElement("label");
        field.className = "xform-field";
        const cap = document.createElement("span");
        cap.textContent = axis;
        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = "any";
        inp.inputMode = "decimal";
        inp.value = String(def);
        field.append(cap, inp);
        fields.append(field);
        inputs.push(inp);
      }
      const apply = Button({
        label: "Apply",
        onClick: () => {
          const v = inputs.map((i) => parseFloat(i.value) || def) as [number, number, number];
          onApply(v);
          inputs.forEach((i) => (i.value = String(def)));
        },
      });
      row.append(l, fields, apply);
      return row;
    };

    // Move / Rotate (deg, about the centroid) / Scale (per-axis, about the centroid).
    const move = xyzRow("Move", 0, (v) => applyXform({ translate: v }));
    const rotate = xyzRow("Rotate", 0, (v) => applyRotateXYZ(v));
    const scale = xyzRow("Scale", 1, (v) => applyXform({ scale: v, pivot: pivotCentroid() }));

    // Icon+label tools: Center (bullseye), Autoscale (fit-to-bounds), Reset, Save.
    xformSaveTile = actionTile("save", "Save", () => void saveEdits());
    const tools = document.createElement("div");
    tools.className = "k-actiongrid xform-tools";
    tools.append(
      actionTile("center", "Center", autoSnap),
      actionTile("autoscale", "Autoscale", autoScale),
      actionTile("reset", "Reset", () => void resetEdits()),
      xformSaveTile,
    );

    xformPanel.append(move, rotate, scale, tools);
    refreshXformSave();
  }

  const summaryEl = document.createElement("div");
  summaryEl.className = "topo-summary metric";
  const progressEl = document.createElement("div");
  progressEl.className = "topo-progress";
  progressEl.style.display = "none";

  // Debug section: a summary line, a hint, and a compact coincident-pair list.
  const debugSummaryEl = document.createElement("div");
  debugSummaryEl.className = "topo-debug-summary metric";
  const debugHintEl = document.createElement("div");
  debugHintEl.className = "topo-debug-hint";
  debugHintEl.style.display = "none";
  debugHintEl.textContent =
    "Coincident LEDs create a false bridge — re-solve or nudge them, or edit the topology manually.";
  const debugListEl = document.createElement("div");
  debugListEl.className = "topo-debug-list metric";

  /** Repaint the Debug section's summary/hint/list from the latest report. */
  function refreshDebugReport(): void {
    if (!diagnostics) {
      debugSummaryEl.textContent = "";
      debugSummaryEl.classList.remove("topo-debug-summary--warn");
      debugHintEl.style.display = "none";
      debugListEl.innerHTML = "";
      return;
    }
    if (lastDebug === null) {
      debugSummaryEl.textContent = "Diagnostics on — extracting…";
      debugSummaryEl.classList.remove("topo-debug-summary--warn");
      debugHintEl.style.display = "none";
      debugListEl.innerHTML = "";
      return;
    }
    const d = lastDebug;
    debugSummaryEl.textContent = summarizeTopologyDebug(d);
    // Prominent warning colour when there's a coincident pair (bridge suspect).
    debugSummaryEl.classList.toggle("topo-debug-summary--warn", d.coincident.length > 0);
    debugHintEl.style.display = d.coincident.length > 0 ? "" : "none";
    debugListEl.innerHTML = "";
    // Eyeball list of the closest coincident pairs (cap so it stays compact).
    const pairs = [...d.coincident].sort((a, b) => a.dist - b.dist).slice(0, 8);
    for (const p of pairs) {
      const row = document.createElement("div");
      row.className = "topo-debug-pair";
      row.textContent = `● coincident pair · ${fmtLen(p.dist)}`;
      debugListEl.append(row);
    }
    if (d.coincident.length > pairs.length) {
      const more = document.createElement("div");
      more.className = "topo-debug-pair topo-debug-pair--more";
      more.textContent = `…and ${d.coincident.length - pairs.length} more`;
      debugListEl.append(more);
    }
  }

  function buildTopoPanel(): void {
    topoPanel.innerHTML = "";
    const head = document.createElement("div");
    head.className = "topo-head";
    head.textContent = "Topology";
    topoPanel.append(head, summaryEl);

    const cleanupSlider = Slider({
      label: "Cleanup",
      min: 0,
      max: 1,
      step: 0.02,
      value: cleanup,
      format: (v) => (v < 0.05 ? "light" : v > 0.95 ? "max" : v.toFixed(2)),
      onInput: (v) => {
        cleanup = v;
        void previewTopology();
      },
    });
    topoPanel.append(cleanupSlider.el);
    cleanupSliderEl = cleanupSlider.el;
    cleanupInput = cleanupSlider.input;

    // Fine-tune collapsible section: the full five ExtractOptions. While it's
    // open it drives the extraction directly, so the all-in-one Cleanup slider is
    // greyed out.
    const disclosure = collapsibleHeader("Fine-tune", fineTune);
    const fine = document.createElement("div");
    fine.className = "topo-fine";
    fine.style.display = fineTune ? "" : "none";
    const syncCleanup = (): void => {
      cleanupSliderEl?.classList.toggle("k-slider--disabled", fineTune);
      if (cleanupInput) cleanupInput.disabled = fineTune;
    };
    syncCleanup();
    disclosure.addEventListener("click", () => {
      fineTune = !fineTune;
      fine.style.display = fineTune ? "" : "none";
      disclosure.classList.toggle("topo-disclosure--open", fineTune);
      syncCleanup();
      refreshPanelHeight();
    });
    const addRaw = (
      key: keyof RawOpts,
      label: string,
      min: number,
      max: number,
      step: number,
    ): void => {
      fine.append(
        Slider({
          label,
          min,
          max,
          step,
          value: raw[key],
          format: (v) => (step >= 1 ? String(Math.round(v)) : v.toFixed(1)),
          onInput: (v) => {
            raw[key] = v;
            void previewTopology(true);
          },
        }).el,
      );
    };
    addRaw("radiusFactor", "neighbour radius", 1.2, 8, 0.2);
    addRaw("pruneFactor", "prune spurs", 0, 8, 0.5);
    addRaw("loopFactor", "close loops", 0, 4, 0.2);
    addRaw("simplifyFrac", "simplify", 0, 2, 0.1);
    addRaw("maxPolyline", "max verts/segment", 4, 128, 4);
    topoPanel.append(disclosure, fine, progressEl);

    // -- Debug collapsible section: diagnostics master + overlay layer toggles -
    const dbgDisclosure = collapsibleHeader("Debug", false);
    let dbgOpen = false;
    const dbgBody = document.createElement("div");
    dbgBody.className = "topo-fine topo-debug";
    dbgBody.style.display = "none";
    dbgDisclosure.addEventListener("click", () => {
      dbgOpen = !dbgOpen;
      dbgBody.style.display = dbgOpen ? "" : "none";
      dbgDisclosure.classList.toggle("topo-disclosure--open", dbgOpen);
      refreshPanelHeight();
    });

    // Layer sub-toggles live in their own row; disabled visually until the
    // master Diagnostics toggle is on (they still work, just have no report).
    const layerRow = document.createElement("div");
    layerRow.className = "topo-debug-layers";
    const layerToggle = (
      label: string,
      key: keyof typeof debugFlags,
    ): HTMLElement =>
      setToggle(label, false, (v) => {
        debugFlags[key] = v;
        view?.setDebugOverlay(lastDebug, debugFlags);
      });
    layerRow.append(
      layerToggle("Flag coincident LEDs", "coincident"),
      layerToggle("Show graph edges", "edges"),
      layerToggle("Highlight loop-chords", "chords"),
    );
    // Stage scrubber: step through each pipeline stage's raw output. Names come
    // from the report; the pipeline always emits the same 7 in order.
    const STAGE_NAMES = [
      "k-NN graph",
      "MST forest",
      "loop chords",
      "prune + retrace",
      "segments",
      "merge junctions",
      "dissolve (final)",
    ];
    const stageLabel = (v: number): string =>
      v === 0 ? "off" : (lastDebug?.stages[v - 1]?.name ?? STAGE_NAMES[v - 1] ?? `stage ${v}`);
    const stageSlider = Slider({
      label: "Stage",
      min: 0,
      max: STAGE_NAMES.length,
      step: 1,
      value: stageIdx,
      format: stageLabel,
      onInput: (v) => {
        stageIdx = v;
        applyStage();
      },
    });
    stageSlider.el.classList.add("topo-debug-stage");

    const syncLayerRow = (): void => {
      layerRow.classList.toggle("topo-debug-layers--off", !diagnostics);
      stageSlider.el.classList.toggle("topo-debug-layers--off", !diagnostics);
    };
    syncLayerRow();

    const masterToggle = setToggle("Diagnostics", diagnostics, (v) => {
      diagnostics = v;
      syncLayerRow();
      if (v) {
        // Re-run with debug on so the report is available.
        void previewTopology();
      } else {
        // Off: drop the report + overlay + stage view and clear the section.
        lastDebug = null;
        stageIdx = 0;
        stageSlider.input.value = "0";
        stageSlider.setValueText(stageLabel(0));
        view?.setStage(null);
        view?.setDebugOverlay(null, debugFlags);
        refreshDebugReport();
        refreshPanelHeight();
      }
    });

    dbgBody.append(masterToggle, layerRow, stageSlider.el, debugSummaryEl, debugHintEl, debugListEl);
    topoPanel.append(dbgDisclosure, dbgBody);
    refreshDebugReport();

    // Just a Save (floppy) — pushing to the device is the top-level "Push" tile.
    // Greyed until the working topology differs from the one stored on the record.
    topoSaveBtn = Button({ label: "Save", icon: "save", onClick: () => void saveTopology() });
    const btns = document.createElement("div");
    btns.className = "topo-btns";
    btns.append(topoSaveBtn);
    topoPanel.append(btns);
    refreshTopoSave();
  }

  async function previewTopology(useFine = false): Promise<void> {
    if (rec === null || view === null) return;
    const map = rec.map;
    const options: ExtractOptions = useFine || fineTune ? { ...raw } : cleanupToOptions(cleanup, raw);
    // Only pay for the debug report when the master Diagnostics toggle is on.
    if (diagnostics) options.debug = true;
    topoAbort?.abort();
    const ac = new AbortController();
    topoAbort = ac;
    const delay = window.setTimeout(() => {
      if (topoAbort === ac) progressEl.style.display = "";
    }, 300);
    try {
      const topo = await extractTopology(map, options, {
        signal: ac.signal,
        onProgress: (frac) => (progressEl.textContent = `Extracting… ${Math.round(frac * 100)}%`),
      });
      if (ac.signal.aborted) return;
      topo.mapId = map.mapId;
      currentTopology = topo;
      view.setTopology(topo);
      // Refresh the diagnostics report + overlay (or clear it when Diagnostics
      // is off), then update the Debug section's summary + coincident list.
      lastDebug = diagnostics ? (topo.debug ?? null) : null;
      view.setDebugOverlay(lastDebug, debugFlags);
      applyStage(); // refresh the stage overlay against the new report
      refreshDebugReport();
      refreshTopoSave();
      refreshPanelHeight(); // summary/diagnostics may have changed the panel height
      const verts = topo.segments.reduce((n, s) => n + s.polyline.length, 0);
      const lenM = topo.segments.reduce((a, s) => a + s.length, 0);
      summaryEl.textContent =
        `${topo.branchPoints.length} junc · ${topo.segments.length} seg · ${verts} verts · ` +
        `${lenM.toFixed(2)} m · ${topo.associations.length}/${map.leds.length} LEDs`;
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        toast(`Topology failed: ${e instanceof Error ? e.message : e}`, { error: true });
      }
    } finally {
      if (topoAbort === ac) {
        topoAbort = null;
        clearTimeout(delay);
        progressEl.style.display = "none";
      }
    }
  }

  async function saveTopology(): Promise<void> {
    if (currentTopology === null || currentTopology.segments.length === 0) {
      toast("No topology to save", { error: true });
      return;
    }
    await mapStore.setTopology(mapId, currentTopology);
    if (rec) rec.topology = currentTopology; // record now matches → Save greys out
    storedTopoSig = topoSig(currentTopology);
    refreshTopoSave();
    toast("Topology saved");
  }

  async function sendToDevice(): Promise<void> {
    const client = appState.client;
    if (client === null || !client.isConnected) {
      toast("No device connected", { error: true });
      openDeviceSheet();
      return;
    }
    if (rec === null) return;
    try {
      // Owner (§9 Q3): the device should get both the 3D map AND the topology.
      await client.submitMap(rec.map);
      if (currentTopology && currentTopology.segments.length > 0) {
        await client.submitTopology(currentTopology);
      }
      toast("Sent to device");
    } catch (e) {
      toast(`Send failed: ${e instanceof Error ? e.message : e}`, { error: true });
    }
  }

  async function pullFromDevice(): Promise<void> {
    const client = appState.client;
    if (client === null || !client.isConnected) {
      toast("No device connected", { error: true });
      openDeviceSheet();
      return;
    }
    try {
      toast("Pulling map from device…");
      const bundle = await client.pullStoredMap();
      const id = await mapStore.importBundleObject(bundle, { source: "pull" });
      toast("Map pulled from device");
      router.navigate(`/map/${id}`);
    } catch (e) {
      toast(`Pull failed: ${e instanceof Error ? e.message : e}`, { error: true });
    }
  }

  // (No in-body ⋯ menu: metadata/duplicate/export/delete live in the per-map ⋯
  // in the Maps tab, so they aren't duplicated here.)

  // Keep the rolled-out region sized correctly across viewport changes (the cap
  // and the panel's wrapped height both depend on the viewport).
  const onResize = (): void => refreshPanelHeight();

  return {
    el,
    onMount: () => {
      window.addEventListener("resize", onResize);
      void load();
    },
    onUnmount: () => {
      window.removeEventListener("resize", onResize);
      topoAbort?.abort();
      view?.stop();
      view = null;
    },
  };
}
