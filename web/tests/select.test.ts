/** cv/select: the capture loop's allocation-free order statistics agree with sorting. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { medianInPlace, select } from "../src/cv/select";

function sortedMedian(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

test("select / medianInPlace match a sort (duplicates, sizes 1..200)", () => {
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let n = 1; n <= 200; n++) {
    for (let rep = 0; rep < 5; rep++) {
      // Coarse values so ties are common (grid residuals often coincide).
      const xs = Array.from({ length: n }, () => Math.round((rand() - 0.5) * (rep < 2 ? 6 : 1000)) / 4);
      // == not Object.is: a sort and a select may disagree on -0 vs 0.
      assert.ok(medianInPlace(Float64Array.from(xs), n) === sortedMedian(xs), `median n=${n}`);
      const k = Math.floor(rand() * n);
      const sorted = [...xs].sort((a, b) => a - b);
      const buf = Float64Array.from(xs);
      assert.ok(select(buf, n, k) === sorted[k], `select n=${n} k=${k}`);
      for (let i = 0; i < k; i++) assert.ok(buf[i]! <= sorted[k]!, "partitioned below k");
    }
  }
  assert.equal(medianInPlace(new Float64Array(4), 0), null);
});
