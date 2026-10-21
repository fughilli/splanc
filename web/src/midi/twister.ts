/**
 * DJ TechTools Midi Fighter Twister configuration over SysEx, so Splanc can
 * switch chosen encoders to relative ("ENC 3FH/41H") mode itself instead of
 * sending you to the Midi Fighter Utility.
 *
 * The protocol here was read from DJ TechTools' open-source firmware
 * (github.com/DJ-TechTools/Midi_Fighter_Twister_Open_Source, checked at
 * 782f9533, 2026-08-24). Only facts about the wire format are used; no
 * firmware code is copied. Firmware references:
 *
 *   - src/constants.h: manufacturer id 00 01 79; identity family 05 00,
 *     model 01 00, version = date bytes (e.g. 20 26 08 24).
 *   - src/sysex.c: a message is for the Twister when it starts F0 00 01 79;
 *     the next byte is the command. Universal identity request F0 7E 7F 06 01
 *     F7 is answered with F0 7E 7F 06 02 00 01 79 05 00 01 00 YY YY MM DD F7.
 *   - src/config.h: commands 1 push global config, 2 pull global config,
 *     3 system, 4 bulk transfer (per-encoder config), 5 device id,
 *     6 native mode.
 *   - src/config.c sysExCmdPullConfig/send_config_data: F0 00 01 79 02 00 F7
 *     asks for the global settings; the reply is F0 00 01 79 02 01 followed by
 *     tag/value pairs (tags 0-9 and 31-38) and F7.
 *   - src/config.c sysExCmdPushConfig: F0 00 01 79 01 <tag value>... F7
 *     writes the global settings. Tags that are missing are written as 0, so
 *     a push must send back EVERY tag the pull returned. Afterwards the
 *     firmware reloads all settings from EEPROM, re-inits the encoders,
 *     redraws the display (flashing green) and answers with the global
 *     reply again.
 *   - src/config.c sysExCmdBulkXfer: F0 00 01 79 04 01 TAG F7 asks for one
 *     encoder's settings (TAG = bank*16 + encoder + 1). The reply is one or
 *     more F0 00 01 79 04 00 TAG PART TOTAL SIZE <SIZE bytes> F7 parts (24
 *     bytes max each; 15 pairs = 30 bytes = 2 parts). A push uses the same
 *     part format. Every field not in a push keeps its stored value
 *     (src/encoders.c save_encoder_config skips values >= 0x80), so a push
 *     can carry just the fields that change. A bulk push turns the LEDs off
 *     until the next global push reloads the settings.
 *   - src/encoders.h: the encoder fields and enums (below); relative output
 *     is CC 64±n (binary offset), n > 1 only with velocity-sensitive
 *     movement (src/encoders.c process_encoder_input_rotary_relative).
 *
 * Message builders/parsers are pure (unit-tested against those bytes);
 * {@link TwisterSession} runs the read-modify-write over any {@link SysexLink}.
 * NOT yet verified against a physical Twister.
 */

export const MFR_ID = [0x00, 0x01, 0x79] as const;

export const CMD = {
  pushConfig: 0x01,
  pullConfig: 0x02,
  system: 0x03,
  bulkXfer: 0x04,
  deviceId: 0x05,
  nativeMode: 0x06,
} as const;

/** Per-encoder field tags as the firmware's bulk transfer numbers them. */
export const ENC_TAG = {
  hasDetent: 10,
  movement: 11,
  switchAction: 12,
  /** 1-based MIDI channel. */
  switchChannel: 13,
  switchNumber: 14,
  switchMidiType: 15,
  /** 1-based MIDI channel. */
  encoderChannel: 16,
  encoderNumber: 17,
  encoderMidiType: 18,
  activeColor: 19,
  inactiveColor: 20,
  detentColor: 21,
  indicatorType: 22,
  isSuperKnob: 23,
  /** 1-based MIDI channel. */
  shiftChannel: 24,
} as const;

/** Encoder `encoderMidiType` values (src/encoders.h midi_type_t). */
export const ENC_MIDI_TYPE = {
  note: 0,
  cc: 1,
  /** Relative "ENC 3FH/41H": CC 64±n. */
  relative: 2,
  switchVelocity: 3,
  mouseDrag: 4,
  mouseScroll: 5,
} as const;

/** Encoder `movement` values (src/encoders.h enc_move_type_t). */
export const MOVEMENT = { direct: 0, responsive: 1, velocity: 2 } as const;

/** Push-switch `switchAction` values (src/encoders.h enc_sw_action_type_t). */
export const SWITCH_ACTION = {
  ccHold: 0,
  ccToggle: 1,
  noteHold: 2,
  noteToggle: 3,
  resetValue: 4,
  resetValueInv: 5,
  fineAdjust: 6,
  shiftHold: 7,
  shiftToggle: 8,
} as const;

