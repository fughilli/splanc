/** Strip-prior placements are recognised by nViews = 0 AND confidence = 0. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { countPlacement, isInferred } from "../src/geom/inferred";

test("placements need both markers (interim snapshots carry nViews 0 with confidence 1)", () => {
  assert.equal(isInferred({ nViews: 0, confidence: 0 }), true);
  assert.equal(isInferred({ nViews: 0, confidence: 1 }), false); // capture.ts interimMap
  assert.equal(isInferred({ nViews: 2, confidence: 0 }), false);
  assert.deepEqual(
    countPlacement([
      { nViews: 5, confidence: 0.9 },
      { nViews: 0, confidence: 0 },
      { nViews: 0, confidence: 0 },
    ]),
    { measured: 1, inferred: 2 },
  );
});
