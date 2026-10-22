/**
 * Midi Fighter Twister SysEx (src/midi/twister.ts). The expected bytes are
 * derived by hand from DJ TechTools' open-source firmware
 * (github.com/DJ-TechTools/Midi_Fighter_Twister_Open_Source @ 782f9533):
 * src/constants.h (ids), src/sysex.c (framing, identity), src/config.c
 * (commands 1/2/4, tag numbering, part sizes), src/encoders.c/.h (fields,
 * enums, partial saves). `FakeTwister` models that firmware behaviour so the
 * read-modify-write sequence is exercised without hardware. Nothing here
 * talks to a real device.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BulkAssembler,
  ENC_MIDI_TYPE,
  ENC_TAG,
  MOVEMENT,
  SWITCH_ACTION,
  TwisterSession,
  TwisterTimeout,
  decodeEncoder,
  describeChanges,
  encoderTag,
  identityRequest,
  isTwisterPortName,
  nativeModeMessage,
  parseBulkPart,
  parseGlobalReply,
  parseIdentityReply,
  planEncoderChanges,
  pullEncoderRequest,
  pullGlobalRequest,
  pushEncoderMessages,
  pushGlobalMessage,
  type SysexLink,
  type TagTable,
} from "../src/midi/twister";

const hex = (s: string): number[] => s.trim().split(/\s+/).map((h) => parseInt(h, 16));

test("request builders match the firmware's framing", () => {
  assert.deepEqual(identityRequest(), hex("F0 7E 7F 06 01 F7"));
  // config.c sysExCmdPullConfig: command 2, byte 0x00 = request.
  assert.deepEqual(pullGlobalRequest(), hex("F0 00 01 79 02 00 F7"));
  // config.c bulk-transfer comment: F0 00 01 79 04 01 TAG F7.
  assert.deepEqual(pullEncoderRequest(1), hex("F0 00 01 79 04 01 01 F7"));
  // doc/NativeMode.md: "Enter native mode | F0 000179 06 00 01 F7".
  assert.deepEqual(nativeModeMessage(true), hex("F0 00 01 79 06 00 01 F7"));
  assert.deepEqual(nativeModeMessage(false), hex("F0 00 01 79 06 00 00 F7"));
});

test("encoderTag = bank*16 + encoder + 1", () => {
  assert.equal(encoderTag(0, 0), 1);
  assert.equal(encoderTag(0, 15), 16);
  assert.equal(encoderTag(1, 0), 17);
  assert.equal(encoderTag(3, 15), 64);
  assert.throws(() => encoderTag(0, 16));
  assert.throws(() => encoderTag(7, 15), "tag 128 doesn't fit 7 bits");
});

test("bulk push: one part ≤24 payload bytes, PART/TOTAL/SIZE header", () => {
  const msgs = pushEncoderMessages(5, [
    [ENC_TAG.encoderMidiType, ENC_MIDI_TYPE.relative],
    [ENC_TAG.movement, MOVEMENT.velocity],
  ]);
  // F0 00 01 79 04 00 TAG PART TOTAL SIZE PAYLOAD F7 (tags 18=0x12, 11=0x0B).
  assert.deepEqual(msgs, [hex("F0 00 01 79 04 00 05 01 01 04 12 02 0B 02 F7")]);
  // 15 pairs = 30 bytes → 2 parts of 24 + 6, like the firmware's own reply.
  const full: TagTable = Array.from({ length: 15 }, (_, i) => [10 + i, 0] as [number, number]);
  const parts = pushEncoderMessages(1, full);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0]!.slice(6, 10), [1, 1, 2, 24]);
  assert.deepEqual(parts[1]!.slice(6, 10), [1, 2, 2, 6]);
  assert.deepEqual(pushEncoderMessages(1, []), []);
});

test("data bytes above 0x7F are refused (they'd break the SysEx stream)", () => {
  assert.throws(() => pushEncoderMessages(1, [[ENC_TAG.encoderNumber, 128]]));
  assert.throws(() => pushGlobalMessage([[31, 200]]));
});

test("identity reply parses the firmware date; others are rejected", () => {
  // sysex.c: F0 7E 7F 06 02 00 01 79 | family 05 00 | model 01 00 | 20 26 08 24 | F7
  const reply = hex("F0 7E 7F 06 02 00 01 79 05 00 01 00 20 26 08 24 F7");
  assert.deepEqual(parseIdentityReply(reply), { version: "2026-08-24" });
  assert.equal(parseIdentityReply(hex("F0 7E 7F 06 02 00 20 6B 02 00 04 00 01 00 00 00 F7")), null);
  assert.equal(parseIdentityReply(hex("F0 7E 7F 06 01 F7")), null);
});

test("global reply → tag table; push echoes every tag back", () => {
  // config.c send_config_data: 02 01 then tags 0-9, 31-38.
  const reply = hex(
    "F0 00 01 79 02 01 00 04 01 00 02 01 03 02 04 03 05 04 06 05 07 06 08 00 09 7F " +
      "1F 7F 20 7F 21 00 22 06 23 03 24 00 25 00 26 01 F7",
  );
  const t = parseGlobalReply(reply)!;
  assert.equal(t.length, 18);
  assert.deepEqual(t[0], [0, 4]);
  assert.deepEqual(t[10], [31, 127]);
  assert.deepEqual(t[17], [38, 1]);
  // Push = command 1 with the same pairs (no request/response byte).
  const push = pushGlobalMessage(t);
  assert.deepEqual(push.slice(0, 5), hex("F0 00 01 79 01"));
  assert.deepEqual(push.slice(5, -1), reply.slice(6, -1));
  assert.equal(parseGlobalReply(pullGlobalRequest()), null, "the request isn't a reply");
});

/** A factory-default encoder reply for bank 1 encoder 1, as the firmware's
 * bulk pull sends it: two parts (24 + 6 bytes), channels 1-based. */
