/**
 * The "On <device>" card at the top of the Maps tab: the map stored on the
 * connected device, and the way to copy it into this phone's library. A fresh
 * install starts with an empty library, but the fixture still holds its map;
 * this card (and Calibrate IMU, which needs a local map) reach it.
 *
 * The state logic is store/deviceMap.ts (pure, unit-tested); this file renders
 * it and wires the actions.
 */

import type { MappingBundle } from "../../net/proto";
import {
  DeviceMapService,
  deviceCalibrationRoute,
  deviceImuReady,
  ledCounts,
  type DeviceMapCardState,
  type DeviceMapInfo,
  type DeviceMapLibrary,
} from "../../store/deviceMap";
import { mapStore, renderThumbnail, type StoredMap } from "../../store/mapStore";
import { appState } from "../app/state";
import { Button, icon, toast } from "../kit";
import type { Router } from "../app/router";
import { loadCreds } from "./bridgeLive";

/** mapStore as the service's library. */
const library: DeviceMapLibrary = {
  async findByMapId(mapId) {
    const s = await mapStore.findByMapId(mapId);
    if (!s) return undefined;
    const rec = await mapStore.get(s.id);
    return { id: s.id, name: s.name, thumbnail: s.thumbnail, ...(rec ? ledCounts(rec.map) : {}) };
  },
  importBundleObject: (bundle, opts) => mapStore.importBundleObject(bundle, opts),
};

/** One service for the app: its cache of pulled bundles outlives a Maps visit. */
export const deviceMaps = new DeviceMapService(library);

/** Route of the read-only preview of the last pulled device map. */
export const DEVICE_MAP_PREVIEW_ROUTE = "/device-map";

/** The last pulled device map as an unsaved, in-memory record (the preview). */
export function devicePreviewRecord(): StoredMap | null {
  const last = deviceMaps.lastPulled();
  if (!last || !last.bundle.map) return null;
  const { info, bundle } = last;
  const now = new Date().toISOString();
  const rec: StoredMap = {
    id: "",
    name: deviceMapTitle(info),
    description: "",
    tags: [],
    createdAt: info.createdAt || now,
    updatedAt: info.createdAt || now,
    source: "pull",
    ledCount: bundle.map.ledCount,
    units: bundle.map.units,
    frame: bundle.map.frame,
    rmsReprojPx: bundle.map.stats?.rmsReprojPxGlobal ?? 0,
    hasTopology: (bundle.topology?.segments.length ?? 0) > 0,
    thumbnail: "",
    map: bundle.map,
  };
  if (bundle.topology) rec.topology = bundle.topology;
  return rec;
}

/** Display name for a device map that isn't in the library yet. */
export function deviceMapTitle(info: Pick<DeviceMapInfo, "deviceName">): string {
  return `${info.deviceName}'s map`;
}

/** The card's meta line: LED count, mapped vs interpolated, date, size. */
export function deviceMapMeta(info: DeviceMapInfo): string {
  const bits = [`${info.ledCount} LEDs`];
  if (info.mapped !== undefined) {
    bits.push(info.interpolated ? `${info.mapped} mapped · ${info.interpolated} interpolated` : "all mapped");
  }
  if (info.createdAt) {
    const d = new Date(info.createdAt);
    if (!Number.isNaN(d.getTime())) {
      bits.push(`mapped ${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`);
    }
  }
  if (info.mapped === undefined) bits.push(`${Math.max(1, Math.round(info.totalLen / 1024))} KB`);
  return bits.join(" · ");
}