export const MIDI_TYPE_LABEL: Record<number, string> = {
  0: "Note",
  1: "CC",
  2: "ENC 3FH/41H",
  3: "CC + switch velocity",
  4: "Mouse drag",
  5: "Mouse scroll",
};

export const SWITCH_ACTION_LABEL: Record<number, string> = {
  0: "CC hold",
  1: "CC toggle",
  2: "Note hold",
  3: "Note toggle",
  4: "Reset value",
  5: "Reset value (inv)",
  6: "Fine adjust",
  7: "Shift hold",
  8: "Shift toggle",
};

export const MOVEMENT_LABEL: Record<number, string> = {
  0: "Standard",
  1: "Responsive",
  2: "Velocity sensitive",
};

/** A tag → value table, in the order the device sent it. */
export type TagTable = [tag: number, value: number][];

function assertData(bytes: readonly number[]): void {
  for (const b of bytes) {
    if (!Number.isInteger(b) || b < 0 || b > 0x7f) {
      throw new Error(`SysEx data byte out of range: ${b}`);
    }
  }
}

function twisterMessage(cmd: number, body: readonly number[]): number[] {
  assertData(body);
  return [0xf0, ...MFR_ID, cmd, ...body, 0xf7];
}

/** Bulk-transfer tag of an encoder: bank 0.., encoder 0..15. */
export function encoderTag(bank: number, encoder: number): number {
  if (!Number.isInteger(bank) || !Number.isInteger(encoder) || encoder < 0 || encoder > 15 || bank < 0) {
    throw new Error(`bad encoder ${bank}/${encoder}`);
  }
  const tag = bank * 16 + encoder + 1;
  // Tag 0 / 128 is the firmware's alias for the last encoder of bank 8; the
  // 7-bit tag tops out at 127, so bank 8 encoder 16 isn't addressable here.
  if (tag > 127) throw new Error(`encoder ${bank}/${encoder} out of range`);
  return tag;
}

/** Universal Non-Realtime identity request (any device id). */
export function identityRequest(): number[] {
  return [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
}

export function pullGlobalRequest(): number[] {
  return twisterMessage(CMD.pullConfig, [0x00]);
}

export function pushGlobalMessage(table: TagTable): number[] {
  return twisterMessage(
    CMD.pushConfig,
    table.flatMap(([t, v]) => [t, v]),
  );
}

export function pullEncoderRequest(tag: number): number[] {
  return twisterMessage(CMD.bulkXfer, [0x01, tag]);
}

/**
 * Push encoder fields as bulk-transfer parts of at most 24 payload bytes (12
 * pairs), matching the firmware's own part size.
 */
export function pushEncoderMessages(tag: number, table: TagTable): number[][] {
  const pairs = table.flatMap(([t, v]) => [t, v]);
  if (pairs.length === 0) return [];
  const total = Math.ceil(pairs.length / 24);
  const out: number[][] = [];
  for (let part = 1; part <= total; part++) {
    const payload = pairs.slice((part - 1) * 24, part * 24);
    out.push(twisterMessage(CMD.bulkXfer, [0x00, tag, part, total, payload.length, ...payload]));
  }
  return out;
}

/** Native mode (firmware 2026-08 and newer; not saved): every knob sends CC
 * 0-15 on channel 1 as 63/65, presses on channel 2 (doc/NativeMode.md). */
export function nativeModeMessage(on: boolean): number[] {
  return twisterMessage(CMD.nativeMode, [0x00, on ? 0x01 : 0x00]);
}

function isTwister(bytes: ArrayLike<number>, cmd: number): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0xf0 &&
    bytes[1] === MFR_ID[0] &&
    bytes[2] === MFR_ID[1] &&
    bytes[3] === MFR_ID[2] &&
    bytes[4] === cmd &&
    bytes[bytes.length - 1] === 0xf7
  );
}

function pairsOf(bytes: ArrayLike<number>, from: number, to: number): TagTable {
  const out: TagTable = [];
  for (let i = from; i + 1 < to; i += 2) out.push([bytes[i]!, bytes[i + 1]!]);
  return out;
}

export interface TwisterIdentity {
  /** Firmware date, e.g. "2026-08-24". */
  version: string;
}

/** Parse the identity reply; null if it isn't a Twister's. */
export function parseIdentityReply(bytes: ArrayLike<number>): TwisterIdentity | null {
  if (
    bytes.length < 17 ||
    bytes[0] !== 0xf0 ||
    bytes[1] !== 0x7e ||
    bytes[3] !== 0x06 ||
    bytes[4] !== 0x02 ||
    bytes[5] !== MFR_ID[0] ||
    bytes[6] !== MFR_ID[1] ||
    bytes[7] !== MFR_ID[2] ||
    bytes[8] !== 0x05 ||
    bytes[10] !== 0x01
  ) {
    return null;
  }
  const hex = (b: number) => b.toString(16).padStart(2, "0");
  return { version: `${hex(bytes[12]!)}${hex(bytes[13]!)}-${hex(bytes[14]!)}-${hex(bytes[15]!)}` };
}

