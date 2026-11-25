/**
 * "Choose on map": a small slippy map with a fixed centre pin, for picking the
 * lamp's location by hand (the schedule's sunrise / sunset rules) when the user
 * would rather not grant location access, or it is denied or unavailable.
 *
 * - Drag to pan; the +/− buttons (and the mouse wheel) zoom. The spot is the map's
 *   centre, shown live, rounded to 0.1° (what the lamp gets).
 * - Raster tiles from OpenStreetMap (tile.openstreetmap.org): keyless, so no API
 *   key reaches the client; attribution shown. The tiles reveal only the area
 *   being looked at; the picked spot goes only to the lamp.
 * - Offline (a lamp's own Wi-Fi has no internet): the map says so, and the
 *   coordinates field takes a typed "lat, lon" instead.
 *
 * The math is in mapPickerMath.ts.
 */

import { Field } from "../kit";
import { locationLabel, locationRequest } from "../../net/schedule";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  TILE,
  fromWorld,
  parseLatLon,
  tilesFor,
  toWorld,
  type LatLon,
} from "./mapPickerMath";

const TILE_URL = (z: number, x: number, y: number): string => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

let stylesInstalled = false;
function installMapPickerStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
.mp { display: flex; flex-direction: column; gap: var(--sp-3); }
.mp-view {
  position: relative;
  height: 320px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: #aad3df;
  touch-action: none;
  cursor: grab;
  user-select: none;
}
.mp-view:active { cursor: grabbing; }
.mp-tiles { position: absolute; inset: 0; }
.mp-tiles img { position: absolute; width: ${TILE}px; height: ${TILE}px; pointer-events: none; -webkit-user-drag: none; }
.mp-pin {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  border-radius: 50%;
  border: 3px solid #fff;
  background: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.45), 0 0 0 10px rgba(91, 124, 250, 0.25);
  pointer-events: none;
}
.mp-zoom { position: absolute; right: var(--sp-3); top: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); }
.mp-zoom button {
  width: 44px;
  height: 44px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
}
.mp-attr {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 2px 6px;
  font-size: 0.7rem;
  background: rgba(255, 255, 255, 0.8);
  color: #333;
}
.mp-attr a { color: #333; }
.mp-offline {
  position: absolute;
  left: var(--sp-3);
  right: 64px;
  top: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-ctrl);
  background: var(--surface);
  color: var(--text);
  font-size: var(--f-caption);
}
.mp-readout { font-weight: 600; font-variant-numeric: tabular-nums; }
.mp-hint { font-size: var(--f-caption); color: var(--text-dim); }
`;
  document.head.appendChild(style);
}

export interface MapPickerHandle {
  el: HTMLElement;
  /** The picked spot, rounded to 0.1° (1e-4 degree units, as set_clock_config takes it). */
  value(): { latE4: number; lonE4: number };
}

/** A map picker centred on `initial` (else a world view). */
export function MapPicker(opts: { initial?: LatLon | null; onChange?: (v: { latE4: number; lonE4: number }) => void }): MapPickerHandle {
  installMapPickerStyles();
  let center: LatLon = opts.initial ?? { lat: 30, lon: 0 };
  let zoom = opts.initial ? 8 : 2;

  const el = document.createElement("div");
  el.className = "mp";
  const view = document.createElement("div");
  view.className = "mp-view";
  view.setAttribute("role", "application");
  view.setAttribute("aria-label", "Map: drag to move the pin's spot");
  const tiles = document.createElement("div");
  tiles.className = "mp-tiles";
  const pin = document.createElement("div");
  pin.className = "mp-pin";
  const zoomBox = document.createElement("div");
  zoomBox.className = "mp-zoom";
  const zoomBtn = (label: string, aria: string, dz: number): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-label", aria);
    b.addEventListener("click", () => setZoom(zoom + dz));
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    return b;
  };
  zoomBox.append(zoomBtn("+", "Zoom in", 1), zoomBtn("−", "Zoom out", -1));
  const attr = document.createElement("div");
  attr.className = "mp-attr";
  attr.innerHTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  attr.addEventListener("pointerdown", (e) => e.stopPropagation());
  const offline = document.createElement("div");
  offline.className = "mp-offline";
  offline.textContent = "The map needs internet. Type the coordinates below instead.";
  offline.hidden = true;
  view.append(tiles, pin, zoomBox, attr, offline);

  const readout = document.createElement("div");
  readout.className = "mp-readout";
  const hint = document.createElement("div");
  hint.className = "mp-hint";
  hint.textContent = "Drag the map until the pin is on your area. The lamp gets it rounded to 0.1° (about 10 km).";
  const coords = Field({
    label: "Or type coordinates (latitude, longitude)",
    placeholder: "47.37, 8.54",
    onInput: (v) => {
      const p = parseLatLon(v);
      coords.input.setAttribute("aria-invalid", String(v.trim() !== "" && !p));
      if (p) {
        center = p;
        if (zoom < 7) zoom = 8;
        paint(false);
      }
    },
  });
  coords.input.inputMode = "decimal";
  el.append(view, readout, hint, coords.el);

  const rounded = (): { latE4: number; lonE4: number } => {
    const r = locationRequest(center.lat, center.lon);
    return { latE4: r.latE4 ?? 0, lonE4: r.lonE4 ?? 0 };
  };

  const imgs = new Map<string, HTMLImageElement>();
  let failed = 0;
  let loaded = 0;

  function paint(syncField = true): void {
    const w = view.clientWidth || 358;
    const h = view.clientHeight || 320;
    const want = tilesFor(center, zoom, w, h);
    const keep = new Set<string>();
    for (const t of want) {
      const id = `${t.z}/${t.ux}/${t.y}`;
      let img = imgs.get(id);
      if (!img) {
        img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.addEventListener("load", () => {
          loaded++;
          offline.hidden = true;
        });
        img.addEventListener("error", () => {
          failed++;
          if (loaded === 0 && failed >= 2) offline.hidden = false;
        });
        img.src = TILE_URL(t.z, t.x, t.y);
        imgs.set(id, img);
        tiles.append(img);
      }
      img.style.left = `${t.left}px`;
      img.style.top = `${t.top}px`;
      keep.add(id);
    }
    for (const [id, img] of imgs) {
      if (!keep.has(id)) {
        img.remove();
        imgs.delete(id);
      }
    }
    const v = rounded();
    readout.textContent = `Pin: ${locationLabel(v.latE4, v.lonE4)}`;
    if (syncField && document.activeElement !== coords.input) {
      coords.input.value = `${center.lat.toFixed(2)}, ${center.lon.toFixed(2)}`;
    }
    opts.onChange?.(v);
  }

  function setZoom(z: number): void {
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (nz === zoom) return;
    zoom = nz;
    paint();
  }

  // Drag to pan (pointer events: mouse and touch alike).
  let drag: { id: number; x: number; y: number; wx: number; wy: number } | null = null;
  view.addEventListener("pointerdown", (e) => {
    const w = toWorld(center, zoom);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, wx: w.x, wy: w.y };
    view.setPointerCapture?.(e.pointerId);
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    center = fromWorld(drag.wx - (e.clientX - drag.x), drag.wy - (e.clientY - drag.y), zoom);
    paint();
  });
  const end = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) drag = null;
  };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);
  view.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
    },
    { passive: false },
  );

  // Paint once laid out (the view's size), and again on resize.
  requestAnimationFrame(() => paint());
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => paint(false)).observe(view);

  return { el, value: rounded };
}
