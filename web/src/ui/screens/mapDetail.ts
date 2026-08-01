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
import { Button, Card, IconButton, Sheet, Slider, toast, icon, type IconName } from "../kit";
import { mapStore, type StoredMap } from "../../store/mapStore";
import { appState } from "../app/state";
import { openDeviceSheet } from "./deviceSheet";
import { downloadBytes } from "./mapBrowser";
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

  const topoPanel = document.createElement("div");
  topoPanel.className = "detail-topo";
  topoPanel.style.display = "none";

  const xformPanel = document.createElement("div");
  xformPanel.className = "detail-topo detail-xform";
  xformPanel.style.display = "none";

  // Wide layout: viewport (stage) and editor panels side-by-side; narrow: they
  // wrap to a single column. Flex-wrap does this responsively with no JS.
  const main = document.createElement("div");
  main.className = "detail-main";
  main.append(stage, xformPanel, topoPanel);

  el.append(main, actions);

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

    // Primary paths.
    actions.append(
      Button({ label: "Transform", icon: "move", variant: "quiet", onClick: toggleXform }),
      Button({ label: "Topology", icon: "graph", variant: "quiet", onClick: toggleTopo }),
      Button({ label: "Effects", icon: "sparkles", variant: "quiet", onClick: () => router.navigate("/effects") }),
      Button({ label: "Send to device", icon: "map-to-device", onClick: () => void sendToDevice() }),
      Button({
        label: "Pull from device",
        icon: "map-from-device",
        variant: "quiet",
        onClick: () => void pullFromDevice(),
      }),
    );

    // Seed topology: prefer a stored one (pulled/imported maps carry it) over
    // re-extraction, matching §4.3 "skip re-extraction unless the user opts to".
    if (rec.topology && rec.topology.segments.length > 0) {
      currentTopology = rec.topology;
      view.setTopology(currentTopology);
    }
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

  // Open the topology panel (DOM state only — no routing). Safe to call on mount.
  function openTopoPanel(): void {
    topoPanel.style.display = "";
    if (currentTopology === null) void previewTopology();
  }

  // User action (the "Topology" button): flip the panel AND reflect it in the
  // route so it's deep-linkable / survives back. The navigation remounts the
  // screen, which re-opens the panel via openTopoPanel (never toggleTopo — that
  // would navigate to the current route again and loop).
  function toggleTopo(): void {
    const willOpen = topoPanel.style.display === "none";
    if (willOpen) {
      openTopoPanel();
      router.navigate(`/map/${mapId}/topology`);
    } else {
      topoPanel.style.display = "none";
      router.navigate(`/map/${mapId}`);
    }
  }

  // -- transform tools (translate / rotate / scale + auto-fixes) --------------
  // A purely local panel (no routing — it isn't deep-linked). Transforms mutate
  // the in-memory rec.map (+ currentTopology) and re-render; Save persists.
  let xformBuilt = false;
  const xformDirty = document.createElement("span");

  function toggleXform(): void {
    const open = xformPanel.style.display === "none";
    xformPanel.style.display = open ? "" : "none";
    if (open && !xformBuilt) {
      buildTransformPanel();
      xformBuilt = true;
    }
  }

  function markDirty(): void {
    dirty = true;
    xformDirty.textContent = "• unsaved";
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

  function nudgeStep(): number {
    const b = rec ? mapBounds(rec.map) : null;
    return Math.max(0.01, (b?.maxDim ?? 1) * 0.05); // 5% of the map's extent
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
    toast("Reverted edits");
  }

  async function saveEdits(): Promise<void> {
    if (rec === null || !dirty) return;
    await mapStore.setMap(mapId, rec.map, currentTopology ?? undefined);
    dirty = false;
    xformDirty.textContent = "";
    toast("Transform saved");
  }

  function buildTransformPanel(): void {
    xformDirty.className = "xform-dirty metric";

    const mkRow = (label: string, ...btns: HTMLElement[]): HTMLElement => {
      const row = document.createElement("div");
      row.className = "xform-row";
      const l = document.createElement("span");
      l.className = "xform-label";
      l.textContent = label;
      row.append(l, ...btns);
      return row;
    };
    const tiny = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "xform-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    };

    // Auto-fixes.
    const auto = document.createElement("div");
    auto.className = "xform-row";
    auto.append(
      Button({ label: "Snap to origin", icon: "move", variant: "quiet", onClick: autoSnap }),
      Button({ label: "Autoscale to unit box", variant: "quiet", onClick: autoScale }),
    );

    // Translate — Y is up in the viewer.
    const move = mkRow(
      "Move",
      tiny("X−", "Move −X", () => applyXform({ translate: [-nudgeStep(), 0, 0] })),
      tiny("X+", "Move +X", () => applyXform({ translate: [nudgeStep(), 0, 0] })),
      tiny("Y−", "Move down", () => applyXform({ translate: [0, -nudgeStep(), 0] })),
      tiny("Y+", "Move up", () => applyXform({ translate: [0, nudgeStep(), 0] })),
      tiny("Z−", "Move −Z", () => applyXform({ translate: [0, 0, -nudgeStep()] })),
      tiny("Z+", "Move +Z", () => applyXform({ translate: [0, 0, nudgeStep()] })),
    );

    // Rotate about the map centroid; Y is the up axis (yaw) — most useful first.
    const rotate = mkRow(
      "Rotate",
      tiny("⟲Y", "Yaw −15°", () => applyXform({ rot: { axis: "y", deg: -15 }, pivot: pivotCentroid() })),
      tiny("⟳Y", "Yaw +15°", () => applyXform({ rot: { axis: "y", deg: 15 }, pivot: pivotCentroid() })),
      tiny("⟲X", "Pitch −15°", () => applyXform({ rot: { axis: "x", deg: -15 }, pivot: pivotCentroid() })),
      tiny("⟳X", "Pitch +15°", () => applyXform({ rot: { axis: "x", deg: 15 }, pivot: pivotCentroid() })),
      tiny("⟲Z", "Roll −15°", () => applyXform({ rot: { axis: "z", deg: -15 }, pivot: pivotCentroid() })),
      tiny("⟳Z", "Roll +15°", () => applyXform({ rot: { axis: "z", deg: 15 }, pivot: pivotCentroid() })),
    );

    // Uniform scale about the centroid.
    const scale = mkRow(
      "Scale",
      tiny("÷", "Shrink 10%", () => applyXform({ scale: 1 / 1.1, pivot: pivotCentroid() })),
      tiny("×", "Grow 10%", () => applyXform({ scale: 1.1, pivot: pivotCentroid() })),
    );

    const btns = document.createElement("div");
    btns.className = "topo-btns";
    btns.append(
      Button({ label: "Reset", variant: "quiet", onClick: () => void resetEdits() }),
      Button({ label: "Save", onClick: () => void saveEdits() }),
      xformDirty,
    );

    xformPanel.append(auto, move, rotate, scale, btns);
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

    // Fine-tune disclosure: the full five ExtractOptions.
    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "topo-disclosure";
    disclosure.textContent = fineTune ? "Hide fine-tune" : "Fine-tune ▸";
    const fine = document.createElement("div");
    fine.className = "topo-fine";
    fine.style.display = fineTune ? "" : "none";
    disclosure.addEventListener("click", () => {
      fineTune = !fineTune;
      fine.style.display = fineTune ? "" : "none";
      disclosure.textContent = fineTune ? "Hide fine-tune" : "Fine-tune ▸";
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

    // -- Debug disclosure: diagnostics master + overlay layer toggles ---------
    const dbgDisclosure = document.createElement("button");
    dbgDisclosure.type = "button";
    dbgDisclosure.className = "topo-disclosure";
    let dbgOpen = false;
    const dbgBody = document.createElement("div");
    dbgBody.className = "topo-fine topo-debug";
    dbgBody.style.display = "none";
    dbgDisclosure.textContent = "Debug ▸";
    dbgDisclosure.addEventListener("click", () => {
      dbgOpen = !dbgOpen;
      dbgBody.style.display = dbgOpen ? "" : "none";
      dbgDisclosure.textContent = dbgOpen ? "Hide debug" : "Debug ▸";
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
      }
    });

    dbgBody.append(masterToggle, layerRow, stageSlider.el, debugSummaryEl, debugHintEl, debugListEl);
    topoPanel.append(dbgDisclosure, dbgBody);
    refreshDebugReport();

    const applyBtn = Button({
      label: "Apply to device",
      icon: "map-to-device",
      onClick: () => void uploadTopology(),
    });
    const saveBtn = Button({
      label: "Save topology",
      variant: "quiet",
      onClick: () => void saveTopology(),
    });
    const btns = document.createElement("div");
    btns.className = "topo-btns";
    btns.append(saveBtn, applyBtn);
    topoPanel.append(btns);
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

  async function uploadTopology(): Promise<void> {
    const client = appState.client;
    if (client === null || !client.isConnected) {
      toast("No device connected", { error: true });
      openDeviceSheet();
      return;
    }
    if (currentTopology === null || currentTopology.segments.length === 0) {
      toast("Extract a topology first", { error: true });
      return;
    }
    try {
      await client.submitTopology(currentTopology);
      toast("Topology applied to device");
    } catch (e) {
      toast(`Upload failed: ${e instanceof Error ? e.message : e}`, { error: true });
    }
  }

  // Overflow (⋯): rename, description, tags, duplicate, export, delete.
  function openOverflow(): void {
    if (rec === null) return;
    const cur = rec;
    const sheet = Sheet(cur.name);
    sheet.body.className = "context-sheet";
    const item = (
      label: string,
      ic: Parameters<typeof Button>[0]["icon"] & string,
      fn: () => void,
    ): HTMLElement => Button({ label, icon: ic, variant: "quiet", block: true, onClick: fn });
    sheet.body.append(
      item("Rename", "edit", () => {
        const v = prompt("Name:", cur.name);
        if (v) void mapStore.rename(mapId, v.trim()).then(() => sheet.close());
      }),
      item("Edit description", "edit", () => {
        const v = prompt("Description:", cur.description);
        if (v !== null) void mapStore.setDescription(mapId, v).then(() => sheet.close());
      }),
      item("Tags", "tag", () => {
        const v = prompt("Tags (space-separated):", cur.tags.join(" "));
        if (v !== null) void mapStore.setTags(mapId, v.split(/\s+/)).then(() => sheet.close());
      }),
      item("Duplicate", "map", () => {
        void mapStore.duplicate(mapId).then(() => {
          toast("Duplicated");
          sheet.close();
        });
      }),
      item("Export .binpb", "download", () => {
        void mapStore.exportBundle(mapId).then((b) => {
          downloadBytes(b, `${cur.name.replace(/[^\w.-]+/g, "_") || "map"}.binpb`);
          sheet.close();
        });
      }),
      Button({
        label: "Delete",
        icon: "trash",
        variant: "danger",
        block: true,
        onClick: () => {
          if (!confirm(`Delete "${cur.name}"?`)) return;
          void mapStore.delete(mapId).then(() => {
            sheet.close();
            router.navigate("/maps");
          });
        },
      }),
    );
  }

  // Expose overflow via a header button appended at mount.
  const overflowBtn = IconButton("more", { title: "More", onClick: openOverflow });
  overflowBtn.classList.add("detail-overflow");
  el.prepend(overflowBtn);

  return {
    el,
    onMount: () => void load(),
    onUnmount: () => {
      topoAbort?.abort();
      view?.stop();
      view = null;
    },
  };
}
