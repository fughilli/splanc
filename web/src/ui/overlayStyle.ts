/**
 * FUG-112 — how the registered 3D overlay encodes each LED.
 *
 * Two independent channels, each redundantly coded so neither relies on hue
 * discrimination alone (colorblind-safe):
 *
 *   PROVENANCE → hue AND marker shape (Okabe–Ito palette, distinguishable under
 *   deuteranopia/protanopia/tritanopia):
 *     base map  — sky blue  #56B4E9, circle
 *     this scan — orange    #E69F00, diamond
 *     re-solved — reddish purple #CC79A7, square   (a low-confidence base LED
 *                 the supplemental evidence gave a new position)
 *
 *   VARIANCE → fill AND a 1-σ ring (geom/ledVariance):
 *     tight    — solid fill
 *     moderate — half-transparent fill + outline
 *     loose    — hollow outline, dashed
 *   plus a thin ring at the LED's 1-σ radius projected into the image (drawn
 *   when it is larger than the marker), so the uncertainty reads at its true
 *   on-screen size. Tiers are relative to the LED pitch (varianceTier).
 */

import type { Provenance } from "../geom/fuseMaps";
import { varianceTier, type VarianceTier } from "../geom/ledVariance";

export type MarkerShape = "circle" | "diamond" | "square";

export interface ProvenanceStyle {
  color: string;
  shape: MarkerShape;
  label: string;
}

export const PROVENANCE_STYLE: Record<Provenance, ProvenanceStyle> = {
  base: { color: "#56B4E9", shape: "circle", label: "Base map" },
  scan: { color: "#E69F00", shape: "diamond", label: "This scan" },
  updated: { color: "#CC79A7", shape: "square", label: "Re-solved" },
};

export type FillStyle = "solid" | "half" | "hollow";

export const TIER_FILL: Record<VarianceTier, FillStyle> = {
  tight: "solid",
  moderate: "half",
  loose: "hollow",
};

export const TIER_LABEL: Record<VarianceTier, string> = {
  tight: "σ < ¼ pitch",
  moderate: "σ < ¾ pitch",
  loose: "σ ≥ ¾ pitch",
};

export interface MarkerStyle {
  color: string;
  shape: MarkerShape;
  fill: FillStyle;
  tier: VarianceTier;
  /** Marker half-size in CSS px (before devicePixelRatio). */
  sizePx: number;
}

/** The full marker style for one LED. Pure — unit-tested. */
export function markerStyle(provenance: Provenance, sigmaM: number, spacingM: number | null): MarkerStyle {
  const p = PROVENANCE_STYLE[provenance];
  const tier = varianceTier(sigmaM, spacingM);
  return {
    color: p.color,
    shape: p.shape,
    fill: TIER_FILL[tier],
    tier,
    // A confident LED gets a slightly bigger, more prominent mark.
    sizePx: tier === "tight" ? 5 : tier === "moderate" ? 4.5 : 4,
  };
}

/** Projected 1-σ ring radius in image pixels at `depth` meters (pinhole). */
export function sigmaRadiusPx(sigmaM: number, depthM: number, focalPx: number): number {
  if (!(depthM > 0) || !Number.isFinite(sigmaM)) return Infinity;
  return (sigmaM * focalPx) / depthM;
}

/** Trace a marker path centred at (x,y) with half-size r. */
export function traceMarker(ctx: CanvasRenderingContext2D, shape: MarkerShape, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (shape === "diamond") {
    const d = r * 1.25;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
  } else {
    const s = r * 0.9;
    ctx.rect(x - s, y - s, 2 * s, 2 * s);
  }
}

/** Draw a styled marker (fill + outline per variance tier). */
export function drawMarker(
  ctx: CanvasRenderingContext2D,
  st: MarkerStyle,
  x: number,
  y: number,
  dpr: number,
): void {
  const r = st.sizePx * dpr;
  traceMarker(ctx, st.shape, x, y, r);
  if (st.fill !== "hollow") {
    ctx.globalAlpha = st.fill === "solid" ? 0.95 : 0.4;
    ctx.fillStyle = st.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Dark halo first so the mark reads on any background, then the colour.
  ctx.setLineDash(st.fill === "hollow" ? [2.5 * dpr, 2 * dpr] : []);
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = "rgb(0 0 0 / 0.55)";
  ctx.stroke();
  ctx.lineWidth = 1.6 * dpr;
  ctx.strokeStyle = st.color;
  ctx.stroke();
  ctx.setLineDash([]);
}

const SVG_NS = "http://www.w3.org/2000/svg";

function swatch(shape: MarkerShape, color: string, fill: FillStyle): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "-7 -7 14 14");
  svg.setAttribute("aria-hidden", "true");
  const el =
    shape === "circle"
      ? document.createElementNS(SVG_NS, "circle")
      : shape === "diamond"
        ? document.createElementNS(SVG_NS, "polygon")
        : document.createElementNS(SVG_NS, "rect");
  if (shape === "circle") {
    el.setAttribute("r", "4.5");
  } else if (shape === "diamond") {
    el.setAttribute("points", "0,-5.5 5.5,0 0,5.5 -5.5,0");
  } else {
    el.setAttribute("x", "-4");
    el.setAttribute("y", "-4");
    el.setAttribute("width", "8");
    el.setAttribute("height", "8");
  }
  el.setAttribute("fill", fill === "hollow" ? "none" : color);
  el.setAttribute("fill-opacity", fill === "solid" ? "0.95" : "0.4");
  el.setAttribute("stroke", color);
  el.setAttribute("stroke-width", "1.6");
  if (fill === "hollow") el.setAttribute("stroke-dasharray", "2.5 2");
  svg.append(el);
  return svg;
}

/** The overlay legend: provenance (hue+shape) and variance (fill) keys. Only
 * the provenances that can occur are listed (a first-time capture has no base
 * map). */
export function overlayLegend(provenances: readonly Provenance[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "capture-legend";
  const row = (svg: SVGSVGElement, text: string): HTMLElement => {
    const item = document.createElement("span");
    item.className = "capture-legend-item";
    const t = document.createElement("span");
    t.textContent = text;
    item.append(svg, t);
    return item;
  };
  const prov = document.createElement("div");
  prov.className = "capture-legend-row";
  for (const p of provenances) {
    const s = PROVENANCE_STYLE[p];
    prov.append(row(swatch(s.shape, s.color, "solid"), s.label));
  }
  const vari = document.createElement("div");
  vari.className = "capture-legend-row";
  const grey = "#d0d0d8";
  for (const tier of ["tight", "moderate", "loose"] as const) {
    vari.append(row(swatch("circle", grey, TIER_FILL[tier]), TIER_LABEL[tier]));
  }
  const ring = document.createElement("span");
  ring.className = "capture-legend-item capture-legend-note";
  ring.textContent = "ring = 1σ";
  vari.append(ring);
  root.append(prov, vari);
  return root;
}
