/**
 * MidiDecoder (src/midi/decoder.ts): per-control auto-detection of 14-bit CC
 * pairs and NRPN, with the 7-bit path unchanged (owner decision D-548).
 * Messages are fed as byte arrays with fake millisecond timestamps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MidiDecoder, PAIR_WINDOW_MS } from "../src/midi/decoder";
import { controlKey, controlLabel, parseMidiMessage, raw7 } from "../src/midi/manager";
import type { MidiControlEvent } from "../src/midi/manager";

const DEV = "Fader";

/** Feed [t, bytes] pairs; return the events produced (nulls dropped). */
function run(d: MidiDecoder, msgs: Array<[number, number[]]>): MidiControlEvent[] {
  const out: MidiControlEvent[] = [];
  for (const [t, bytes] of msgs) {
    const ev = d.decode(DEV, bytes, t);
    if (ev) out.push(ev);
  }
  return out;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

test("7-bit CC passes through exactly like parseMidiMessage", () => {
  const d = new MidiDecoder();
  const msgs: Array<[number, number[]]> = [
    [0, [0xb0, 74, 0]],
    [100, [0xb0, 74, 64]],
    [200, [0xb0, 74, 127]],
    [300, [0xb3, 10, 5]],
  ];
  const got = run(d, msgs);
  assert.deepEqual(
    got,
    msgs.map(([, b]) => parseMidiMessage(DEV, b)),
  );
});

test("notes and pitch-bend are untouched", () => {
  const d = new MidiDecoder();
  for (const b of [
    [0x90, 60, 100],
    [0x80, 60, 0],
    [0xe0, 0x00, 0x40],
  ]) {
    assert.deepEqual(d.decode(DEV, b, 0), parseMidiMessage(DEV, b));
  }
});

test("14-bit CC: MSB+LSB pair is detected and decoded as one control", () => {
  const d = new MidiDecoder();
  const got = run(d, [
    // First pair: MSB is reported 7-bit, the candidate LSB is held back.
    [0, [0xb0, 7, 64]],
    [0, [0xb0, 39, 0]],
    // Second pair confirms: the LSB emits the full 14-bit value.
    [20, [0xb0, 7, 64]],
    [20, [0xb0, 39, 1]],
    // From now on the MSB waits for its LSB, and only the pair emits.
    [40, [0xb0, 7, 127]],
    [41, [0xb0, 39, 127]],
  ]);
  // 7-bit, 7-bit (the confirming pair's MSB), then two 14-bit pair values.
  assert.equal(got.length, 4);
  assert.equal(got[0]!.bits, undefined);
  assert.equal(got[0]!.control.number, 7);
  assert.equal(got[1]!.bits, undefined);
  assert.equal(got[2]!.bits, 14);
  assert.equal(got[2]!.raw, (64 << 7) | 1);
  assert.ok(near(got[2]!.value, ((64 << 7) | 1) / 16383));
  assert.equal(raw7(got[2]!), 64);
  assert.ok(near(got[3]!.value, 1));
  // Every event is addressed to the MSB's control id (CC 7), never CC 39, so
  // a 7-bit binding learned on this knob keeps working.
  for (const e of got) {
    assert.equal(controlKey(e.control), controlKey({ device: DEV, kind: "cc", channel: 0, number: 7 }));
  }
});

test("14-bit CC: an LSB on its own updates the low bits", () => {
  const d = new MidiDecoder();
  run(d, [
    [0, [0xb0, 1, 10]],
    [0, [0xb0, 33, 0]],
    [5, [0xb0, 1, 10]],
    [5, [0xb0, 33, 0]],
  ]);
  const ev = d.decode(DEV, [0xb0, 33, 100], 50);
  assert.ok(ev);
  assert.equal(ev.raw, (10 << 7) | 100);
  assert.equal(ev.control.number, 1);
});

test("14-bit CC: an unrelated knob on CC 33..63 stays 7-bit", () => {
  const d = new MidiDecoder();
  // CC 40 moved on its own, long after CC 8: two separate 7-bit knobs.
  const got = run(d, [
    [0, [0xb0, 8, 20]],
    [500, [0xb0, 40, 90]],
    [600, [0xb0, 40, 91]],
    [700, [0xb0, 8, 21]],
  ]);
  assert.deepEqual(
    got.map((e) => [e.control.number, e.raw, e.bits]),
    [
      [8, 20, undefined],
      [40, 90, undefined],
      [40, 91, undefined],
      [8, 21, undefined],
    ],
  );
});

test("14-bit CC: LSB outside the pairing window is a separate control", () => {
  const d = new MidiDecoder();
  const got = run(d, [
    [0, [0xb0, 8, 20]],
    [PAIR_WINDOW_MS + 1, [0xb0, 40, 90]],
    [100, [0xb0, 8, 20]],
    [100 + PAIR_WINDOW_MS + 1, [0xb0, 40, 91]],
  ]);
  assert.equal(got.length, 4);
  assert.ok(got.every((e) => e.bits === undefined));
});

test("14-bit CC: falls back to 7-bit when the LSB stops arriving", () => {
  const d = new MidiDecoder();
  run(d, [
    [0, [0xb0, 2, 1]],
    [0, [0xb0, 34, 1]],
    [5, [0xb0, 2, 1]],
    [5, [0xb0, 34, 1]],
  ]);
  // MSB held for its partner...
  assert.equal(d.decode(DEV, [0xb0, 2, 50], 100), null);
  // ...a second MSB with no LSB between drops the control back to 7-bit.
  const ev = d.decode(DEV, [0xb0, 2, 51], 200);
  assert.ok(ev);
  assert.equal(ev.bits, undefined);
  assert.equal(ev.raw, 51);
  assert.equal(d.decode(DEV, [0xb0, 2, 52], 300)?.raw, 52);
});

test("14-bit CC: bank select (CC 0/32) is never paired", () => {
  const d = new MidiDecoder();
  const got = run(d, [
    [0, [0xb0, 0, 1]],
    [0, [0xb0, 32, 2]],
    [1, [0xb0, 0, 1]],
    [1, [0xb0, 32, 2]],
  ]);
  assert.deepEqual(
    got.map((e) => e.control.number),
    [0, 32, 0, 32],
  );
});

test("14-bit CC: detection is per channel and per device", () => {
  const d = new MidiDecoder();
  run(d, [
    [0, [0xb0, 3, 1]],
    [0, [0xb0, 35, 1]],
    [1, [0xb0, 3, 1]],
    [1, [0xb0, 35, 1]],
  ]);
  assert.equal(d.decode(DEV, [0xb1, 3, 9], 50)?.raw, 9); // ch 2: still 7-bit
  assert.equal(d.decode("Other", [0xb0, 3, 9], 50)?.raw, 9); // other device
  assert.equal(d.decode(DEV, [0xb0, 3, 9], 50), null); // ch 1: held as MSB
});

test("NRPN: 14-bit data entry becomes one control per parameter", () => {
  const d = new MidiDecoder();
  const got = run(d, [
    [0, [0xb0, 99, 1]],
    [0, [0xb0, 98, 2]],
    [0, [0xb0, 6, 64]],
    [0, [0xb0, 38, 32]],
  ]);
  // The selectors are not controls; CC 6 alone is 7-bit until CC 38 is seen.
  assert.equal(got.length, 2);
  const param = (1 << 7) | 2;
  assert.deepEqual(got[0]!.control, { device: DEV, kind: "nrpn", channel: 0, number: param });
  assert.equal(got[0]!.bits, undefined);
  assert.ok(near(got[0]!.value, 64 / 127));
  assert.equal(got[1]!.bits, 14);
  assert.equal(got[1]!.raw, (64 << 7) | 32);
  // Once 14-bit, the MSB waits for its LSB.
  assert.equal(d.decode(DEV, [0xb0, 6, 100], 10), null);
  assert.equal(d.decode(DEV, [0xb0, 38, 0], 10)?.raw, 100 << 7);
  assert.equal(controlLabel(got[0]!.control), `NRPN ${param} · ch 1`);
});

test("NRPN: 7-bit senders (CC 6 only) stay 7-bit", () => {
  const d = new MidiDecoder();
  const got = run(d, [
    [0, [0xb2, 99, 0]],
    [0, [0xb2, 98, 5]],
    [0, [0xb2, 6, 10]],
    [50, [0xb2, 6, 11]],
    [100, [0xb2, 98, 6]],
    [100, [0xb2, 6, 127]],
  ]);
  assert.deepEqual(
    got.map((e) => [e.control.kind, e.control.number, e.raw, e.bits]),
    [
      ["nrpn", 5, 10, undefined],
      ["nrpn", 5, 11, undefined],
      ["nrpn", 6, 127, undefined],
    ],
  );
});

test("NRPN: increment/decrement step the parameter", () => {
  const d = new MidiDecoder();
  run(d, [
    [0, [0xb0, 99, 0]],
    [0, [0xb0, 98, 1]],
    [0, [0xb0, 6, 0]],
    [0, [0xb0, 38, 10]],
  ]);
  assert.equal(d.decode(DEV, [0xb0, 96, 0], 1)?.raw, 11);
  assert.equal(d.decode(DEV, [0xb0, 97, 0], 2)?.raw, 10);
});

test("RPN data entry is swallowed; RPN null restores plain CC 6", () => {
  const d = new MidiDecoder();
  const got = run(d, [
    [0, [0xb0, 101, 0]],
    [0, [0xb0, 100, 0]],
    [0, [0xb0, 6, 12]], // pitch-bend range: not a mappable control
    [10, [0xb0, 101, 127]],
    [10, [0xb0, 100, 127]],
    [100, [0xb0, 6, 40]], // plain CC 6 again
  ]);
  assert.deepEqual(
    got.map((e) => [e.control.kind, e.control.number, e.raw]),
    [["cc", 6, 40]],
  );
});

test("CC 6 with no parameter selected is an ordinary CC", () => {
  const d = new MidiDecoder();
  assert.deepEqual(d.decode(DEV, [0xb0, 6, 33], 0), parseMidiMessage(DEV, [0xb0, 6, 33]));
});
