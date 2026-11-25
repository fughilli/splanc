/**
 * Diffuse-spot detector regression suite on REAL frames (web/tests/testdata/
 * diffuse_rope, built by tests/tools/build_diffuse_dataset.py).
 *
 * 40 frames of a 250-LED diffused rope, camera fixed, LEDs driven with
 * set_counting_pattern so every frame's lit set (and colour) is known exactly,
 * and every LED's spot centre is known from a one-LED-at-a-time scan. The frames
 * sweep LED brightness (10-100%) x camera exposure (0.15-0.65 of the capture
 * range) at mapping-like density (every 3rd LED; every 2nd for the stride-2
 * frames) and cover all six code colours, white sync included.
 *
 * Scored per frame against the lit LEDs that are DETECTABLE (known-location
 * response > 5x noise — the dataset precomputes it): a blob within 15 px (a
 * third of the adjacent-LED spacing) of a lit LED's centre matches it (greedy,
 * nearest first); unmatched blobs near a lit LED are splits; blobs near no lit
 * LED are false positives.
 *
 * Bars: the adaptive detector (cv/diffuseDetect.ts — the reference the WebGL and
 * iOS paths port) must hold its measured quality, and stay well clear of the
 * legacy top-hat prefilter, whose numbers are reported for comparison.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { adaptiveDiffuseReduce } from "../src/cv/diffuseDetect";
import {
  COLOR,
  emptyScore,
  hue4Line,
  ropeBlobs,
  scoreFrame,
  scoreLine,
  summarize,
  type RopeFrame as Frame,
  type RopeScore as Score,
  type RopeSummary,
  type RopeTruth as Truth,
} from "./diffuseRopeScore";

const REL = "tests/testdata/diffuse_rope";
const DIR = [resolve(__dirname, "..", REL), resolve(__dirname, "../..", REL), resolve("web", REL), resolve(REL)].find((p) =>
  existsSync(resolve(p, "truth.json")),
);
assert.ok(DIR, "diffuse_rope dataset in test data");
const TRUTH = JSON.parse(readFileSync(resolve(DIR, "truth.json"), "utf8")) as Truth;
const W = TRUTH.crop.w / 2;
const H = TRUTH.crop.h / 2;

function loadRgb(f: Frame): Float32Array {
  const u8 = inflateSync(readFileSync(resolve(DIR!, f.file)));
  assert.equal(u8.length, W * H * 3, f.file);
  const rgb = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) rgb[i] = u8[i]! / 255;
  return rgb;
}

/** CPU copy of the legacy diffuse prefilter (detect.ts FS with bgGain > 0): a
 * 5x5 background at ±radius detection px subtracted per channel, then the fixed
 * max-channel threshold. */
function legacyTopHat(rgb: Float32Array, gain = 1, radiusPx = 8, threshold = 0.18): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  const step = radiusPx / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        let bg = 0;
        for (let j = -2; j <= 2; j++) {
          for (let i = -2; i <= 2; i++) {
            const sx = Math.min(W - 1, Math.max(0, Math.round(x + i * step)));
            const sy = Math.min(H - 1, Math.max(0, Math.round(y + j * step)));
            bg += rgb[(sy * W + sx) * 3 + c]!;
          }
        }
        v[c] = Math.max(0, rgb[(y * W + x) * 3 + c]! - (gain * bg) / 25);
      }
      const lum = Math.max(v[0]!, v[1]!, v[2]!);
      if (lum < threshold) continue;
      const o = (y * W + x) * 4;
      out[o] = Math.round(Math.min(1, v[0]!) * 255);
      out[o + 1] = Math.round(Math.min(1, v[1]!) * 255);
      out[o + 2] = Math.round(Math.min(1, v[2]!) * 255);
      out[o + 3] = Math.round(Math.min(1, lum) * 255);
    }
  }
  return out;
}

