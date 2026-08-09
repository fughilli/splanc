/**
 * Inline SVG icon sprite (design doc §2.4). One line set, 1.5px stroke, 24px
 * grid. Injected once into <body>, then referenced via <svg><use href="#…">.
 * No icon-font dependency — keeps the static-bundle story.
 */

export type IconName =
  | "device"
  | "map-to-device"
  | "map-from-device"
  | "effect-to-device"
  | "effect-from-device"
  | "link"
  | "link-off"
  | "camera"
  | "map"
  | "graph"
  | "gamma"
  | "play"
  | "pause"
  | "upload"
  | "download"
  | "search"
  | "tag"
  | "trash"
  | "edit"
  | "save"
  | "back"
  | "more"
  | "settings"
  | "plus"
  | "close"
  | "bluetooth"
  | "ble-search"
  | "plug"
  | "plug-off"
  | "sparkles"
  | "alert"
  | "help"
  | "arrow-up"
  | "folder"
  | "chevron"
  | "move"
  | "grid"
  | "triad"
  | "camera-path"
  | "midi"
  | "chip";

// -- shared fragments for the device-transfer glyphs (24x24, top→bottom layout:
//    content over a small device pentagon, joined by a direction arrow) --------
/** Small device pentagon at the bottom (the transfer target). */
const DEVICE_SMALL = `<path d="M12 14.5 16 17.4 14.5 22.1 9.5 22.1 8 17.4Z"/>`;
/** Folded map, compact, at the top. */
const MAP_TOP = `<path d="M6 3.6 10 3 14 3.6 18 3 18 7.4 14 8 10 7.4 6 8Z"/><path d="M10 3V7.4"/><path d="M14 3.6V8"/>`;
/** Four-point sparkle, compact, at the top. */
const SPARK_TOP = `<path d="M12 1.9 12.78 4.32 15.2 5.1 12.78 5.88 12 8.3 11.22 5.88 8.8 5.1 11.22 4.32Z"/>`;
/** Arrow pointing DOWN into the device (send). */
const ARROW_DOWN = `<path d="M12 8.6V13.9"/><path d="M9.7 11.6 12 13.9 14.3 11.6"/>`;
/** Arrow pointing UP out of the device (pull). */
const ARROW_UP = `<path d="M12 13.9V8.6"/><path d="M9.7 10.9 12 8.6 14.3 10.9"/>`;

