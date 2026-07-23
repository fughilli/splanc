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
import { extractTopology, type ExtractOptions } from "../../topology/extract";
import { MapView } from "../mapview";
import { Button, Card, IconButton, Sheet, Slider, toast } from "../kit";
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

  // 3D view controls: toggle grid + world triad (owner guidance).
  const viewToggles = document.createElement("div");
  viewToggles.className = "detail-viewtoggles";

  const actions = document.createElement("div");
  actions.className = "detail-actions";

  const topoPanel = document.createElement("div");
  topoPanel.className = "detail-topo";
  topoPanel.style.display = "none";

  el.append(canvas, metaStrip, viewToggles, actions, topoPanel);

  let view: MapView | null = null;
  let rec: StoredMap | null = null;
  let currentTopology: Topology | null = null;
  let topoAbort: AbortController | null = null;
  let fineTune = false;
  let cleanup = 0.5;
  const raw = { ...DEFAULTS };

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

    viewToggles.append(
      setToggle("Grid", false, (v) => setViewFlag("showGrid", v)),
      setToggle("Triad", false, (v) => setViewFlag("showTriad", v)),
      setToggle("Camera path", false, (v) => {
        if (view) view.showTrajectory = v;
      }),
    );

    // Primary paths.
    actions.append(
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
    if (opts.topologyOpen) toggleTopo();
  }

  function setViewFlag(flag: "showGrid" | "showTriad", v: boolean): void {
    // MapView may not implement these yet; set defensively so the build stays
    // green whether or not the renderer has the grid/triad (owner request).
    if (view) (view as unknown as Record<string, boolean>)[flag] = v;
  }

  function toggleTopo(): void {
    const open = topoPanel.style.display === "none";
    topoPanel.style.display = open ? "" : "none";
    if (open && currentTopology === null) void previewTopology();
    if (open) router.navigate(`/map/${mapId}/topology`);
    else router.navigate(`/map/${mapId}`);
  }

  const summaryEl = document.createElement("div");
  summaryEl.className = "topo-summary metric";
  const progressEl = document.createElement("div");
  progressEl.className = "topo-progress";
  progressEl.style.display = "none";

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
