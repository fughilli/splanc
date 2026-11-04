/**
 * Which map the effect editor previews on.
 *
 * By default, the map of the connected fixture (or of the last connected one, when
 * none is connected). A map the user picks in the editor is remembered for that
 * fixture across sessions, and wins until they pick the fixture's own map again.
 * Picks made with no fixture known are kept under NO_DEVICE.
 *
 * Kept in localStorage: { picks: {device: mapId}, device: {device: mapId} }, where
 * `device` records the library id of each fixture's own map as it is learned.
 */

const KEY = "fxedit.previewMap.v1";
/** The editor's menu value for the connected fixture's map when it isn't saved. */
export const DEVICE_MAP = "__device__";
const NO_DEVICE = "_";

interface Saved {
  picks: Record<string, string>;
  device: Record<string, string>;
}

function read(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    return { picks: { ...(v?.picks ?? {}) }, device: { ...(v?.device ?? {}) } };
  } catch {
    return { picks: {}, device: {} };
  }
}

function write(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage full or blocked: the preview just falls back to the defaults.
  }
}

/** The user's pick for this fixture (null = follow the fixture's own map). */
export function pickedMap(deviceId: string | null): string | null {
  return read().picks[deviceId ?? NO_DEVICE] ?? null;
}

/** The library id of this fixture's own map, as last learned. */
export function deviceMap(deviceId: string | null): string | null {
  return deviceId ? (read().device[deviceId] ?? null) : null;
}

/** Remember a pick; picking the fixture's own map goes back to following it. */
export function pickMap(deviceId: string | null, mapId: string): void {
  const s = read();
  const k = deviceId ?? NO_DEVICE;
  if (mapId === DEVICE_MAP || (deviceId && s.device[deviceId] === mapId)) delete s.picks[k];
  else s.picks[k] = mapId;
  write(s);
}

/** Record which library map is this fixture's own. */
export function learnDeviceMap(deviceId: string, mapId: string): void {
  const s = read();
  if (s.device[deviceId] === mapId) return;
  s.device[deviceId] = mapId;
  write(s);
}

/** What to preview: the pick, else the fixture's map, else `fallback`; ids not in
 * `available` are skipped (a deleted map). */
export function initialPreviewMap(
  deviceId: string | null,
  available: ReadonlySet<string>,
  fallback: string | null,
): string | null {
  const pick = pickedMap(deviceId);
  if (pick && available.has(pick)) return pick;
  const own = deviceMap(deviceId);
  if (own && available.has(own)) return own;
  return fallback;
}
