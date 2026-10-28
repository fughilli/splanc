/**
 * Signed / ranged vector and mat3/mat4 uniforms in the app: per-component range
 * validation, the ≤4-float wire chunking (encoder + live-control channel) and
 * reassembly of the device's chunked current values, and the uniform panel's
 * controls (a ranged vector = one slider per component, never a colour picker;
 * a matrix = an N×N number grid shown row by row over column-major storage).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, fire, installFakeDom, typeInto, type FakeElement } from "./fakeDom";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import { clampUniformValue, componentRanges, isRangedVector, matIndex, matrixDim } from "../src/effects/uniformValues";
import type { FxUniform } from "../src/fx/preview";
import { LiveControl, type LiveHost } from "../src/net/liveControl";
import { decodeClient, encodeClient } from "../src/net/proto";
import { chunkUniformValues, reassembleUniformValues } from "../src/net/uniformWire";

installFakeDom();

const IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const PLANE: FxUniform = {
  name: "plane",
  slot: 0,
  width: 4,
  ui: { kind: "slider", min: -5, max: 5, step: 0.01 },
  default: [0, 1, 0, 0],
  min: -5,
  max: 5,
};
const P: FxUniform = {
  name: "p",
  slot: 4,
  width: 3,
  ui: { kind: "slider", min: -1, max: 2, step: 0.01 },
  default: [0, 0, 0],
  min: -1,
  max: 2,
  mins: [-1, -1, 0],
  maxs: [1, 1, 2],
};
const POSE: FxUniform = {
  name: "pose",
  slot: 7,
  width: 16,
  ui: { kind: "matrix", min: -10, max: 10 },
  default: IDENT4,
  min: -10,
  max: 10,
};
const TINT: FxUniform = { name: "tint", slot: 23, width: 3, ui: { kind: "color" }, default: [1, 0.5, 0] };

test("component ranges: signed, per component; clamping uses them", () => {
  assert.deepEqual(componentRanges(PLANE), Array(4).fill({ min: -5, max: 5 }));
  assert.deepEqual(componentRanges(P)![2], { min: 0, max: 2 });
  assert.deepEqual(clampUniformValue(P, [-3, 0.5, -1]), [-1, 0.5, 0]);
  assert.deepEqual(clampUniformValue(POSE, IDENT4.map((x, i) => (i === 12 ? 99 : x))).at(12), 10);
  assert.deepEqual(componentRanges(TINT), Array(3).fill({ min: 0, max: 1 }), "unranged vec3 stays a 0..1 colour");
  assert.equal(isRangedVector(PLANE), true);
  assert.equal(isRangedVector(TINT), false);
  assert.equal(matrixDim(POSE), 4);
  assert.equal(matrixDim({ width: 9, ui: { kind: "matrix" } }), 3);
  assert.equal(matIndex(1, 3, 4), 13, "row 1, column 3 of a column-major mat4");
});

test("wire: >4 floats split into consecutive slot chunks; reassembly by slot range", () => {
  const pose = IDENT4.map((x, i) => x + i);
  const chunks = chunkUniformValues([{ slot: 7, value: pose }, { slot: 0, value: [1, 2, 3, 4] }]);
  assert.deepEqual(
    chunks.map((c) => [c.slot, c.value.length]),
    [
      [7, 4],
      [11, 4],
      [15, 4],
      [19, 4],
      [0, 4],
    ],
  );
  assert.deepEqual(chunkUniformValues(chunks), chunks, "idempotent");
  const back = reassembleUniformValues([...chunks].reverse(), [PLANE, POSE, TINT]);
  assert.deepEqual(back, [
    { slot: 0, value: [1, 2, 3, 4] },
    { slot: 7, value: pose },
  ]);
  // A partial report fills the rest from the default.
  assert.deepEqual(reassembleUniformValues([{ slot: 7, value: [2, 0, 0, 0] }], [POSE])[0]!.value, [2, ...IDENT4.slice(1)]);

  // The encoder chunks set_uniforms and save_keypoint values (old firmware: ≤4).
  for (const type of ["set_uniforms", "save_keypoint"]) {
    const msg = decodeClient(encodeClient({ type, ...(type === "save_keypoint" ? { name: "k" } : {}), values: [{ slot: 7, value: pose }] } as never)) as unknown as {
      values: { slot: number; value: number[] }[];
    };
    assert.deepEqual(msg.values, chunks.slice(0, 4), type);
  }
});

test("LiveControl sends a mat4 as ≤4-float chunks, and a later whole write wins over earlier chunks", () => {
  const sent: Record<string, unknown>[] = [];
  const host: LiveHost = {
    sendFlat: (m) => (sent.push(JSON.parse(JSON.stringify(m)) as Record<string, unknown>), true),
    features: () => ["control_ack", "uniform_commit"],
    renderFps: () => 40,
    bufferedAmount: () => 0,
  };
  const q: (() => void)[] = [];
  let now = 0;
  const live = new LiveControl(host, { now: () => now, schedule: (fn) => void q.push(fn) });
  live.setUniform(7, IDENT4);
  const first = sent[0]!["values"] as { slot: number; value: number[] }[];
  assert.ok(first.every((v) => v.value.length <= 4));
  assert.deepEqual(reassembleUniformValues(first, [POSE])[0]!.value, IDENT4);
  // While that batch is in flight: chunks, then the whole matrix again.
  live.setUniforms(chunkUniformValues([{ slot: 7, value: IDENT4.map((x) => x * 5) }]));
  live.setUniform(7, IDENT4.map((x) => x * 2));
  live.onServerMessage({ type: "control_ack", seq: sent[0]!["seq"] as number });
  return new Promise<void>((r) => setImmediate(r)).then(() => {
    now = 1000; // past the rate cap
    for (let i = 0; i < 10 && q.length; i++) q.shift()!();
    const last = sent.at(-1)!["values"] as { slot: number; value: number[] }[];
    assert.deepEqual(reassembleUniformValues(last, [POSE])[0]!.value, IDENT4.map((x) => x * 2));
  });
});

function mount(uniforms: FxUniform[]): { host: FakeElement; panel: UniformPanel; changes: [number, number[]][] } {
  const host = asFake(document.createElement("div"));
  document.body.appendChild(host as unknown as HTMLElement);
  const changes: [number, number[]][] = [];
  const panel = new UniformPanel(host as unknown as HTMLElement, (slot, value) => changes.push([slot, value]));
  panel.setManifest(uniforms);
  return { host, panel, changes };
}

test("panel: a ranged vector is one signed slider per component, never a colour picker", () => {
  const { host, panel, changes } = mount([PLANE, P]);
  try {
    assert.equal(host.querySelectorAll("input[type=color]").length, 0);
    const ranges = host.querySelectorAll("input[type=range]");
    assert.equal(ranges.length, 7);
    const names = host.querySelectorAll(".upanel-name").map((n) => n.textContent);
    assert.deepEqual(names, ["plane.x", "plane.y", "plane.z", "plane.w", "p.x", "p.y", "p.z"]);
    assert.equal(ranges[0]!.min, "-5");
    assert.equal(ranges[6]!.min, "0", "p.z keeps its own range");
    assert.equal(ranges[6]!.max, "2");
    typeInto(ranges[3]!, "-4.5");
    assert.deepEqual(changes.at(-1), [0, [0, 1, 0, -4.5]], "the whole vector, one component moved");
    // A typed component is clamped to ITS range (p.x: -1..1).
    const nums = host.querySelectorAll("input.upanel-num");
    nums[4]!.value = "-3";
    fire(nums[4]!, "change");
    assert.deepEqual(changes.at(-1), [4, [-1, 0, 0]]);
    assert.deepEqual(panel.values()[0], { slot: 0, value: [0, 1, 0, -4.5] });
  } finally {
    host.remove();
  }
});

test("panel: a mat4 is a 4×4 grid, row-major on screen over column-major storage", () => {
  const { host, panel, changes } = mount([POSE, TINT]);
  try {
    const grid = host.querySelector(".upanel-mat")!;
    const cells = grid.querySelectorAll("input");
    assert.equal(cells.length, 16);
    // Screen order is row by row: cell 3 = row 0, column 3 = storage index 12.
    cells[3]!.value = "2.5";
    fire(cells[3]!, "change");
    const want = IDENT4.slice();
    want[12] = 2.5;
    assert.deepEqual(changes.at(-1), [7, want]);
    // Out of range clamps to the declared range.
    cells[7]!.value = "-50"; // row 1, column 3 = index 13
    fire(cells[7]!, "change");
    assert.equal(changes.at(-1)![1][13], -10);
    assert.equal(cells[7]!.value, "-10");
    // The device's chunked current values hydrate the whole matrix.
    const dev = IDENT4.map((x, i) => x + i / 10);
    panel.hydrate(chunkUniformValues([{ slot: 7, value: dev }]));
    assert.deepEqual(panel.values()[0], { slot: 7, value: dev });
    const after = host.querySelector(".upanel-mat")!.querySelectorAll("input");
    assert.equal(after[1]!.value, String(dev[4]), "row 0, column 1 = storage index 4");
    // The unranged vec3 is still a colour.
    assert.equal(host.querySelectorAll("input[type=color]").length, 1);
  } finally {
    host.remove();
  }
});
