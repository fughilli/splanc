/**
 * Stateful MIDI decoder: per-control auto-detection of 14-bit Control Change
 * pairs and NRPN (owner decision D-548), falling back to plain 7-bit.
 *
 * {@link parseMidiMessage} is stateless and sees one message at a time, which
 * is all 7-bit CC / notes / pitch-bend need. High-resolution controls span
 * several messages, so this wrapper keeps a little state per device + channel:
 *
 *   - **14-bit CC.** MIDI pairs CC n (MSB, n = 1..31) with CC n+32 (LSB). A
 *     control is treated as 14-bit once its LSB is seen right next to its MSB
 *     (within {@link PAIR_WINDOW_MS}) on {@link PAIR_CONFIRM} occasions. From
 *     then on the message that closes the pair emits ONE event for CC n with
 *     value `((msb << 7) | lsb) / 16383`, and CC n+32 is no longer reported on
 *     its own. Until then both CCs behave as ordinary 7-bit controls, so an
 *     unrelated knob that happens to sit on CC 33..63 keeps working. The MSB
 *     is held until its LSB arrives (the spec's MSB-then-LSB order); an LSB
 *     on its own updates the low bits, for senders that repeat the MSB only
 *     when it changes. Two MSBs with no LSB between them drop the control
 *     back to 7-bit. CC 0/32 (bank select) is never paired.
 *   - **NRPN.** CC 99/98 select a parameter, CC 6 (and optionally CC 38) carry
 *     its value, CC 96/97 step it. Each selected parameter becomes its own
 *     control (`kind: "nrpn"`, `number = (msb << 7) | lsb`); it is 14-bit
 *     once CC 38 has been seen for it, 7-bit (CC 6 only) before that. RPN
 *     selections (CC 101/100) are tracked so their data entry is swallowed
 *     rather than reported as CC 6. The selector CCs 98..101 are reserved for
 *     this by the MIDI spec and are never reported as controls.
 *
 * The control id of a 14-bit CC is the MSB's id (`cc`, number n), so a knob
 * that was learned and bound as 7-bit keeps the same binding when its 14-bit
 * stream is detected. Pure apart from its own state: no DOM, no Web MIDI, so
 * the unit tests drive it with byte arrays and fake timestamps.
 */

import type { MidiControlEvent } from "./manager";
import { parseMidiMessage } from "./parse";

/** Max gap (ms) between an MSB and its LSB for them to count as one pair.
 * 14-bit controllers send both back to back (usually in one USB packet); a
 * person moving two separate knobs is far slower than this. */
export const PAIR_WINDOW_MS = 10;
/** Adjacent MSB/LSB sightings needed before a CC is decoded as 14-bit. */
export const PAIR_CONFIRM = 2;

const CC_NRPN_MSB = 99;
const CC_NRPN_LSB = 98;
const CC_RPN_MSB = 101;
const CC_RPN_LSB = 100;
const CC_DATA_MSB = 6;
const CC_DATA_LSB = 38;
const CC_DATA_INC = 96;
const CC_DATA_DEC = 97;

/** Detection state for one MSB/LSB pair (a 14-bit CC, or one NRPN's data). */
interface PairState {
  /** Confirmed 14-bit? */
  wide: boolean;
  /** Candidate sightings so far (CC only; NRPN confirms on the first LSB). */
  hits: number;
  /** In wide mode: the MSB has arrived and its LSB hasn't yet. */
  pending: boolean;
  msb: number;
  lsb: number;
}

/** Per device + channel state. */
interface ChannelState {
  /** Last CC on this channel (number + time), for MSB/LSB adjacency. */
  lastCc: number;
  lastT: number;
  lastVal: number;
  /** Which parameter data entry addresses, if any. */
  select: "nrpn" | "rpn" | null;
  selMsb: number;
  selLsb: number;
  /** 14-bit CC pairs, keyed by the MSB number. */
  cc: Map<number, PairState>;
  /** NRPN parameters, keyed by the 14-bit parameter number. */
  nrpn: Map<number, PairState>;
}

function newPair(): PairState {
  return { wide: false, hits: 0, pending: false, msb: 0, lsb: 0 };
}

/** True for an MSB CC number that may pair with CC n+32. */
function isPairableMsb(n: number): boolean {
  return n >= 1 && n <= 31;
}

/**
 * Turns raw MIDI messages into normalized control events, with 14-bit CC and
 * NRPN detected per control. One instance per {@link MidiManager}; state is
 * keyed by device name, so several controllers can share it.
 */
export class MidiDecoder {
  private readonly channels = new Map<string, ChannelState>();

  /** Forget all detection state (e.g. after a device is unplugged). */
  reset(): void {
    this.channels.clear();
  }

