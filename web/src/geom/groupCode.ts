/**
 * Group capture code layout + record plumbing for multi-fixture localization
 * (docs/design/multi-fixture-localization.md §4).
 *
 * Every fixture in a group capture flashes a DISJOINT id range of ONE shared
 * code book (firmware `group_capture`: LED i transmits id i + code_offset, bits
 * derived from the shared code_space) on ONE shared clock, so the phone runs a
 * single unmodified decoder over the whole scene and splits the decoded ids
 * back into (fixture, LED) here.
 *
 * Pure functions: no DOM, no transport.
 */

import type { DetectionRecord, OutputMap } from "@ledmapper/protocol";
import {
  composeRoomPose,
  invertRoomPose,
  localizeFixtures,
  type CaptureView,
  type FixtureModel,
  type LocalizeOptions,
  type LocalizeResult,
  type RoomPose,
} from "./multiFixture";

/** One fixture's slice of the shared code book. */
export interface CodeSlot {
  /** Device id (MAC). */
  id: string;
  /** First code-book id this fixture transmits. */
  offset: number;
  /** Physical LEDs it drives (ids offset .. offset + ledCount - 1). */
  ledCount: number;
}

export interface CodeLayout {
  /** Shared code-book size (every member derives bits / cycle from it). */
  codeSpace: number;
  slots: CodeSlot[];
}

/** Firmware cap (MAX_CODE_SPACE in firmware/player). */
export const MAX_CODE_SPACE = 4096;

/** Contiguous, in member order. Throws when the group exceeds the firmware cap. */
export function planCodeLayout(members: readonly { id: string; ledCount: number }[]): CodeLayout {
  let next = 0;
  const slots = members.map((m) => {
    const n = Math.max(1, Math.floor(m.ledCount));
    const s = { id: m.id, offset: next, ledCount: n };
    next += n;
    return s;
  });
  if (next > MAX_CODE_SPACE) throw new Error(`group has ${next} LEDs; a group capture supports up to ${MAX_CODE_SPACE}`);
  return { codeSpace: Math.max(1, next), slots };
}

/** Map a decoded code-book id to (member index, LED index), or null. */
export function splitId(layout: CodeLayout, id: number): { member: number; led: number } | null {
  // Small groups: a linear scan is cheaper than anything clever.
  for (let i = 0; i < layout.slots.length; i++) {
    const s = layout.slots[i]!;
    if (id >= s.offset && id < s.offset + s.ledCount) return { member: i, led: id - s.offset };
  }
  return null;
}

/** Group dense per-frame records (CvPipeline denseRecords) into solver views:
 * one view per capture timestamp, sightings split per fixture. */