/** Pull + save the device's map (when needed), then open Calibrate IMU on it. */
export async function calibrateFromDevice(
  navigate: (route: string) => void,
  onProgress?: (frac: number) => void,
): Promise<void> {
  const c = appState.client;
  if (!c?.isConnected) {
    toast("No device connected", { error: true });
    return;
  }
  try {
    const route = await deviceCalibrationRoute(deviceMaps, c, (d, t) => onProgress?.(t > 0 ? d / t : 0));
    navigate(route);
  } catch (e) {
    const code = (e as { code?: string }).code;
    toast(code === "no_map" ? "This device has no map to calibrate against yet" : `Couldn't copy the map: ${msg(e)}`, {
      error: true,
    });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DeviceMapCardHandle {
  el: HTMLElement;
  refresh(): void;
  dispose(): void;
}

export function DeviceMapCard(router: Router): DeviceMapCardHandle {
  installDeviceMapCardStyles();
  const el = document.createElement("section");
  el.className = "devmap";
  el.setAttribute("aria-label", "Map on the connected device");
  el.hidden = true;

  let state: DeviceMapCardState = { kind: "hidden" };
  let imu = false;
  let busy: { label: string; frac: number } | null = null;
  let seq = 0;
  let connKey = "";

  const currentKey = (): string => {
    const c = appState.client;
    return c?.isConnected ? `${c.url}|${c.welcome?.sessionId ?? ""}` : "";
  };

  async function probe(): Promise<void> {
    const my = ++seq;
    const c = appState.client;
    if (!c?.isConnected) {
      state = { kind: "hidden" };
      imu = false;
      render();
      return;
    }
    if (state.kind === "hidden") {
      state = { kind: "loading", deviceName: c.welcome?.deviceName || "device" };
      render();
    }
    const next = await deviceMaps.probe(c);
    const ready = next.kind === "saved" || next.kind === "unsaved" ? await deviceImuReady(c) : false;
    if (my !== seq) return;
    state = next;
    imu = ready;
    render();
  }

  function run(label: string, fn: (progress: (frac: number) => void) => Promise<void>): void {
    if (busy) return;
    busy = { label, frac: 0 };
    render();
    const progress = (frac: number): void => {
      if (!busy) return;
      busy.frac = frac;
      const bar = el.querySelector<HTMLElement>(".devmap-progress-fill");
      if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
    };
    void fn(progress).finally(() => {
      busy = null;
      render();
    });
  }

  async function save(progress: (frac: number) => void): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    try {
      const id = await deviceMaps.save(c, (d, t) => progress(t > 0 ? d / t : 0));
      toast("Map saved to this phone");
      router.navigate(`/map/${id}`);
    } catch (e) {
      toast(`Couldn't copy the map: ${msg(e)}`, { error: true });
      void probe();
    }
  }

  async function preview(progress: (frac: number) => void): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    try {
      await deviceMaps.pull(c, (d, t) => progress(t > 0 ? d / t : 0));
      router.navigate(DEVICE_MAP_PREVIEW_ROUTE);
    } catch (e) {
      toast(`Couldn't read the map: ${msg(e)}`, { error: true });
    }
  }

  function render(): void {
    const s = state;
    el.hidden = s.kind === "hidden";
    el.dataset["state"] = s.kind;
    el.replaceChildren();
    if (s.kind === "hidden") return;

    const head = document.createElement("div");
    head.className = "devmap-eyebrow";
    head.append(icon("device"));
    const where = document.createElement("span");
    where.textContent = `On ${"info" in s ? s.info.deviceName : s.deviceName}`;
    head.append(where);
    el.append(head);

    const body = document.createElement("div");
    body.className = "devmap-body";
    const thumb = document.createElement("div");
    thumb.className = "map-thumb devmap-thumb";
    const info = document.createElement("div");
    info.className = "map-info";
    const name = document.createElement("div");
    name.className = "map-name";
    const meta = document.createElement("div");
    meta.className = "map-meta metric";
    info.append(name, meta);
    body.append(thumb, info);
    thumb.append(icon("map"));

    const actions = document.createElement("div");
    actions.className = "devmap-actions";

    switch (s.kind) {
      case "loading":
        name.textContent = "Checking the device's map…";
        meta.textContent = "Reading its size and id";
        el.append(body);
        return;
      case "none":
        name.textContent = "No map on this device yet";
        meta.textContent = "Map it with +, or send a map from your library.";
        el.append(body);
        return;
      case "unsupported":
        name.textContent = "Can't read this device's map";
        meta.textContent = "Its firmware doesn't share the stored map. Update the firmware to copy it here.";
        el.append(body);
        return;
      case "error":
        name.textContent = "Couldn't read the device's map";
        meta.textContent = s.message;
        actions.append(Button({ label: "Retry", icon: "reset", variant: "quiet", onClick: () => void probe() }));
        el.append(body, actions);
        return;
      case "saved":
        name.textContent = s.local.name;
        meta.textContent = deviceMapMeta(s.info);
        info.append(badge("Saved on this phone", "ok"));
        if (s.local.thumbnail) setThumb(thumb, s.local.thumbnail);
        actions.append(
          Button({ label: "Open", icon: "map", onClick: () => router.navigate(`/map/${s.local.id}`) }),
        );
        break;
      case "unsaved":
        name.textContent = deviceMapTitle(s.info);
        meta.textContent = deviceMapMeta(s.info);
        info.append(badge("Not on this phone", "warn"));
        if (s.bundle) void thumbFromBundle(thumb, s.bundle);
        actions.append(
          Button({ label: "Save to this phone", icon: "download", onClick: () => run("Copying the map…", save) }),
          Button({ label: "Preview", icon: "eye", variant: "quiet", onClick: () => run("Reading the map…", preview) }),
        );
        break;
    }
    if (imu) {
      actions.append(
        Button({
          label: "Calibrate IMU",
          icon: "camera",
          variant: "quiet",
          onClick: () => run("Copying the map…", (p) => calibrateFromDevice((r) => router.navigate(r), p)),
        }),
      );
    }
    if (busy) {
      const prog = document.createElement("div");
      prog.className = "devmap-progress";
      const label = document.createElement("span");
      label.className = "metric";
      label.textContent = busy.label;
      const track = document.createElement("div");
      track.className = "devmap-progress-track";
      const fill = document.createElement("div");
      fill.className = "devmap-progress-fill";
      fill.style.width = `${Math.round(busy.frac * 100)}%`;
      track.append(fill);
      prog.append(label, track);
      el.append(body, prog);
      return;
    }
    el.append(body, actions);
  }

  // Re-probe when the connection changes (another device, a reconnect), not on
  // every status-text tick; re-match against the library when it changes.
  const unsubState = appState.subscribe(() => {
    const k = currentKey();
    if (k === connKey) return;
    connKey = k;
    void probe();
  });
  const unsubStore = mapStore.subscribe(() => {
    if (!busy && (state.kind === "saved" || state.kind === "unsaved")) void relink();
  });

  // The library changed (a save, delete, rename, thumbnail): re-match the
  // device's map against it without asking the device again.
  async function relink(): Promise<void> {
    const s = state;
    if (s.kind !== "saved" && s.kind !== "unsaved") return;
    const my = ++seq;
    const local = s.info.mapId ? await library.findByMapId(s.info.mapId) : undefined;
    if (my !== seq) return;
    if (local) state = { kind: "saved", info: s.info, local };
    else if (s.kind === "saved") state = { kind: "unsaved", info: s.info };
    else return;
    render();
  }

  return {
    el,
    refresh: () => {
      connKey = currentKey();
      void probe();
    },
    dispose: () => {
      seq++;
      unsubState();
      unsubStore();
    },
  };
}