  /**
   * Decode one message received at time `t` (ms, any monotonic clock). Returns
   * the event it produces, or null when it produces none (an unmapped message,
   * an NRPN selector, or the first half of a 14-bit pair held for its partner).
   */
  decode(device: string, data: Uint8Array | number[], t: number): MidiControlEvent | null {
    if (data.length < 3 || (data[0]! & 0xf0) !== 0xb0) return parseMidiMessage(device, data);
    const channel = data[0]! & 0x0f;
    const num = data[1]! & 0x7f;
    const val = data[2]! & 0x7f;
    const st = this.channel(device, channel);
    const prevCc = st.lastCc;
    const prevT = st.lastT;
    const prevVal = st.lastVal;
    st.lastCc = num;
    st.lastT = t;

    // --- NRPN / RPN parameter selection -----------------------------------
    if (num === CC_NRPN_MSB || num === CC_NRPN_LSB) {
      if (st.select !== "nrpn") {
        st.select = "nrpn";
        st.selMsb = 0;
        st.selLsb = 0;
      }
      if (num === CC_NRPN_MSB) st.selMsb = val;
      else st.selLsb = val;
      return null;
    }
    if (num === CC_RPN_MSB || num === CC_RPN_LSB) {
      if (num === CC_RPN_MSB) st.selMsb = val;
      else st.selLsb = val;
      // RPN 127/127 is the "null" parameter: deselect, data entry is plain CC.
      st.select = st.selMsb === 127 && st.selLsb === 127 ? null : "rpn";
      return null;
    }

    // --- NRPN / RPN data entry --------------------------------------------
    const isData =
      num === CC_DATA_MSB || num === CC_DATA_LSB || num === CC_DATA_INC || num === CC_DATA_DEC;
    if (isData && st.select === "rpn") return null; // RPNs aren't mappable
    if (isData && st.select === "nrpn") return this.nrpnData(device, channel, st, num, val);

    // --- Control Change, possibly one half of a 14-bit pair ----------------
    if (isPairableMsb(num)) {
      st.lastVal = val;
      const p = st.cc.get(num);
      if (p === undefined || !p.wide) return cc7(device, channel, num, val);
      if (p.pending) {
        // Two MSBs with no LSB between them: the sender stopped pairing.
        st.cc.delete(num);
        return cc7(device, channel, num, val);
      }
      p.msb = val;
      p.lsb = 0; // per the spec a new MSB resets the LSB
      p.pending = true; // held until its LSB arrives
      return null;
    }
    if (num >= 33 && num <= 63) {
      const msbNum = num - 32;
      let p = st.cc.get(msbNum);
      if (p !== undefined && p.wide) {
        // An LSB on its own is fine too: some senders repeat the MSB only
        // when it changes.
        p.lsb = val;
        p.pending = false;
        return cc14(device, channel, msbNum, p);
      }
      if (prevCc === msbNum && t - prevT <= PAIR_WINDOW_MS) {
        // An LSB right after its MSB: a 14-bit sighting.
        if (p === undefined) {
          p = newPair();
          st.cc.set(msbNum, p);
        }
        p.msb = prevVal;
        p.lsb = val;
        if (++p.hits < PAIR_CONFIRM) return null; // a candidate LSB isn't its own control
        p.wide = true;
        p.pending = false;
        return cc14(device, channel, msbNum, p);
      }
    }
    return cc7(device, channel, num, val);
  }

  private channel(device: string, channel: number): ChannelState {
    const key = `${device}|${channel}`;
    let st = this.channels.get(key);
    if (st === undefined) {
      st = {
        lastCc: -1,
        lastT: -Infinity,
        lastVal: 0,
        select: null,
        selMsb: 0,
        selLsb: 0,
        cc: new Map(),
        nrpn: new Map(),
      };
      this.channels.set(key, st);
    }
    return st;
  }

  private nrpnData(
    device: string,
    channel: number,
    st: ChannelState,
    num: number,
    val: number,
  ): MidiControlEvent | null {
    const param = (st.selMsb << 7) | st.selLsb;
    let p = st.nrpn.get(param);
    if (p === undefined) {
      p = newPair();
      st.nrpn.set(param, p);
    }
    if (num === CC_DATA_MSB) {
      if (p.wide && p.pending) p.wide = false; // two MSBs, no LSB: 7-bit after all
      p.msb = val;
      p.lsb = 0; // per the spec a new MSB resets the LSB
      if (!p.wide) return nrpnEvent(device, channel, param, p);
      p.pending = true;
      return null;
    }
    if (num === CC_DATA_LSB) {
      p.lsb = val;
      p.wide = true;
      p.pending = false;
      return nrpnEvent(device, channel, param, p);
    }
    // Data increment / decrement: one step at the parameter's resolution.
    const dir = num === CC_DATA_INC ? 1 : -1;
    if (p.wide) {
      const v = Math.min(16383, Math.max(0, ((p.msb << 7) | p.lsb) + dir));
      p.msb = v >> 7;
      p.lsb = v & 0x7f;
    } else {
      p.msb = Math.min(127, Math.max(0, p.msb + dir));
    }
    p.pending = false;
    return nrpnEvent(device, channel, param, p);
  }
}

function cc7(device: string, channel: number, number: number, val: number): MidiControlEvent {
  return { control: { device, kind: "cc", channel, number }, value: val / 127, raw: val };
}

function cc14(device: string, channel: number, number: number, p: PairState): MidiControlEvent {
  const raw = (p.msb << 7) | p.lsb;
  return {
    control: { device, kind: "cc", channel, number },
    value: raw / 16383,
    raw,
    bits: 14,
    raw7: p.msb,
  };
}

function nrpnEvent(
  device: string,
  channel: number,
  param: number,
  p: PairState,
): MidiControlEvent {
  const control = { device, kind: "nrpn" as const, channel, number: param };
  if (!p.wide) return { control, value: p.msb / 127, raw: p.msb };
  const raw = (p.msb << 7) | p.lsb;
  return { control, value: raw / 16383, raw, bits: 14, raw7: p.msb };
}
