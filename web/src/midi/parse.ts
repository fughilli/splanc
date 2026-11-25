/**
 * The stateless one-message MIDI parser (see manager.ts for the event model).
 * Kept in its own module so both {@link MidiManager} and {@link MidiDecoder}
 * can use it without an import cycle.
 */

import type { MidiControlEvent } from "./manager";

/**
 * Parse one raw MIDI message into a normalized control event, or null if it is
 * a message kind we don't map (clock, sysex, note-off treated below, etc.).
 * Pure and side-effect free — the manager wraps it, tests call it directly.
 *
 * Recognized:
 *   - Control Change (0xB0): value = data2/127.
 *   - Note On (0x90) with velocity>0: value = velocity/127. Note On vel 0 and
 *     Note Off (0x80) map to value 0 (so a pad press-release drives 1→0).
 *   - Pitch Bend (0xE0): 14-bit, value = ((data2<<7)|data1)/16383.
 */
export function parseMidiMessage(
  device: string,
  data: Uint8Array | number[],
): MidiControlEvent | null {
  if (data.length < 2) return null;
  const status = data[0]!;
  const type = status & 0xf0;
  const channel = status & 0x0f;
  const d1 = data[1]! & 0x7f;
  const d2 = (data[2] ?? 0) & 0x7f;

  switch (type) {
    case 0xb0: // Control Change
      return {
        control: { device, kind: "cc", channel, number: d1 },
        value: d2 / 127,
        raw: d2,
      };
    case 0x90: // Note On (velocity 0 == note off)
      return {
        control: { device, kind: "note", channel, number: d1 },
        value: d2 / 127,
        raw: d2,
      };
    case 0x80: // Note Off
      return {
        control: { device, kind: "note", channel, number: d1 },
        value: 0,
        raw: 0,
      };
    case 0xe0: {
      // Pitch Bend — 14-bit little-endian (d1 = LSB, d2 = MSB).
      const raw = (d2 << 7) | d1;
      return {
        control: { device, kind: "pitch", channel, number: 0 },
        value: raw / 16383,
        raw,
      };
    }
    default:
      return null;
  }
}
