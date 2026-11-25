/**
 * Shared hardware-setup probes (D-259): the patterns the new-fixture flow (and,
 * after #602, the Hardware Setup page) paints with set_counting_pattern to check
 * an output's LED count and its wire colour order. Pure; tests in
 * tests/newFixture.test.ts.
 *
 * Both run on the counting probe, which drives its own wire order and never
 * touches the committed hardware config; committing is a separate
 * set_hardware_config nudge (one field at a time, so other settings such as
 * sensors are left alone).
 */

import type { ColorBlock } from "@ledmapper/protocol";

/** Dim white up to the last LED, which is bright green: the user nudges the count
 * until the green LED is the last one on the strip. */
export function countProbeBlocks(count: number): ColorBlock[] {
  const n = Math.max(1, Math.floor(count));
  const blocks: ColorBlock[] = [];
  if (n > 1) blocks.push({ start: 0, count: n - 1, rgb: [0.12, 0.12, 0.12] });
  blocks.push({ start: n - 1, count: 1, rgb: [0, 0.8, 0] });
  return blocks;
}

/** Three short runs at the strip start: `each` LEDs of wire byte 0, 1, 2 (sent as
 * red, green, blue through the identity order). What the strip shows is a
 * permutation of red/green/blue, and that permutation is the wire order. */
export function orderProbeBlocks(each = 3): ColorBlock[] {
  const n = Math.max(1, Math.floor(each));
  return [
    { start: 0, count: n, rgb: [1, 0, 0] },
    { start: n, count: n, rgb: [0, 1, 0] },
    { start: 2 * n, count: n, rgb: [0, 0, 1] },
  ];
}

/** A typed LED count, clamped to 0..max (max 0 = no limit known). */
export function clampLedCount(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  const v = Math.max(0, Math.floor(n));
  return max > 0 ? Math.min(v, max) : v;
}
