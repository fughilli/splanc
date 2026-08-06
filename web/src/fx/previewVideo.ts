/**
 * Render an effect to a looping 64×64 preview clip (FUG-80). The effect runs on
 * a 64×64 grid of LEDs laid out in the XY plane — one LED per pixel — using the
 * EXACT firmware VM already in the browser (FxPreview / compileScript), so the
 * tile matches the hardware. 30 s at 60 fps is encoded to a .webm Blob.
 *
 * The grid feeds `led.uv` directly: shade_all() normalizes the XY positions to
 * 0..1, so a regular unit-square grid makes uv the pixel coordinate. There is no
 * topology on a synthetic grid, so `led.seg`/`led.dist` are default — pos/uv/time
 * effects animate fully; topology-only effects (flood/pulse) render flat, which
 * is inherent to projecting onto a flat texture.
 */

import { compileScript, FxPreview } from "./preview";
import { encodeWebmVideo } from "./videoEncode";

export const PREVIEW_SIZE = 64;
export const PREVIEW_FPS = 60;
export const PREVIEW_DURATION_S = 30;
const PREVIEW_FRAMES = PREVIEW_FPS * PREVIEW_DURATION_S;

/**
 * Flat xyz positions (3*size*size) for a `size`×`size` grid in the XY plane,
 * row-major (index = row*size + col, matching RGBA image rows), each axis spread
 * evenly across 0..1 with z=0. Pure — unit-tested.
 */
export function buildGridPositions(size: number): Float32Array {
  const out = new Float32Array(size * size * 3);
  const denom = size > 1 ? size - 1 : 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      out[i] = x / denom;
      out[i + 1] = y / denom;
      out[i + 2] = 0;
    }
  }
  return out;
}

/** Expand flat RGB (3*N) to tightly-packed RGBA (4*N) with opaque alpha. */
export function rgbToRgba(rgb: Uint8Array, out: Uint8Array): void {
  const n = rgb.length / 3;
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3]!;
    out[i * 4 + 1] = rgb[i * 3 + 1]!;
    out[i * 4 + 2] = rgb[i * 3 + 2]!;
    out[i * 4 + 3] = 255;
  }
}

/**
 * Compile + run an effect over the grid and encode a looping preview .webm.
 * Returns null when the source doesn't compile (nothing worth previewing).
 * `onProgress` (0..1) is called occasionally so callers can yield / show state.
 */
export async function renderEffectPreview(
  source: string,
  onProgress?: (frac: number) => void,
): Promise<Blob | null> {
  const compiled = await compileScript(source);
  if (!compiled.ok) return null;

  const preview = await FxPreview.create(compiled.bytecode);
  try {
    for (const u of compiled.uniforms) preview.setUniform(u.slot, u.default);

    const positions = buildGridPositions(PREVIEW_SIZE);
    const ledCount = PREVIEW_SIZE * PREVIEW_SIZE;
    const rgba = new Uint8Array(ledCount * 4);
    const dt = 1 / PREVIEW_FPS;

    const blob = await encodeWebmVideo({
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      fps: PREVIEW_FPS,
      frameCount: PREVIEW_FRAMES,
      frame: (i) => {
        const time = i * dt;
        preview.tick(time, dt, i, ledCount);
        const rgb = preview.shadeAll(positions);
        rgbToRgba(rgb, rgba);
        return rgba;
      },
      onProgress: async (i) => {
        onProgress?.(i / PREVIEW_FRAMES);
        // Yield a macrotask so scrolling stays responsive during the render.
        await new Promise((r) => setTimeout(r, 0));
      },
    });
    return blob;
  } finally {
    preview.dispose();
  }
}
