/**
 * Render an effect to a looping 64×64 preview clip (FUG-80). Spatial effects run
 * one-LED-per-pixel over a flat 64×64 XY grid; TOPOLOGY-AWARE effects
 * (flood/pulse/comet/agentic — see {@link isTopologyAware}) run on a virtual tree
 * with real topology so wavefronts travel the strands and fork at junctions, then
 * rasterize into the same 64×64 frame. Both use the EXACT firmware VM already in
 * the browser (FxPreview / compileScript), so a tile matches the hardware.
 *
 * The per-frame producer built here is shared by two consumers: the offline webm
 * encoder ({@link renderEffectPreview}) and the live-canvas driver (livePreview.ts,
 * the fallback that never touches WebCodecs).
 */

import { compileScript, FxPreview, deriveLedTopology } from "./preview";
import { encodeWebmVideo } from "./videoEncode";
import { isTopologyAware } from "./effectTopology";
import { buildVirtualTree } from "./treeGeometry";
import { makeGlowKernel, rasterizeLeds } from "./rasterize";
import { PREVIEW_SIZE, PREVIEW_FPS, buildGridPositions, rgbToRgba } from "./previewGrid";

export const PREVIEW_DURATION_S = 30;
const PREVIEW_FRAMES = PREVIEW_FPS * PREVIEW_DURATION_S;

/** A per-frame RGBA producer plus the LED count it ticks the VM with. */
export interface FrameProducer {
  /** Produce frame `i` as tightly-packed RGBA (PREVIEW_SIZE² * 4), reused buffer. */
  frame: (i: number) => Uint8Array;
  ledCount: number;
}

/**
 * Wire an already-compiled {@link FxPreview} to the right render path for its
 * source: a flat XY grid for spatial effects, or a virtual tree (topology fed to
 * the VM) rasterized as glowing dots for topology-aware ones.
 */
export function makeFrameProducer(preview: FxPreview, source: string): FrameProducer {
  const dt = 1 / PREVIEW_FPS;
  if (isTopologyAware(source)) {
    const tree = buildVirtualTree({ size: PREVIEW_SIZE });
    preview.setTopology(deriveLedTopology(tree.map, tree.topology));
    const ledCount = tree.ledIds.length;
    const kernel = makeGlowKernel(1.5);
    const accum = new Float32Array(PREVIEW_SIZE * PREVIEW_SIZE * 3);
    const rgba = new Uint8Array(PREVIEW_SIZE * PREVIEW_SIZE * 4);
    return {
      ledCount,
      frame: (i) => {
        preview.tick(i * dt, dt, i, ledCount);
        rasterizeLeds(PREVIEW_SIZE, tree.coords2d, preview.shadeAll(tree.positions), kernel, accum, rgba);
        return rgba;
      },
    };
  }
  const positions = buildGridPositions(PREVIEW_SIZE);
  const ledCount = PREVIEW_SIZE * PREVIEW_SIZE;
  const rgba = new Uint8Array(ledCount * 4);
  return {
    ledCount,
    frame: (i) => {
      preview.tick(i * dt, dt, i, ledCount);
      rgbToRgba(preview.shadeAll(positions), rgba);
      return rgba;
    },
  };
}

/**
 * Compile + run an effect and encode a looping preview .webm. Returns null when
 * the source doesn't compile (nothing worth previewing). `onProgress` (0..1) is
 * called occasionally so callers can yield / show state.
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
    const producer = makeFrameProducer(preview, source);

    return await encodeWebmVideo({
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      fps: PREVIEW_FPS,
      frameCount: PREVIEW_FRAMES,
      frame: producer.frame,
      onProgress: async (i) => {
        onProgress?.(i / PREVIEW_FRAMES);
        // Yield a macrotask so scrolling stays responsive during the render.
        await new Promise((r) => setTimeout(r, 0));
      },
    });
  } finally {
    preview.dispose();
  }
}
