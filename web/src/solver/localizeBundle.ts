/**
 * Room-localization reproduction bundles (docs/design/multi-fixture-localization.md
 * §8): everything needed to replay a multi-fixture localization solve offline,
 * in the SAME envelope as the mapping capture bundles (solver/captureBundle.ts,
 * #318) so they share the debug-mode store, the Settings ▸ Debugging list and
 * its Export / Share:
 *
 *   format/version/id/createdAt/outcome/summary/app/device  — as capture bundles
 *   capture    the group capture: transport, code layout + shared code params,
 *              per-member knobs (profile / stride / brightness), arm results
 *              (clock-sync skew bounds), phone-local epoch, duration
 *   fixtures   each member's map as the solver saw it (LED id + xyz), its up
 *              vector and scale prior, and the pose it had before
 *   views      the solver input: per-frame decoded sightings (fixture, LED, u, v)
 *   options    LocalizeOptions used
 *   result     the solver output (or the error)
 *
 * Replay: {@link replayLocalizeBundle} (node: compile web/ and require it; the
 * web unit test does exactly that).
 */

import type { CodeParams, Intrinsics, Vec3 } from "@ledmapper/protocol";
import {
  localizeFixtures,
  type CaptureView,
  type FixtureModel,
  type LocalizeOptions,
  type LocalizeResult,
  type RoomPose,
} from "../geom/multiFixture";
import type { CodeLayout, GroupTiming, MemberCapture } from "../geom/groupCode";
import { deviceInfo, type DeviceInfo } from "./captureBundle";

export const LOCALIZE_BUNDLE_FORMAT = "splanc-localize-bundle";
export const LOCALIZE_BUNDLE_VERSION = 1;

export type LocalizeOutcome = "localized" | "partial" | "failed" | "aborted";

export interface LocalizeBundleFixture {
  id: string;
  name: string;
  /** [ledId, x, y, z] in the fixture's map frame. */
  leds: [number, number, number, number][];
  up: Vec3 | null;
  scaleRelStdErr: number | null;
  mapId: string | null;
  /** The pose stored before this run (null: unposed). */
  priorPose: RoomPose | null;
}

export interface LocalizeBundle {
  format: typeof LOCALIZE_BUNDLE_FORMAT;
  version: typeof LOCALIZE_BUNDLE_VERSION;
  id: string;
  createdAt: string;
  outcome: LocalizeOutcome;
  summary: string;
  app: { version: string | null; gitCommit: string; gitDirty: boolean };
  device: DeviceInfo;
  capture: {
    /** Total LEDs across the group (the store's list column). */
    ledCount: number;
    transport: "bridge" | "direct";
    layout: CodeLayout;
    codeParams: CodeParams | null;
    timing: GroupTiming | null;
    members: { id: string; name: string; features: string[]; capture: MemberCapture | null; profile: unknown }[];
    arm: { id: string; ok: boolean; error?: string; skewBoundMs?: number }[];
    epochLocalMs: number | null;
    durationMs: number;
    reference: number;
  };
  fixtures: LocalizeBundleFixture[];
  views: CaptureView[];
  options: LocalizeOptions;
  result: LocalizeResult | null;
  error: string | null;
  /** Kept empty (the capture-bundle store counts frames). */
  frames: never[];
}

export function bundleFixture(m: FixtureModel, mapId: string | null, priorPose: RoomPose | null): LocalizeBundleFixture {
  const r = (x: number) => Math.round(x * 1e5) / 1e5;
  return {
    id: m.id,
    name: m.name ?? m.id,
    leds: [...m.leds.entries()].map(([id, p]) => [id, r(p[0]), r(p[1]), r(p[2])]),
    up: m.up ?? null,
    scaleRelStdErr: m.scaleRelStdErr ?? null,
    mapId,
    priorPose,
  };
}

export function modelsFromBundle(b: Pick<LocalizeBundle, "fixtures">): FixtureModel[] {
  return b.fixtures.map((f) => ({
    id: f.id,
    name: f.name,
    leds: new Map(f.leds.map(([id, x, y, z]) => [id, [x, y, z] as Vec3])),
    up: f.up,
    scaleRelStdErr: f.scaleRelStdErr,
  }));
}

/** Re-run the solve a bundle captured (deterministic: same input, same output). */
export function replayLocalizeBundle(b: Pick<LocalizeBundle, "fixtures" | "views" | "options">): LocalizeResult {
  return localizeFixtures(modelsFromBundle(b), b.views, b.options);
}

export function localizeOutcome(result: LocalizeResult | null, error: string | null): LocalizeOutcome {
  if (error !== null || result === null) return "failed";
  if (result.ok) return result.fixtures.some((f) => f.status === "weak") ? "partial" : "localized";
  return result.fixtures.some((f) => f.status === "localized" || f.status === "weak") ? "partial" : "failed";
}

export function localizeSummary(result: LocalizeResult | null, error: string | null, fixtures: number): string {
  if (error !== null) return `failed: ${error}`;
  if (result === null) return "no solve";
  const placed = result.fixtures.filter((f) => f.pose !== null).length;
  const weak = result.fixtures.filter((f) => f.status === "weak").length;
  return `${localizeOutcome(result, null)}: ${placed}/${fixtures} fixtures placed${weak ? `, ${weak} weak` : ""} · ${result.rmsPx.toFixed(2)} px`;
}

export interface LocalizeBundleInputs {
  id?: string;
  createdAt?: string;
  app: LocalizeBundle["app"];
  capture: LocalizeBundle["capture"];
  fixtures: LocalizeBundleFixture[];
  views: CaptureView[];
  options: LocalizeOptions;
  result: LocalizeResult | null;
  error: string | null;
}

export function buildLocalizeBundle(i: LocalizeBundleInputs): LocalizeBundle {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    format: LOCALIZE_BUNDLE_FORMAT,
    version: LOCALIZE_BUNDLE_VERSION,
    id: i.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `loc-${Date.now()}`),
    createdAt: i.createdAt ?? new Date().toISOString(),
    outcome: localizeOutcome(i.result, i.error),
    summary: localizeSummary(i.result, i.error, i.fixtures.length),
    app: i.app,
    device: deviceInfo(),
    capture: i.capture,
    fixtures: i.fixtures,
    // Sub-pixel to 0.01 px keeps the JSON small without changing the solve.
    views: i.views.map((v) => ({
      t: v.t,
      K: [...v.K] as Intrinsics,
      sightings: v.sightings.map((s) => ({ fixture: s.fixture, led: s.led, u: r2(s.u), v: r2(s.v) })),
    })),
    options: i.options,
    result: i.result,
    error: i.error,
    frames: [],
  };
}

export function isLocalizeBundle(b: unknown): b is LocalizeBundle {
  return !!b && typeof b === "object" && (b as { format?: unknown }).format === LOCALIZE_BUNDLE_FORMAT;
}
