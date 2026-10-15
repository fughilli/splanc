/** FUG-112 — provenance + variance encoding of the registered overlay. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { markerStyle, PROVENANCE_STYLE, sigmaRadiusPx } from "../src/ui/overlayStyle";
import { formatSigma } from "../src/ui/projectionOverlay";

test("provenance is coded by BOTH hue and shape (colorblind-safe)", () => {
  const kinds = ["base", "scan", "updated"] as const;
  const colors = new Set(kinds.map((k) => PROVENANCE_STYLE[k].color));
  const shapes = new Set(kinds.map((k) => PROVENANCE_STYLE[k].shape));
  assert.equal(colors.size, 3);
  assert.equal(shapes.size, 3);
  // Okabe–Ito: sky blue / orange / reddish purple.
  assert.equal(PROVENANCE_STYLE.base.color, "#56B4E9");
  assert.equal(PROVENANCE_STYLE.scan.color, "#E69F00");
  assert.equal(PROVENANCE_STYLE.updated.color, "#CC79A7");
});

test("variance is coded by fill, independent of provenance", () => {
  const pitch = 0.05;
  for (const p of ["base", "scan", "updated"] as const) {
    assert.equal(markerStyle(p, 0.002, pitch).fill, "solid");
    assert.equal(markerStyle(p, 0.02, pitch).fill, "half");
    assert.equal(markerStyle(p, 0.2, pitch).fill, "hollow");
    // Provenance channel unaffected by σ.
    assert.equal(markerStyle(p, 0.2, pitch).color, PROVENANCE_STYLE[p].color);
    assert.equal(markerStyle(p, 0.2, pitch).shape, PROVENANCE_STYLE[p].shape);
  }
  // Tighter LEDs get the more prominent mark.
  assert.ok(markerStyle("scan", 0.002, pitch).sizePx > markerStyle("scan", 0.2, pitch).sizePx);
});

test("1-σ ring radius is σ projected through the pinhole", () => {
  assert.equal(sigmaRadiusPx(0.01, 2, 1000), 5);
  assert.equal(sigmaRadiusPx(0.01, 0, 1000), Infinity);
});

test("σ labels are compact", () => {
  assert.equal(formatSigma(0.0042), "4.2mm");
  assert.equal(formatSigma(0.042), "42mm");
  assert.equal(formatSigma(0.42), "42cm");
  assert.equal(formatSigma(Infinity), "∞");
});