/** Parse a global-config reply (F0 00 01 79 02 01 … F7) into its tag table. */
export function parseGlobalReply(bytes: ArrayLike<number>): TagTable | null {
  if (!isTwister(bytes, CMD.pullConfig) || bytes[5] !== 0x01) return null;
  return pairsOf(bytes, 6, bytes.length - 1);
}

export interface BulkPart {
  tag: number;
  part: number;
  total: number;
  payload: number[];
}

/** Parse one bulk-transfer push part (the device's reply to a pull). */
export function parseBulkPart(bytes: ArrayLike<number>): BulkPart | null {
  if (!isTwister(bytes, CMD.bulkXfer) || bytes[5] !== 0x00 || bytes.length < 11) return null;
  const size = bytes[9]!;
  if (10 + size > bytes.length - 1) return null;
  const payload: number[] = [];
  for (let i = 0; i < size; i++) payload.push(bytes[10 + i]!);
  return { tag: bytes[6]!, part: bytes[7]!, total: bytes[8]!, payload };
}

/** Reassembles multi-part bulk replies into per-tag tag tables. */
export class BulkAssembler {
  private readonly pending = new Map<number, number[][]>();

  /** Feed a part; returns the encoder's full table once its last part is in. */
  push(p: BulkPart): { tag: number; table: TagTable } | null {
    const parts = this.pending.get(p.tag) ?? [];
    parts[p.part - 1] = p.payload;
    this.pending.set(p.tag, parts);
    if (p.part < p.total) return null;
    this.pending.delete(p.tag);
    const flat = parts.flatMap((x) => x ?? []);
    return { tag: p.tag, table: pairsOf(flat, 0, flat.length) };
  }
}

/** One encoder's settings, decoded from its tag table. Channels are 0-based. */
export interface EncoderSettings {
  midiType: number;
  channel: number;
  number: number;
  movement: number;
  switchAction: number;
  switchChannel: number;
  switchNumber: number;
  raw: TagTable;
}

function tagValue(t: TagTable, tag: number): number | undefined {
  return t.find(([k]) => k === tag)?.[1];
}

export function decodeEncoder(table: TagTable): EncoderSettings {
  const v = (tag: number) => tagValue(table, tag) ?? 0;
  return {
    midiType: v(ENC_TAG.encoderMidiType),
    channel: Math.max(0, v(ENC_TAG.encoderChannel) - 1),
    number: v(ENC_TAG.encoderNumber),
    movement: v(ENC_TAG.movement),
    switchAction: v(ENC_TAG.switchAction),
    switchChannel: Math.max(0, v(ENC_TAG.switchChannel) - 1),
    switchNumber: v(ENC_TAG.switchNumber),
    raw: table,
  };
}

/** What one encoder should become. Channels are 0-based. */
export interface EncoderTarget {
  bank: number;
  encoder: number;
  /** Encoder CC channel/number; omitted = keep the Twister's. */
  channel?: number;
  number?: number;
  /** Velocity-sensitive movement, so a fast turn sends bigger steps. */
  acceleration: boolean;
  /** Make the push switch a momentary CC (press 127, release 0). */
  momentarySwitch: boolean;
}

/**
 * The fields to push to turn `current` into `target`: only what differs.
 * Everything else on the encoder is left as it is.
 */
export function planEncoderChanges(current: EncoderSettings, target: EncoderTarget): TagTable {
  const out: TagTable = [];
  if (current.midiType !== ENC_MIDI_TYPE.relative) out.push([ENC_TAG.encoderMidiType, ENC_MIDI_TYPE.relative]);
  if (target.channel !== undefined && target.channel !== current.channel) {
    out.push([ENC_TAG.encoderChannel, target.channel + 1]);
  }
  if (target.number !== undefined && target.number !== current.number) {
    out.push([ENC_TAG.encoderNumber, target.number]);
  }
  const movement = target.acceleration ? MOVEMENT.velocity : MOVEMENT.direct;
  if (current.movement !== movement) out.push([ENC_TAG.movement, movement]);
  if (target.momentarySwitch && current.switchAction !== SWITCH_ACTION.ccHold) {
    out.push([ENC_TAG.switchAction, SWITCH_ACTION.ccHold]);
  }
  assertData(out.flat());
  return out;
}

