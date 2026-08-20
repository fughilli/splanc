/**
 * Diffraction backdrop (FUG-127) — a trippier stand-in for a plain
 * `backdrop-filter: blur()`. Instead of a flat blur behind a modal, this melts
 * the app content into a slowly-warping, chromatically-fringed haze: an SVG
 * `feTurbulence` → `feDisplacementMap` diffraction warp plus RGB channel offset
 * for chromatic aberration, eased in from the existing blur and gently
 * "breathing" over time. Subtle by design — kinda warpy, not seizure-inducing.
 *
 * Applied to any scrim via {@link attachDiffractionBackdrop}. Two layers of
 * graceful degradation keep it safe everywhere:
 *   - `url()` references in `backdrop-filter` aren't supported on iOS/WebKit, so
 *     the displacement filter is only *appended* where supported; the always-
 *     valid base (animated blur + a whisper of hue-rotate/saturate — a chromatic
 *     shimmer that renders on every engine) carries the effect otherwise.
 *   - `prefers-reduced-motion` collapses to a static blur, no animation loop.
 */

const FILTER_ID = "acid-diffraction";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Handle returned by {@link attachDiffractionBackdrop}; call to stop + reset. */
export type DiffractionHandle = { detach: () => void };

let supportsUrlBackdrop: boolean | null = null;

/**
 * Whether the engine honours an `url(#…)` SVG filter inside `backdrop-filter`.
 * Chromium: yes; WebKit/iOS: no (parsing an unsupported function invalidates the
 * whole declaration, so we must feature-detect rather than let it drop the blur).
 */
