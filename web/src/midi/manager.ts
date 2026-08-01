/**
 * Web MIDI hardware layer (FUG-9). Wraps `navigator.requestMIDIAccess()`,
 * tracks connected input ports, and turns raw MIDI byte messages into a stable,
 * normalized control event the rest of the app consumes:
 *
 *   - a {@link MidiControlId} identifies a physical control uniquely across
 *     sessions (device name + kind + channel + number), so a knob you named
 *     "speed" today is the same knob tomorrow.
 *   - a normalized value in 0..1 (CC / note-velocity / pitch-bend all fold to
 *     this single scale) so the mapping/router layer never sees raw MIDI bytes.
 *
 * This module is the ONLY place that touches the Web MIDI API. Everything is
 * guarded behind `navigator.requestMIDIAccess` existence so it degrades to a
 * no-op (and the unit tests, which import only the pure parser below, run under
 * Node). Message PARSING is a pure function ({@link parseMidiMessage}) exported
 * for tests; the manager is the stateful event pump around it.
 */

/** The kind of physical control a message came from. */
export type MidiControlKind = "cc" | "note" | "pitch";

/** A physical MIDI control, identified stably across sessions.
 * `device` is the input port name (stable per hardware model); `channel` is
 * 0..15; `number` is the CC number / note number (pitch-bend uses 0). */
export interface MidiControlId {
  device: string;
  kind: MidiControlKind;
  channel: number;
  number: number;
}

/** A normalized control event: which control moved and its value in 0..1. */
export interface MidiControlEvent {
  control: MidiControlId;
  /** Normalized 0..1 (CC/velocity /127, pitch-bend /16383). */
  value: number;
  /** Raw 14-bit-or-7-bit integer value, for display. */
  raw: number;
}

/** Stable string key for a control id — used as a map key everywhere. */
export function controlKey(c: MidiControlId): string {
  return `${c.device}|${c.kind}|${c.channel}|${c.number}`;
}

/** Human-friendly one-line label for a control (device omitted — shown separately). */
export function controlLabel(c: MidiControlId): string {
  const ch = c.channel + 1;
  if (c.kind === "cc") return `CC ${c.number} · ch ${ch}`;
  if (c.kind === "note") return `Note ${c.number} · ch ${ch}`;
  return `Pitch bend · ch ${ch}`;
}

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

// Web MIDI types (MIDIAccess / MIDIInput / MIDIMessageEvent) come from the DOM
// lib — no extra dependency needed.

/** A connected input device, surfaced to the UI. */
export interface MidiDeviceInfo {
  id: string;
  name: string;
}

type ControlListener = (e: MidiControlEvent) => void;
type DevicesListener = (devices: MidiDeviceInfo[]) => void;

/** True when this browser exposes the Web MIDI API. */
export function midiSupported(): boolean {
  return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
}

/**
 * Stateful pump around the Web MIDI API. Call {@link enable} once (it triggers
 * the browser permission prompt); thereafter it emits a normalized
 * {@link MidiControlEvent} for every recognized message and keeps a live list
 * of connected input devices. A singleton ({@link midiManager}) is shared so
 * the settings screen and every editor observe the SAME hardware stream.
 */
export class MidiManager {
  private access: MIDIAccess | null = null;
  private enabling: Promise<boolean> | null = null;
  private readonly controlListeners = new Set<ControlListener>();
  private readonly deviceListeners = new Set<DevicesListener>();
  private lastEvent: MidiControlEvent | null = null;

  /** Whether {@link enable} has succeeded (MIDI access granted). */
  get enabled(): boolean {
    return this.access !== null;
  }

  /** The most recent control event seen (for a learn UI that opened late). */
  get lastControl(): MidiControlEvent | null {
    return this.lastEvent;
  }

  /**
   * Request MIDI access (idempotent — concurrent/repeat calls share one prompt).
   * Resolves true once inputs are wired, false if unsupported or denied.
   */
  async enable(): Promise<boolean> {
    if (this.access !== null) return true;
    if (this.enabling !== null) return this.enabling;
    if (!midiSupported()) return false;
    this.enabling = (async () => {
      try {
        const access = await navigator.requestMIDIAccess({ sysex: false });
        this.access = access;
        access.onstatechange = () => this.rewire();
        this.rewire();
        return true;
      } catch {
        return false;
      } finally {
        this.enabling = null;
      }
    })();
    return this.enabling;
  }

  /** Attach message handlers to all current inputs and publish the device list. */
  private rewire(): void {
    if (this.access === null) return;
    this.access.inputs.forEach((input) => {
      // Reassign unconditionally — cheap and idempotent, covers hot-plug.
      input.onmidimessage = (e: MIDIMessageEvent) => this.onMessage(input, e);
    });
    this.emitDevices();
  }

  private onMessage(input: MIDIInput, e: MIDIMessageEvent): void {
    if (e.data === null) return;
    const ev = parseMidiMessage(input.name ?? input.id, e.data);
    if (ev === null) return;
    this.lastEvent = ev;
    for (const fn of this.controlListeners) fn(ev);
  }

  /** Currently connected input devices. */
  devices(): MidiDeviceInfo[] {
    if (this.access === null) return [];
    const out: MidiDeviceInfo[] = [];
    this.access.inputs.forEach((i) => {
      if (i.state === "connected") out.push({ id: i.id, name: i.name ?? i.id });
    });
    return out;
  }

  private emitDevices(): void {
    const list = this.devices();
    for (const fn of this.deviceListeners) fn(list);
  }

  /** Subscribe to normalized control events. Returns an unsubscribe fn. */
  onControl(fn: ControlListener): () => void {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  /** Subscribe to device-list changes (hot-plug). Returns an unsubscribe fn. */
  onDevices(fn: DevicesListener): () => void {
    this.deviceListeners.add(fn);
    return () => this.deviceListeners.delete(fn);
  }
}

/** Shared singleton so all screens observe the same hardware stream. */
export const midiManager = new MidiManager();