/** Human summary of a plan, for the confirm step. */
export function describeChanges(current: EncoderSettings, plan: TagTable): string[] {
  const was = (labels: Record<number, string>, x: number): string => (x < 0 ? "?" : (labels[x] ?? String(x)));
  return plan.map(([tag, v]) => {
    switch (tag) {
      case ENC_TAG.encoderMidiType:
        return `MIDI type ${was(MIDI_TYPE_LABEL, current.midiType)} → ${MIDI_TYPE_LABEL[v] ?? v}`;
      case ENC_TAG.encoderChannel:
        return `channel ${current.channel < 0 ? "?" : current.channel + 1} → ${v}`;
      case ENC_TAG.encoderNumber:
        return `CC ${current.number < 0 ? "?" : current.number} → ${v}`;
      case ENC_TAG.movement:
        return `sensitivity ${was(MOVEMENT_LABEL, current.movement)} → ${MOVEMENT_LABEL[v] ?? v}`;
      case ENC_TAG.switchAction:
        return `push switch ${was(SWITCH_ACTION_LABEL, current.switchAction)} → ${SWITCH_ACTION_LABEL[v] ?? v}`;
      default:
        return `tag ${tag} → ${v}`;
    }
  });
}

/** A two-way SysEx pipe to the device (Web MIDI in the app, a fake in tests). */
export interface SysexLink {
  send(bytes: number[]): void;
  /** Subscribe to incoming SysEx; returns an unsubscribe. */
  onSysex(fn: (bytes: Uint8Array) => void): () => void;
}

export interface SessionOpts {
  /** How long to wait for each reply. */
  timeoutMs?: number;
  /** Pause after each write (the firmware writes EEPROM pages). */
  writeGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TwisterTimeout extends Error {
  constructor(what: string) {
    super(`The Twister didn't answer (${what})`);
    this.name = "TwisterTimeout";
  }
}

export interface ApplyResult {
  /** Per encoder: the settings read back after the write. */
  after: Map<number, EncoderSettings>;
  /** Encoders whose read-back doesn't match the plan (should be empty). */
  mismatched: number[];
}

/**
 * Talks to one Twister: identify, read the global + per-encoder settings, and
 * apply encoder changes as read-modify-write (push only the changed fields,
 * then push the global settings back unchanged so the firmware reloads and
 * redraws, then read the encoders back to verify).
 */
export class TwisterSession {
  private readonly timeoutMs: number;
  private readonly writeGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly link: SysexLink,
    opts: SessionOpts = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.writeGapMs = opts.writeGapMs ?? 60;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Send `msg` and resolve with the first reply `pick` accepts. */
  private request<T>(msg: number[] | null, pick: (b: Uint8Array) => T | null, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let unsub: () => void = () => {};
      const timer = setTimeout(() => {
        unsub();
        reject(new TwisterTimeout(what));
      }, this.timeoutMs);
      unsub = this.link.onSysex((b) => {
        const v = pick(b);
        if (v === null) return;
        clearTimeout(timer);
        unsub();
        resolve(v);
      });
      if (msg) this.link.send(msg);
    });
  }

  identify(): Promise<TwisterIdentity> {
    return this.request(identityRequest(), parseIdentityReply, "identity");
  }

  readGlobal(): Promise<TagTable> {
    return this.request(pullGlobalRequest(), parseGlobalReply, "global settings");
  }

  readEncoder(tag: number): Promise<EncoderSettings> {
    const asm = new BulkAssembler();
    return this.request(
      pullEncoderRequest(tag),
      (b) => {
        const p = parseBulkPart(b);
        if (!p || p.tag !== tag) return null;
        const done = asm.push(p);
        return done ? decodeEncoder(done.table) : null;
      },
      `encoder ${tag}`,
    );
  }

  /**
   * Read-modify-write. `plans` maps encoder tag → fields to change (from
   * {@link planEncoderChanges}); `global` is the table from
   * {@link readGlobal}, pushed back as-is.
   */
  async apply(plans: Map<number, TagTable>, global: TagTable): Promise<ApplyResult> {
    if (global.length === 0) throw new Error("refusing to push an empty global config");
    for (const [tag, plan] of plans) {
      for (const m of pushEncoderMessages(tag, plan)) {
        this.link.send(m);
        await this.sleep(this.writeGapMs);
      }
    }
    // The global push makes the firmware reload everything from EEPROM and
    // redraw; its reply (the global table again) is the acknowledgement.
    await this.request(pushGlobalMessage(global), parseGlobalReply, "settings reload");
    const after = new Map<number, EncoderSettings>();
    const mismatched: number[] = [];
    for (const [tag, plan] of plans) {
      const s = await this.readEncoder(tag);
      after.set(tag, s);
      const ok = plan.every(([t, v]) => tagValue(s.raw, t) === v);
      if (!ok) mismatched.push(tag);
    }
    return { after, mismatched };
  }
}

/** Port names Web MIDI gives a Twister ("Midi Fighter Twister", "… MIDI 1"). */
export function isTwisterPortName(name: string): boolean {
  return /midi\s*fighter\s*twister/i.test(name);
}