function factoryEncoderReply(tag: number): number[][] {
  const pairs = [
    10, 0, 11, 0, 12, 0, 13, 2, 14, tag - 1, 15, 0, 16, 1, 17, tag - 1, 18, 1, 19, 127, 20, 127, 21, 63,
    22, 1, 23, 0, 24, 5,
  ];
  return [
    [0xf0, 0, 1, 0x79, 4, 0, tag, 1, 2, 24, ...pairs.slice(0, 24), 0xf7],
    [0xf0, 0, 1, 0x79, 4, 0, tag, 2, 2, 6, ...pairs.slice(24), 0xf7],
  ];
}

test("bulk reply parts reassemble and decode (0-based channels)", () => {
  const [p1, p2] = factoryEncoderReply(1);
  const a = parseBulkPart(p1!)!;
  assert.deepEqual([a.tag, a.part, a.total, a.payload.length], [1, 1, 2, 24]);
  const asm = new BulkAssembler();
  assert.equal(asm.push(a), null);
  const done = asm.push(parseBulkPart(p2!)!)!;
  assert.equal(done.table.length, 15);
  const s = decodeEncoder(done.table);
  assert.equal(s.midiType, ENC_MIDI_TYPE.cc);
  assert.equal(s.channel, 0);
  assert.equal(s.number, 0);
  assert.equal(s.switchChannel, 1);
  assert.equal(s.switchAction, SWITCH_ACTION.ccHold);
});

test("planEncoderChanges pushes only what differs", () => {
  const cur = decodeEncoder(
    (() => {
      const asm = new BulkAssembler();
      const [p1, p2] = factoryEncoderReply(1);
      asm.push(parseBulkPart(p1!)!);
      return asm.push(parseBulkPart(p2!)!)!.table;
    })(),
  );
  const plan = planEncoderChanges(cur, {
    bank: 0,
    encoder: 0,
    channel: 0,
    number: 0,
    acceleration: true,
    momentarySwitch: true,
  });
  assert.deepEqual(plan, [
    [ENC_TAG.encoderMidiType, ENC_MIDI_TYPE.relative],
    [ENC_TAG.movement, MOVEMENT.velocity],
  ]);
  assert.deepEqual(describeChanges(cur, plan), [
    "MIDI type CC → ENC 3FH/41H",
    "sensitivity Standard → Velocity sensitive",
  ]);
  const moved = planEncoderChanges(cur, {
    bank: 0,
    encoder: 0,
    channel: 3,
    number: 20,
    acceleration: false,
    momentarySwitch: false,
  });
  assert.deepEqual(moved, [
    [ENC_TAG.encoderMidiType, ENC_MIDI_TYPE.relative],
    [ENC_TAG.encoderChannel, 4], // 1-based on the wire
    [ENC_TAG.encoderNumber, 20],
  ]);
  const already = { ...cur, midiType: ENC_MIDI_TYPE.relative, movement: MOVEMENT.velocity };
  assert.deepEqual(
    planEncoderChanges(already, { bank: 0, encoder: 0, acceleration: true, momentarySwitch: true }),
    [],
  );
});

/**
 * Models the firmware's SysEx handling closely enough to check the session:
 * identity, global pull/push (push writes 0 for missing tags), bulk pull (two
 * parts) and bulk push (fields not sent are kept).
 */
class FakeTwister implements SysexLink {
  global = new Map<number, number>([
    [0, 4], [1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 0], [9, 127],
    [31, 100], [32, 90], [33, 0], [34, 6], [35, 3], [36, 2], [37, 1], [38, 1],
  ]);
  encoders = new Map<number, Map<number, number>>();
  sent: number[][] = [];
  ledsOn = true;
  silent = false;
  private listeners = new Set<(b: Uint8Array) => void>();

  constructor() {
    for (let tag = 1; tag <= 16; tag++) {
      const [p1, p2] = factoryEncoderReply(tag);
      const pl = [...p1!.slice(10, -1), ...p2!.slice(10, -1)];
      const m = new Map<number, number>();
      for (let i = 0; i < pl.length; i += 2) m.set(pl[i]!, pl[i + 1]!);
      this.encoders.set(tag, m);
    }
  }

