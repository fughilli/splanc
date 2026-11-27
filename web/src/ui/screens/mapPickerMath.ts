/**
 * The map picker's pure math (ui/screens/mapPicker.ts): Web Mercator between
 * degrees and "world pixels" at a zoom level (256 px tiles, as OpenStreetMap's
 * raster tiles), the tiles that cover a view, and typed coordinates. No DOM, so
 * it is unit-tested (web/tests/schedule.test.ts).
 */

export const TILE = 256;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 12;
/** Web Mercator's latitude limit. */
export const MAX_LAT = 85.0511;

export interface LatLon {
  lat: number;
  lon: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Degrees -> world pixels at zoom z (x east, y south; 0..256·2^z). */
export function toWorld(p: LatLon, z: number): { x: number; y: number } {
  const size = TILE * 2 ** z;
  const lat = clamp(p.lat, -MAX_LAT, MAX_LAT);
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((wrapLon(p.lon) + 180) / 360) * size,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
  };
}

/** World pixels at zoom z -> degrees (x wraps, y clamps to the map). */
export function fromWorld(x: number, y: number, z: number): LatLon {
  const size = TILE * 2 ** z;
  const yy = clamp(y, 0, size);
  const n = Math.PI - (2 * Math.PI * yy) / size;
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    lon: wrapLon((x / size) * 360 - 180),
  };
}

/** The tiles (x, y at zoom z, x wrapped) covering a w×h view centred on `c`,
 * each with its top-left offset in view pixels; `ux` is the unwrapped column (a
 * stable key while panning, distinct for a tile shown twice on a wide view). */
export function tilesFor(
  c: LatLon,
  z: number,
  w: number,
  h: number,
): { x: number; ux: number; y: number; z: number; left: number; top: number }[] {
  const n = 2 ** z;
  const cw = toWorld(c, z);
  const x0 = cw.x - w / 2;
  const y0 = cw.y - h / 2;
  const out: { x: number; ux: number; y: number; z: number; left: number; top: number }[] = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) {
      out.push({ x: ((tx % n) + n) % n, ux: tx, y: ty, z, left: tx * TILE - x0, top: ty * TILE - y0 });
    }
  }
  return out;
}

/** A typed coordinate pair: "47.37, 8.54", "47.37 N 8.54 E", "-33.9 151.2". Null when unreadable. */
export function parseLatLon(text: string): LatLon | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$/.exec(text);
  if (!m) return null;
  let lat = Number(m[1]);
  let lon = Number(m[3]);
  if (m[2] && /[Ss]/.test(m[2])) lat = -Math.abs(lat);
  if (m[4] && /[Ww]/.test(m[4])) lon = -Math.abs(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