export function recordsToViews(records: readonly DetectionRecord[], layout: CodeLayout): CaptureView[] {
  const byT = new Map<number, CaptureView>();
  for (const r of records) {
    const sp = splitId(layout, r.ledId);
    if (sp === null) continue;
    let v = byT.get(r.tCaptureMs);
    if (!v) {
      v = { t: r.tCaptureMs, K: r.K, sightings: [] };
      byT.set(r.tCaptureMs, v);
    }
    v.sightings.push({ fixture: sp.member, led: sp.led, u: r.u, v: r.v });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Per-fixture "seen enough?" progress for the guided UI. */
export interface SeenProgress {
  /** Frames with >= minLeds of this fixture decoded. */
  frames: number;
  /** Of those, frames shared with at least one other fixture. */
  shared: number;
  /** Distinct LEDs decoded. */
  leds: number;
}

export function seenProgress(views: readonly CaptureView[], members: number, minLeds = 6): SeenProgress[] {
  const out: SeenProgress[] = Array.from({ length: members }, () => ({ frames: 0, shared: 0, leds: 0 }));
  const leds = Array.from({ length: members }, () => new Set<number>());
  for (const v of views) {
    const counts = new Map<number, number>();
    for (const s of v.sightings) {
      counts.set(s.fixture, (counts.get(s.fixture) ?? 0) + 1);
      leds[s.fixture]?.add(s.led);
    }
    const strong = [...counts.entries()].filter(([, n]) => n >= minLeds).map(([k]) => k);
    for (const k of strong) {
      const p = out[k];
      if (!p) continue;
      p.frames++;
      if (strong.length >= 2) p.shared++;
    }
  }
  leds.forEach((s, i) => (out[i]!.leds = s.size));
  return out;
}

/** "Enough" for a fixture: in this many frames together with a neighbour. */
export const SHARED_FRAMES_GOAL = 25;

/** The solver's model of a fixture from its stored map. "up" comes from the
 * map frame (a gravity-levelled solve has +Y up) unless an IMU-measured up in
 * the map frame is supplied. */
export function fixtureModel(id: string, name: string, map: OutputMap, imuUp?: [number, number, number] | null): FixtureModel {
  const leds = new Map<number, [number, number, number]>();
  for (const l of map.leds) {
    const [x, y, z] = l.xyz;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) leds.set(l.id, [x, y, z]);
  }
  const up = imuUp ?? (map.frame === "gravity_leveled" ? ([0, 1, 0] as [number, number, number]) : null);
  const se = map.stats?.scaleRelStdErr;
  return { id, name, leds, up, scaleRelStdErr: typeof se === "number" && se > 0 ? se : null };
}

// ---------------------------------------------------------------------------
// Capture parameters (the per-fixture capture profile)
// ---------------------------------------------------------------------------

/**
 * The subset of the device-stored capture profile (proto CaptureProfile, the
 * sensor stack's `get_capture_profile`, web/src/capture/captureProfile.ts on
 * that branch) a group capture uses. Same field names as its camelCase wire
 * shape, so the flat reply drops straight in.
 */
export interface CaptureProfileLike {
  mapId?: string;
  diffuse?: boolean;
  strideSpacing?: number;
  anchorDensity?: number;
  symbols?: number;
  bitPeriodMs?: number;
  brightness?: number;
}

/** What one member flashes in the group capture. */
export interface MemberCapture {
  diffuse: boolean;
  /** Diffuse members light one coverage phase of the stride schedule (phase 0):
   * a sparse, well-spread subset is plenty to register a known map. */
  strideSpacing: number;
  anchorDensity: number;
  brightness: number | null;
}

export interface GroupTiming {
  symbols: 2 | 4;
  bitPeriodMs: number;
}

/** Resolve each member's capture knobs from its stored profile (falling back to
 * the app's per-device stride + global diffuse toggle), and the SHARED timing:
 * one decoder reads every fixture, so all use the most conservative alphabet
 * and the slowest bit period any profile needed (never faster than 100 ms). */
export function resolveGroupCapture(
  members: readonly { profile: CaptureProfileLike | null; fallback: { diffuse: boolean; strideSpacing: number; anchorDensity: number } }[],
): { members: MemberCapture[]; timing: GroupTiming } {
  let symbols: 2 | 4 = 4;
  let bitPeriodMs = 100;
  const out = members.map(({ profile: p, fallback }) => {
    if (p?.symbols === 2) symbols = 2;
    if (p?.bitPeriodMs && p.bitPeriodMs > bitPeriodMs) bitPeriodMs = p.bitPeriodMs;
    const diffuse = p?.diffuse ?? fallback.diffuse;
    return {
      diffuse,
      strideSpacing: diffuse ? Math.max(1, Math.floor(p?.strideSpacing ?? fallback.strideSpacing)) : 1,
      anchorDensity: Math.max(3, Math.floor(p?.anchorDensity ?? fallback.anchorDensity)),
      brightness: p?.brightness && p.brightness > 0 && p.brightness <= 1 ? p.brightness : null,
    };
  });
  return { members: out, timing: { symbols, bitPeriodMs } };
}

/** StartMappingOptions (camelCase wire shape, minus ledCount) for one member. */
export function memberStartOptions(
  slot: CodeSlot,
  layout: CodeLayout,
  cap: MemberCapture,
  timing: GroupTiming,
): Record<string, number> {
  return {
    ledCount: slot.ledCount,
    symbols: timing.symbols,
    bitPeriodMs: timing.bitPeriodMs,
    codeOffset: slot.offset,
    codeSpace: layout.codeSpace,
    ...(cap.brightness !== null ? { brightness: cap.brightness } : {}),
    ...(cap.diffuse && cap.strideSpacing > 1
      ? { strideSpacing: cap.strideSpacing, anchorDensity: cap.anchorDensity, stridePhase: 0 }
      : {}),
  };
}

/** The shared epoch in a member's clock: phone-local epoch + that member's
 * clock offset (server = local + offset). */
export function deviceEpochMs(localEpochMs: number, offsetMs: number): number {
  return Math.round(localEpochMs + offsetMs);
}

// ---------------------------------------------------------------------------
// The capture session (transport-free; the screen drives it)
// ---------------------------------------------------------------------------

/** A stored pose (FixturePose wire shape) as a solver RoomPose (null: none/invalid). */
export function flatToRoomPose(p: { translation?: number[]; rotation?: number[]; scale?: number } | null | undefined): RoomPose | null {
  if (!p || !Array.isArray(p.translation) || p.translation.length !== 3) return null;
  const r = Array.isArray(p.rotation) && p.rotation.length === 4 ? p.rotation : [0, 0, 0, 1];
  const n = Math.hypot(...r) || 1;
  return {
    translation: [p.translation[0]!, p.translation[1]!, p.translation[2]!],
    rotation: [r[0]! / n, r[1]! / n, r[2]! / n, r[3]! / n],
    scale: p.scale && p.scale > 0 ? p.scale : 1,
  };
}

export function roomPoseToFlat(room: string, p: RoomPose): { room: string; translation: number[]; rotation: number[]; scale: number } {
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { room, translation: p.translation.map(r6), rotation: p.rotation.map(r6), scale: r6(p.scale) };
}

/**
 * Express solved poses (relative to the reference's levelled map frame) in the
 * room frame to store. When the reference already has a stored pose, the room
 * keeps its frame: everything is re-anchored on the reference's existing pose
 * (so adding a fixture to a set-up room doesn't move the others). Otherwise the
 * room frame IS the reference's levelled map frame.
 */
export function anchorPoses(
  solved: readonly (RoomPose | null)[],
  reference: number,
  referenceStored: RoomPose | null,
): (RoomPose | null)[] {
  const ref = solved[reference];
  if (!referenceStored || !ref) return [...solved];
  // room ← refmap is referenceStored; solve ← refmap is ref. room ← solve = stored ∘ ref⁻¹.
  const A = composeRoomPose(referenceStored, invertRoomPose(ref));
  return solved.map((p) => (p ? composeRoomPose(A, p) : null));
}

export class GroupCaptureSession {
  readonly layout: CodeLayout;
  readonly models: FixtureModel[];
  private readonly byT = new Map<number, CaptureView>();
  private sorted: CaptureView[] | null = null;
  last: LocalizeResult | null = null;

  constructor(
    readonly members: readonly { id: string; name: string; ledCount: number; map: OutputMap; imuUp?: [number, number, number] | null }[],
    public reference: number,
  ) {
    this.layout = planCodeLayout(members.map((m) => ({ id: m.id, ledCount: m.ledCount })));
    this.models = members.map((m) => fixtureModel(m.id, m.name, m.map, m.imuUp ?? null));
  }

  addRecords(records: readonly DetectionRecord[]): void {
    for (const v of recordsToViews(records, this.layout)) {
      const have = this.byT.get(v.t);
      if (have) have.sightings.push(...v.sightings);
      else this.byT.set(v.t, v);
    }
    this.sorted = null;
  }

  views(): CaptureView[] {
    if (!this.sorted) this.sorted = [...this.byT.values()].sort((a, b) => a.t - b.t);
    return this.sorted;
  }

  progress(): SeenProgress[] {
    return seenProgress(this.views(), this.members.length);
  }

  /** Solve on what's been captured; warm-started from the previous solve. */
  solve(options: LocalizeOptions = {}): LocalizeResult {
    const seed = this.last?.fixtures.map((f) => f.pose);
    this.last = localizeFixtures(this.models, this.views(), {
      reference: this.reference,
      ...(seed ? { seedPoses: seed } : {}),
      ...options,
    });
    return this.last;
  }
}
