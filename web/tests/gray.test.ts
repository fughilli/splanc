/** Gray-code logic vs. the Python driver's golden fixture + inverses. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import { decodeCycle, decodeGray, gray, ledLitInFrame } from "../src/code/gray";
import golden from "./golden_gray16.json";

const params: CodeParams = {
  ledCount: golden.ledCount,
  bits: golden.bits,
  encoding: "gray",
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: golden.cycleFrames,
};

test("gray matches the Python driver golden", () => {
  assert.deepEqual(
    golden.gray,
    Array.from({ length: golden.ledCount }, (_, i) => gray(i)),
  );
});

test("frame plan matches the Python driver golden, frame for frame", () => {
  for (let frame = 0; frame < golden.cycleFrames; frame++) {
    const lit = [];
    for (let id = 0; id < golden.ledCount; id++) {
      if (ledLitInFrame(id, frame, params)) lit.push(id);
    }
    assert.deepEqual(lit, golden.framePlan[frame], `frame ${frame}`);
  }
});

test("decodeGray inverts gray for all 10-bit values", () => {
  for (let i = 0; i < 1024; i++) assert.equal(decodeGray(gray(i)), i);
});

test("adjacent ids differ in exactly one gray bit", () => {
  for (let i = 0; i + 1 < 1024; i++) {
    const diff = gray(i) ^ gray(i + 1);
    assert.equal(diff & (diff - 1), 0, `ids ${i},${i + 1}`);
  }
});

test("decodeCycle round-trips every LED id through its frame plan", () => {
  for (let id = 0; id < params.ledCount; id++) {
    const frames = Array.from({ length: params.cycleFrames }, (_, k) =>
      ledLitInFrame(id, k, params),
    );
    assert.equal(decodeCycle(frames, params), id);
  }
});

test("decodeCycle rejects a broken sync delimiter and out-of-range ids", () => {
  const okFrames = Array.from({ length: params.cycleFrames }, (_, k) =>
    ledLitInFrame(3, k, params),
  );
  assert.equal(decodeCycle([...okFrames].fill(false, 0, 1), params), null); // all_on missing
  const badOff = [...okFrames];
  badOff[1] = true; // all_off frame lit
  assert.equal(decodeCycle(badOff, params), null);

  const small: CodeParams = { ...params, ledCount: 10 }; // 4 bits still, ids 10..15 invalid
  const frames15 = Array.from({ length: params.cycleFrames }, (_, k) =>
    ledLitInFrame(15, k, params),
  );
  assert.equal(decodeCycle(frames15, small), null);
});