/** The short note shown instead of the card while paired with a bridge and not
 * connected to a fixture directly: the bridge's live channel has no map dump. */
export function BridgeMapNote(): HTMLElement | null {
  if (appState.client || !loadCreds()) return null;
  installDeviceMapCardStyles();
  const p = document.createElement("p");
  p.className = "devmap-note metric";
  p.textContent =
    "Paired with a bridge: a fixture's stored map can't be copied through the bridge yet. " +
    "Connect to the fixture directly (Device tab) to copy its map.";
  return p;
}

function badge(text: string, tone: "ok" | "warn"): HTMLElement {
  const b = document.createElement("span");
  b.className = `devmap-badge devmap-badge--${tone}`;
  b.textContent = text;
  return b;
}

function setThumb(thumb: HTMLElement, url: string): void {
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  thumb.replaceChildren(img);
}

const thumbCache = new WeakMap<MappingBundle, string>();

async function thumbFromBundle(thumb: HTMLElement, bundle: MappingBundle): Promise<void> {
  let url = thumbCache.get(bundle);
  if (url === undefined) {
    url = bundle.map ? await renderThumbnail(bundle.map, 128).catch(() => "") : "";
    thumbCache.set(bundle, url);
  }
  if (url && thumb.isConnected) setThumb(thumb, url);
}

let stylesInstalled = false;

function installDeviceMapCardStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.devmap {
  background: var(--surface);
  border: 1px solid var(--accent-quiet);
  border-radius: var(--r-card);
  padding: var(--sp-3);
  margin-bottom: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.devmap[hidden] { display: none; }
.devmap-eyebrow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--f-caption);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
}
.devmap-eyebrow svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
}
.devmap-body {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.devmap .map-meta { white-space: normal; }
.devmap-badge {
  display: inline-block;
  margin-top: var(--sp-1);
  padding: 1px var(--sp-2);
  border-radius: 999px;
  font-size: var(--f-caption);
  border: 1px solid currentColor;
}
.devmap-badge--ok { color: var(--ok); }
.devmap-badge--warn { color: var(--warn); }
.devmap-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.devmap-actions .k-btn { flex: 1 1 auto; }
.devmap-progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  color: var(--text-dim);
}
.devmap-progress-track {
  height: 4px;
  border-radius: 2px;
  background: var(--surface-2);
  overflow: hidden;
}
.devmap-progress-fill {
  height: 100%;
  width: 0;
  background: var(--accent);
  transition: width var(--motion-micro) linear;
}
.devmap-note {
  color: var(--text-dim);
  margin: 0 0 var(--sp-4);
}
`;