function urlBackdropSupported(): boolean {
  if (supportsUrlBackdrop !== null) return supportsUrlBackdrop;
  try {
    supportsUrlBackdrop =
      CSS.supports("backdrop-filter", `blur(2px) url("#${FILTER_ID}")`) ||
      CSS.supports("-webkit-backdrop-filter", `blur(2px) url("#${FILTER_ID}")`);
  } catch {
    supportsUrlBackdrop = false;
  }
  return supportsUrlBackdrop;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

interface FilterNodes {
  noiseShift: SVGFEOffsetElement;
  displace: SVGFEDisplacementMapElement;
  offsetR: SVGFEOffsetElement;
  offsetB: SVGFEOffsetElement;
}

let filterNodes: FilterNodes | null = null;

/**
 * Inject the SVG diffraction filter once (idempotent). The filter runs on the
 * backdrop image: warp it by fractal noise, then split R/B and shove them apart
 * for a chromatic-aberration fringe, recombining by `screen`.
 */
function ensureFilter(): FilterNodes {
  if (filterNodes) return filterNodes;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  // Zero-footprint host: it exists only to carry the <filter> definition.
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none;";

  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", FILTER_ID);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  // Roomy region so the displacement doesn't clip at the edges of the backdrop.
  filter.setAttribute("x", "-15%");
  filter.setAttribute("y", "-15%");
  filter.setAttribute("width", "130%");
  filter.setAttribute("height", "130%");

  const turbulence = document.createElementNS(SVG_NS, "feTurbulence");
  turbulence.setAttribute("type", "fractalNoise");
  turbulence.setAttribute("baseFrequency", "0.010 0.014");
  turbulence.setAttribute("numOctaves", "2");
  turbulence.setAttribute("seed", "7");
  turbulence.setAttribute("stitchTiles", "stitch");
  turbulence.setAttribute("result", "noise");

  // The noise is computed ONCE (static baseFrequency). To keep the warp morphing
  // without re-running feTurbulence every frame (a full fractal-noise recompute —
  // the source of the stutter), we slide this cached noise with a cheap feOffset
  // raster translate and feed the displacement map the shifted copy.
  const noiseShift = document.createElementNS(SVG_NS, "feOffset");
  noiseShift.setAttribute("in", "noise");
  noiseShift.setAttribute("dx", "0");
  noiseShift.setAttribute("dy", "0");
  noiseShift.setAttribute("result", "noiseShift");

  const displace = document.createElementNS(SVG_NS, "feDisplacementMap");
  displace.setAttribute("in", "SourceGraphic");
  displace.setAttribute("in2", "noiseShift");
  displace.setAttribute("scale", "0");
  displace.setAttribute("xChannelSelector", "R");
  displace.setAttribute("yChannelSelector", "G");
  displace.setAttribute("result", "warp");

  // Chromatic aberration: isolate each channel, nudge R and B apart, screen back
  // together. Green stays put so text/edges keep a stable spine.
  const matR = channelMatrix("R");
  matR.setAttribute("in", "warp");
  matR.setAttribute("result", "rRaw");
  const matG = channelMatrix("G");
  matG.setAttribute("in", "warp");
  matG.setAttribute("result", "gChan");
  const matB = channelMatrix("B");
  matB.setAttribute("in", "warp");
  matB.setAttribute("result", "bRaw");

  const offsetR = document.createElementNS(SVG_NS, "feOffset");
  offsetR.setAttribute("in", "rRaw");
  offsetR.setAttribute("dx", "0");
  offsetR.setAttribute("dy", "0");
  offsetR.setAttribute("result", "rChan");

  const offsetB = document.createElementNS(SVG_NS, "feOffset");
  offsetB.setAttribute("in", "bRaw");
  offsetB.setAttribute("dx", "0");
  offsetB.setAttribute("dy", "0");
  offsetB.setAttribute("result", "bChan");

  const blendRG = document.createElementNS(SVG_NS, "feBlend");
  blendRG.setAttribute("in", "rChan");
  blendRG.setAttribute("in2", "gChan");
  blendRG.setAttribute("mode", "screen");
  blendRG.setAttribute("result", "rg");

  const blendRGB = document.createElementNS(SVG_NS, "feBlend");
  blendRGB.setAttribute("in", "rg");
  blendRGB.setAttribute("in2", "bChan");
  blendRGB.setAttribute("mode", "screen");

  filter.append(
    turbulence,
    noiseShift,
    displace,
    matR,
    matG,
    matB,
    offsetR,
    offsetB,
    blendRG,
    blendRGB,
  );
  svg.append(filter);
  document.body.append(svg);

  filterNodes = { noiseShift, displace, offsetR, offsetB };
  return filterNodes;
}

/** feColorMatrix that keeps a single channel (+ alpha) and zeroes the rest. */
function channelMatrix(channel: "R" | "G" | "B"): SVGFEColorMatrixElement {
  const m = document.createElementNS(SVG_NS, "feColorMatrix");
  m.setAttribute("type", "matrix");
  const r = channel === "R" ? "1" : "0";
  const g = channel === "G" ? "1" : "0";
  const b = channel === "B" ? "1" : "0";
  // rows: R', G', B', A' — pass alpha straight through so the fringe composites.
  m.setAttribute(
    "values",
    `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`,
  );
  return m;
}

// Effect shape — tuned to read as "warpy and trippy" without being dramatic.
const BASE_BLUR = 1.5; // px, the constant floor of the peak blur (kept low so the
// warp displacement stays perceptible — too much blur smears it out)
// Peak alpha of the dark scrim shade. Ramped with `amp` (not left to CSS) so the
// shade eases in from zero alongside the blur — nothing pops. MUST match the
// plain `.k-confirm-scrim` background alpha in tokens.css.
const SHADE_ALPHA = 0.45;
const WARP_SCALE = 16; // px, peak displacement amplitude
const CHROMA = 2.6; // px, peak R/B channel separation
const HUE_SWING = 14; // deg, subtle chromatic shimmer (fallback + accent)
const RAMP_MS = 750; // ease-in duration for "interpolate into" the effect

/**
 * Attach the diffraction warp to `scrim`, easing in from a plain blur and
 * animating until {@link DiffractionHandle.detach} is called (or reduced motion
 * / no window, in which case a static blur is set and no loop starts).
 */
export function attachDiffractionBackdrop(scrim: HTMLElement): DiffractionHandle {
  const reduce = prefersReducedMotion();
  const useUrl = !reduce && urlBackdropSupported();
  const nodes = useUrl ? ensureFilter() : null;

  if (reduce || typeof requestAnimationFrame !== "function") {
    const filter = `blur(${BASE_BLUR + 3}px) saturate(1.15)`;
    scrim.style.backdropFilter = filter;
    scrim.style.setProperty("-webkit-backdrop-filter", filter);
    scrim.style.backgroundColor = `rgba(0, 0, 0, ${SHADE_ALPHA})`;
    return { detach: () => {} };
  }

  let raf = 0;
  let start = -1;
  let stopped = false;

  const frame = (t: number): void => {
    if (stopped) return;
    if (start < 0) start = t;
    const elapsed = t - start;
    // Ease the amplitude in with smoothstep (ease-in-out) so the warp starts
    // gently and melts up from the blur. A cubic ease-out front-loads the ramp
    // (fastest slope at p=0), which reads as "instant" even over a long RAMP_MS;
    // smoothstep has zero slope at both ends, so the onset is actually gradual.
    const p = Math.min(1, elapsed / RAMP_MS);
    const amp = p * p * (3 - 2 * p);
    // Slow, out-of-phase oscillators drive the warp's motion (noise slide +
    // displacement pulse). Frequencies bumped ~20% for a slightly faster morph.
    const sec = elapsed / 1000;
    const slow = Math.sin(sec * 0.66);
    const slower = Math.sin(sec * 0.372 + 1.3);

    // Ramp the WHOLE blur with amp so it eases up from zero (no frame-1 flick),
    // then holds CONSTANT once settled — deliberately NOT tied to the oscillators,
    // so only the warp moves; the blur level doesn't breathe up and down.
    const blur = amp * (BASE_BLUR + 1.0);
    const hue = amp * HUE_SWING * slower;
    const sat = 1 + amp * (0.18 + 0.06 * slow);

    if (nodes) {
      const scale = amp * WARP_SCALE * (0.85 + 0.15 * slow);
      const chroma = amp * CHROMA * (0.8 + 0.2 * slower);
      // Morph the warp by sliding the cached noise (bounded within the padded
      // filter region) — cheap raster translate, no feTurbulence recompute.
      nodes.noiseShift.setAttribute("dx", (14 * slow).toFixed(2));
      nodes.noiseShift.setAttribute("dy", (14 * slower).toFixed(2));
      nodes.displace.setAttribute("scale", scale.toFixed(2));
      nodes.offsetR.setAttribute("dx", chroma.toFixed(2));
      nodes.offsetR.setAttribute("dy", (chroma * 0.35).toFixed(2));
      nodes.offsetB.setAttribute("dx", (-chroma).toFixed(2));
      nodes.offsetB.setAttribute("dy", (-chroma * 0.35).toFixed(2));
    }

    const base = `blur(${blur.toFixed(2)}px) hue-rotate(${hue.toFixed(2)}deg) saturate(${sat.toFixed(3)})`;
    const filter = nodes ? `${base} url("#${FILTER_ID}")` : base;
    scrim.style.backdropFilter = filter;
    scrim.style.setProperty("-webkit-backdrop-filter", filter);
    // Ease the dark shade in on the same amp curve as the blur — no CSS-driven pop.
    scrim.style.backgroundColor = `rgba(0, 0, 0, ${(amp * SHADE_ALPHA).toFixed(3)})`;

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    detach: () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
