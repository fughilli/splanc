/**
 * M8 — screen-space mapping for detection feedback overlays.
 *
 * (The GL point renderer that drew blobs into the WebXR layer left with the
 * M6 WebXR removal; the DOM label overlay is the surviving consumer.)
 */

/**
 * Camera-image px → view px under the aspect-fill crop used to composit the
 * camera preview (`object-fit: cover`), so overlays annotate the same
 * on-screen spot the pixel occupies. It's feedback, not measurement — a few
 * px of error is fine.
 */
export function imageToView(
  u: number,
  v: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  const scale = Math.max(viewW / imgW, viewH / imgH);
  return {
    x: (u - imgW / 2) * scale + viewW / 2,
    y: (v - imgH / 2) * scale + viewH / 2,
  };
}