// Each entry is the inner markup of a 24x24 <symbol> (currentColor stroke).
const PATHS: Record<IconName, string> = {
  // A "device" is a distinctive upward pentagon — the shared glyph for a player
  // everywhere in the app (tabs, status, transfer buttons).
  device: `<path d="M12 4.5 19.6 10 16.7 19 7.3 19 4.4 10Z"/>`,
  // Transfer glyphs: content (map / sparkle) over the device pentagon, with a
  // vertical arrow — pointing DOWN into the device (send) or UP out of it
  // (pull). One consistent design language for send/pull across maps + effects.
  "map-to-device": `${MAP_TOP}${ARROW_DOWN}${DEVICE_SMALL}`,
  "map-from-device": `${MAP_TOP}${ARROW_UP}${DEVICE_SMALL}`,
  "effect-to-device": `${SPARK_TOP}${ARROW_DOWN}${DEVICE_SMALL}`,
  "effect-from-device": `${SPARK_TOP}${ARROW_UP}${DEVICE_SMALL}`,
  link: `<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>`,
  "link-off": `<path d="M9 15l6-6"/><path d="M11 6l1-1a5 5 0 0 1 7 7l-1 1"/><path d="M13 18l-1 1a5 5 0 0 1-7-7l1-1"/><path d="M3 3l18 18"/>`,
  camera: `<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`,
  map: `<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>`,
  graph: `<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 17l8-9M8 18h8"/>`,
  // Gamma/exponential curve on axes (color-correction curve).
  gamma: `<path d="M5 3v16h16"/><path d="M5 19c6 0 10-3 14-14"/>`,
  play: `<path d="M8 5v14l11-7z"/>`,
  pause: `<rect x="7" y="5" width="3" height="14"/><rect x="14" y="5" width="3" height="14"/>`,
  upload: `<path d="M12 16V5"/><path d="M7 9l5-5 5 5"/><path d="M5 19h14"/>`,
  download: `<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>`,
  search: `<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>`,
  tag: `<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.2"/>`,
  trash: `<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>`,
  edit: `<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>`,
  // Floppy disk (save): notched body, bottom label, top shutter.
  save: `<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>`,
  back: `<path d="M15 5l-7 7 7 7"/>`,
  more: `<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>`,
  settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  close: `<path d="M6 6l12 12M18 6L6 18"/>`,
  bluetooth: `<path d="M7 8l10 8-5 4V4l5 4-10 8"/>`,
  // Power plug: two prongs up, the plug head, a cord down.
  plug: `<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>`,
  // Same plug with a slash through it — disconnect.
  "plug-off": `<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/><path d="M3 3l18 18"/>`,
  // Bluetooth rune (upper-left) under a magnifier — "discover over Bluetooth".
  "ble-search": `<path d="M5 5 10 9 7.5 11 7.5 3 10 5 5 9"/><circle cx="15.5" cy="15.5" r="3.5"/><path d="M18 18l3.6 3.6"/>`,
  sparkles: `<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18 15l.8 2 2 .8-2 .8L18 21l-.8-2-2-.8 2-.8z"/>`,
  alert: `<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>`,
  help: `<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a2.8 2.8 0 0 1 5.3 1.2c0 1.9-2.6 2.3-2.6 4"/><path d="M12 17.5h.01"/>`,
  "arrow-up": `<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>`,
  folder: `<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
  chevron: `<path d="M9 6l6 6-6 6"/>`,
  // Four-way move arrows (relocate a pane between regions).
  move: `<path d="M12 3v18M3 12h18"/><path d="M12 3l-2.5 2.5M12 3l2.5 2.5"/><path d="M12 21l-2.5-2.5M12 21l2.5-2.5"/><path d="M3 12l2.5-2.5M3 12l2.5 2.5"/><path d="M21 12l-2.5-2.5M21 12l2.5 2.5"/>`,
  // 3x3 reference grid (floor overlay toggle).
  grid: `<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>`,
  // World triad: three axes radiating from a common origin (XYZ guidance).
  triad: `<path d="M12 21V8"/><path d="M12 21 4 16.5"/><path d="M12 21 20 16.5"/><path d="M12 8l-1.6 1.8M12 8l1.6 1.8"/>`,
  // Camera trajectory: an arced path between two marked viewpoints.
  "camera-path": `<path d="M4.5 18C8 7 16 7 19.5 18"/><circle cx="4.5" cy="18" r="1.6"/><circle cx="19.5" cy="18" r="1.6"/>`,
  // MIDI: a DIN-5 connector — outer ring with five pins in the standard arc.
  midi: `<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="6.2" r="1"/><circle cx="6.7" cy="9.4" r="1"/><circle cx="17.3" cy="9.4" r="1"/><circle cx="8.4" cy="15.4" r="1"/><circle cx="15.6" cy="15.4" r="1"/>`,
  // Microcontroller: a chip die with pins on all four sides (flash/commission).
  chip: `<rect x="8" y="8" width="8" height="8" rx="1"/><path d="M10 8V5M14 8V5M10 19v-3M14 19v-3M8 10H5M8 14H5M19 10h-3M19 14h-3"/>`,
};

let installed = false;

/** Install the SVG sprite once (idempotent). Called by the app shell on boot. */
export function installIconSprite(): void {
  if (installed) return;
  installed = true;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  let markup = "";
  for (const [name, inner] of Object.entries(PATHS)) {
    markup +=
      `<symbol id="ic-${name}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ` +
      `stroke-linejoin="round">${inner}</symbol>`;
  }
  svg.innerHTML = markup;
  document.body.prepend(svg);
}

/** Build an <svg> that references a sprite symbol. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#ic-${name}`);
  svg.appendChild(use);
  return svg;
}