function run(detector: (rgb: Float32Array) => Uint8Array, pick: (f: Frame) => boolean): Score {
  const s = emptyScore();
  for (const f of TRUTH.frames) {
    if (!pick(f)) continue;
    scoreFrame(TRUTH, f, ropeBlobs(TRUTH, detector(loadRgb(f))), s);
  }
  return s;
}

const adaptive = (rgb: Float32Array): Uint8Array => adaptiveDiffuseReduce(rgb, W, H).detect;
const legacy = (rgb: Float32Array): Uint8Array => legacyTopHat(rgb);

function report(name: string, r: Score): RopeSummary {
  console.log(scoreLine(name, r));
  return summarize(r);
}

test("dataset is intact: 40 frames, centres located for most LEDs, every frame has detectable truth", () => {
  assert.equal(TRUTH.frames.length, 40);
  assert.ok(TRUTH.centers.filter((c) => c !== null).length >= 150);
  for (const f of TRUTH.frames) assert.ok(f.detectable.length > 0, f.file);
});

test("adaptive diffuse detector holds its measured quality across brightness x exposure", () => {
  const all = report("adaptive/all", run(adaptive, () => true));
  const lo = report("adaptive/exposure<=0.35", run(adaptive, (f) => f.exposure <= 0.35));
  const hi = report("adaptive/exposure>=0.55", run(adaptive, (f) => f.exposure >= 0.55));
  const s2 = report("adaptive/stride2", run(adaptive, (f) => f.kind === "stride2"));
  // Bars sit just under the 2026-11-18 measurement (recall 0.672 / 0.698 /
  // 0.690 / 0.624, fp 7.5/frame, 0 splits, 1.77 px) — legacy: 0.289 recall,
  // 9.5 splits/frame, 3.3 px. Raise them when the detector improves.
  assert.ok(all.recall >= 0.65, `overall recall ${all.recall}`);
  assert.ok(lo.recall >= 0.67, `short-exposure recall ${lo.recall}`);
  assert.ok(hi.recall >= 0.66, `long-exposure recall ${hi.recall}`);
  assert.ok(s2.recall >= 0.58, `stride-2 recall ${s2.recall}`);
  assert.ok(all.splitPerFrame <= 0.1, `splits/frame ${all.splitPerFrame}`);
  assert.ok(all.fpPerFrame <= 9, `false positives/frame ${all.fpPerFrame}`);
  assert.ok(all.medErr <= 2.2, `median centre error ${all.medErr}px`);
});

test("adaptive diffuse detector finds every code colour, white sync included", () => {
  const r = run(adaptive, (f) => f.kind === "palette");
  report("adaptive/palette", r);
  for (const [k, c] of r.byColor) assert.ok(c.hit / c.n >= 0.58, `${COLOR.get(k)} recall ${c.hit / c.n}`);
});

test("adaptive blobs keep the 4-symbol palette's hues apart (4-symbol decoding)", () => {
  const r = run(adaptive, (f) => f.kind === "palette");
  const l = run(legacy, (f) => f.kind === "palette");
  console.log(`hue4 adaptive: ${hue4Line(r)}`);
  console.log(`hue4 legacy:   ${hue4Line(l)}`);
  // Magenta is the hard one (this rope reads it ~20 deg toward blue even raw).
  // Background-subtracted colour read it right 48% of the time and sank
  // 4-symbol decoding on-device; the spot-smoothed colour holds ~70% across the full sweep (88% on these frames).
  for (const [k, c] of r.hue4) {
    const bar = k === "101" ? 0.75 : 0.85;
    assert.ok(c.ok / c.n >= bar, `${COLOR.get(k)} classified right ${c.ok}/${c.n}`);
  }
});

test("adaptive beats the legacy top-hat prefilter by a wide margin", () => {
  const a = report("adaptive/all", run(adaptive, () => true));
  const l = report("legacy/all", run(legacy, () => true));
  assert.ok(a.recall >= 2 * l.recall, `adaptive ${a.recall} vs legacy ${l.recall}`);
  assert.ok(a.splitPerFrame < l.splitPerFrame, "fewer fragments than legacy");
});
