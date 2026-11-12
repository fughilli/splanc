/**
 * The lamp side of the P4 demo: what the page needs from its connection to the
 * player (OSC both ways, effect upload), the parse of what the P4 tracker module
 * sends back, and a simulated lamp for `?mock=1`.
 *
 * The real link is the app's own player connection (ui/app/state.ts `appState.client`,
 * a LedMapperClient over wss, with the device sheet's discovery and cert trust): OSC
 * goes in ClientMessage.osc and comes back in ServerMessage.osc, on firmware that
 * advertises the "osc" feature in its welcome.
 */

import type { LedMapperClient } from "../net/client";
import { decode, message, type OscMessage } from "./osc";
import { MOCK_LAMP_POS } from "./lh/mock";
import type { LhStation, Quat, Vec3 } from "./lh/types";
import { fromColumnMajor, quatFromAxisAngle, quatMul, quatToMat, type Pose } from "./frames";

/** What the page does with a lamp. */
export interface LampLink {
  readonly kind: "real" | "mock";
  connected(): boolean;
  /** The player's name (welcome.deviceName), or "" when unknown. */
  name(): string;
  /** welcome.features; empty when not connected. */
  features(): string[];
  sendOsc(packet: Uint8Array): boolean;
  onOsc(cb: (packet: Uint8Array) => void): () => void;
  submitEffect(effectId: string, fxb: Uint8Array): Promise<void>;
}

/** Why the page can't drive this lamp, or null when it can. */
export function lampProblem(link: LampLink | null): string | null {
  if (!link || !link.connected()) return "No lamp connected. Tap the lamp pill to pick your PixieLamp.";
  if (!link.features().includes("osc"))
    return (
      `${link.name() || "This player"}'s firmware can't take OSC over the app's connection ` +
      '(its welcome lacks the "osc" feature). Reflash it with a P4 build that includes ' +
      "OSC over the WebSocket session (Flash firmware in the Splanc app), then reconnect."
    );
  return null;
}

/** The app's own connection to a player, as a LampLink. */
export function realLamp(client: LedMapperClient): LampLink {
  return {
    kind: "real",
    connected: () => client.isConnected,
    name: () => client.welcome?.deviceName ?? "",
    features: () => (client.isConnected ? (client.welcome?.features ?? []) : []),
    sendOsc: (p) => client.sendOsc(p),
    onOsc: (cb) => client.onOsc(cb),
    async submitEffect(id, fxb) {
      await client.submitEffect(id, fxb, true);
    },
  };
}

// ---------------------------------------------------------------- what the P4 sends back

export interface LampPose {
  /** tracker_ok: locked or coasting. */
  ok: boolean;
  /** world <- the P4's tracker. */
  pose: Pose;
  pos: Vec3;
  quat: Quat;
  /** performance.now() ms when it arrived. */
  at: number;
}

/** /lh/pose ,ffffffff: tracker_ok, x y z, qw qx qy qz (world <- tracker). */
export function parseLhPose(m: OscMessage, at: number): LampPose | null {
  if (m.address !== "/lh/pose" || m.args.length !== 8 || !m.args.every((a) => typeof a === "number")) return null;
  const a = m.args as number[];
  const pos: Vec3 = [a[1]!, a[2]!, a[3]!];
  const quat: Quat = [a[4]!, a[5]!, a[6]!, a[7]!];
  const n = Math.hypot(...quat);
  if (!(n > 0.5 && n < 1.5) || !pos.every(Number.isFinite)) return null;
  return { ok: a[0]! > 0.5, pose: { R: quatToMat(quat), t: pos }, pos, quat, at };
}

/** /lh/fixture_pose ,f x16: world <- fixture map, column-major. */
export function parseFixturePose(m: OscMessage): { pose: Pose; s: number } | null {
  if (m.address !== "/lh/fixture_pose" || m.args.length !== 16 || !m.args.every((a) => typeof a === "number"))
    return null;
  return fromColumnMajor(m.args as number[]);
}

// ---------------------------------------------------------------- the simulated lamp

/** A stand-in PixieLamp2 for `?mock=1` with no lamp connected: decodes what the page
 * sends (to show it), and, once it has had OSC (the P4 only answers a session that
 * sent OSC), reports its tracker at ~30 Hz from a spot in the mock world, swaying a
 * little. It adopts stations like the P4 (`/lh/station`). */
export class MockLamp implements LampLink {
  readonly kind = "mock";
  private subs = new Set<(p: Uint8Array) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = performance.now();
  readonly received = new Map<string, (number | string)[]>();
  readonly stations = new Map<number, LhStation>();
  effect = "";
  datagrams = 0;

  connected(): boolean {
    return true;
  }
  name(): string {
    return "Simulated PixieLamp2";
  }
  features(): string[] {
    return ["osc", "decks"];
  }
  sendOsc(packet: Uint8Array): boolean {
    this.datagrams++;
    for (const m of decode(packet)) {
      if (m.address === "/lh/station" && m.args.length === 8) {
        const a = m.args as number[];
        this.stations.set(a[0]!, { id: a[0]!, pos: [a[1]!, a[2]!, a[3]!], quat: [a[4]!, a[5]!, a[6]!, a[7]!] });
      } else {
        this.received.set(m.address, m.args);
      }
    }
    if (this.timer === null) this.timer = setInterval(() => this.emit(), 33);
    return true;
  }
  onOsc(cb: (p: Uint8Array) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  async submitEffect(effectId: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 300));
    this.effect = effectId;
    this.received.clear();
  }
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  private emit(): void {
    const t = (performance.now() - this.t0) / 1000;
    const pos: Vec3 = [MOCK_LAMP_POS[0] + 0.01 * Math.sin(t * 0.5), MOCK_LAMP_POS[1], MOCK_LAMP_POS[2]];
    const q = quatMul(quatFromAxisAngle([0, 0, 1], 0.4 + 0.05 * Math.sin(t * 0.3)), [1, 0, 0, 0]);
    const ok = t > 1; // acquiring for a second, as the P4 does after a start
    const pkt = messageForPose(ok, pos, q);
    for (const cb of this.subs) cb(pkt);
  }
}

function messageForPose(ok: boolean, pos: Vec3, q: Quat): Uint8Array {
  return message("/lh/pose", ok ? 1 : 0, pos[0], pos[1], pos[2], q[0], q[1], q[2], q[3]);
}