  onSysex(fn: (b: Uint8Array) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private reply(bytes: number[]): void {
    queueMicrotask(() => {
      for (const fn of [...this.listeners]) fn(new Uint8Array(bytes));
    });
  }

  private globalReply(): number[] {
    return [0xf0, 0, 1, 0x79, 2, 1, ...[...this.global].flat(), 0xf7];
  }

  send(b: number[]): void {
    this.sent.push(b);
    if (this.silent) return;
    if (b[1] === 0x7e && b[4] === 0x01) {
      this.reply(hex("F0 7E 7F 06 02 00 01 79 05 00 01 00 20 26 08 24 F7"));
      return;
    }
    if (b[1] !== 0 || b[2] !== 1 || b[3] !== 0x79) return;
    const cmd = b[4];
    if (cmd === 2 && b[5] === 0) this.reply(this.globalReply());
    if (cmd === 1) {
      // Missing tags are written as 0 — exactly why the session echoes all.
      const next = new Map<number, number>();
      for (const [k] of this.global) next.set(k, 0);
      for (let i = 5; i + 1 < b.length - 1; i += 2) next.set(b[i]!, b[i + 1]!);
      this.global = next;
      this.ledsOn = true;
      this.reply(this.globalReply());
    }
    if (cmd === 4 && b[5] === 1) {
      const tag = b[6]!;
      const enc = this.encoders.get(tag)!;
      const pl = [...enc].flat();
      this.reply([0xf0, 0, 1, 0x79, 4, 0, tag, 1, 2, 24, ...pl.slice(0, 24), 0xf7]);
      this.reply([0xf0, 0, 1, 0x79, 4, 0, tag, 2, 2, pl.length - 24, ...pl.slice(24), 0xf7]);
    }
    if (cmd === 4 && b[5] === 0) {
      const tag = b[6]!;
      const size = b[9]!;
      const enc = this.encoders.get(tag)!;
      for (let i = 10; i < 10 + size; i += 2) enc.set(b[i]!, b[i + 1]!);
      this.ledsOn = false; // display_disable() until the next global push
    }
  }
}

const fast = { timeoutMs: 50, writeGapMs: 0, sleep: async () => {} };

test("session: identify + read global + read encoder", async () => {
  const dev = new FakeTwister();
  const s = new TwisterSession(dev, fast);
  assert.deepEqual(await s.identify(), { version: "2026-08-24" });
  const g = await s.readGlobal();
  assert.equal(g.length, 18);
  const e = await s.readEncoder(encoderTag(0, 3));
  assert.equal(e.number, 3);
  assert.equal(e.midiType, ENC_MIDI_TYPE.cc);
});

test("session: read-modify-write changes only the planned fields", async () => {
  const dev = new FakeTwister();
  const s = new TwisterSession(dev, fast);
  const global = await s.readGlobal();
  const before = new Map(dev.encoders.get(1));
  const cur = await s.readEncoder(1);
  const plan = planEncoderChanges(cur, { bank: 0, encoder: 0, acceleration: true, momentarySwitch: true });
  const res = await s.apply(new Map([[1, plan]]), global);
  assert.deepEqual(res.mismatched, []);
  const after = res.after.get(1)!;
  assert.equal(after.midiType, ENC_MIDI_TYPE.relative);
  assert.equal(after.movement, MOVEMENT.velocity);
  // Everything else on encoder 1 is untouched (colours, detent, CC, channels).
  for (const [k, v] of before) {
    if (k === ENC_TAG.encoderMidiType || k === ENC_TAG.movement) continue;
    assert.equal(dev.encoders.get(1)!.get(k), v, `tag ${k} changed`);
  }
  // Other encoders untouched; global settings (brightness etc.) survive the echo.
  assert.equal(dev.encoders.get(2)!.get(ENC_TAG.encoderMidiType), ENC_MIDI_TYPE.cc);
  assert.equal(dev.global.get(31), 100);
  assert.equal(dev.global.get(36), 2);
  assert.ok(dev.ledsOn, "the global push re-enabled the display");
  // Order: bulk push, then global push (command 1), then the verify pull.
  const cmds = dev.sent.map((m) => (m[1] === 0x7e ? "id" : `${m[4]}.${m[5]}`));
  // (the global push's 2nd byte is its first tag, 0).
  assert.deepEqual(cmds.slice(-3), ["4.0", "1.0", "4.1"]);
});

test("session: refuses an empty global push; times out on a silent device", async () => {
  const dev = new FakeTwister();
  const s = new TwisterSession(dev, fast);
  await assert.rejects(s.apply(new Map([[1, [[18, 2]]]]), []), /empty global/);
  assert.equal(dev.sent.length, 0, "nothing was sent");
  dev.silent = true;
  await assert.rejects(s.readGlobal(), TwisterTimeout);
});

test("Twister port names", () => {
  assert.ok(isTwisterPortName("Midi Fighter Twister"));
  assert.ok(isTwisterPortName("Midi Fighter Twister MIDI 1"));
  assert.ok(isTwisterPortName("MIDI FIGHTER TWISTER"));
  assert.ok(!isTwisterPortName("Midi Fighter 3D"));
});
