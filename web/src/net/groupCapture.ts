/**
 * Group capture orchestration for multi-fixture localization
 * (docs/design/multi-fixture-localization.md §4): read every selected fixture's
 * map + capture profile, ARM them all on one shared epoch with disjoint code
 * ranges, (the phone films), stop them, and write the solved poses back.
 *
 * Two transports, one contract ({@link GroupTransport}):
 *   - {@link BridgeGroupTransport}: through a Splanc bridge (live VJ
 *     multiplexer, #317) — the bridge already holds every player's one socket,
 *     so arming is a single `group_capture` query and the bridge aligns the
 *     epoch with its own LAN clock syncs;
 *   - {@link DirectGroupTransport}: no bridge — connect to each fixture IN TURN
 *     (each serves one TLS socket; the app holds one at a time), sync its clock,
 *     start its pattern on the shared epoch expressed in that fixture's clock,
 *     disconnect. The pattern keeps running without the socket (firmware
 *     group_capture), so all fixtures flash together while the phone films.
 *
 * The capture itself needs NO connection: the phone decodes the shared code
 * book on its own clock (the epoch is phone-local time E).
 */

import type { CodeParams, OutputMap } from "@ledmapper/protocol";
import type { LedMapperClient } from "./client";
import type { FixturePoseFlat, MappingBundle } from "./proto";
import type { BridgeLiveClient } from "./bridgeLive";
import { deviceEpochMs, type CaptureProfileLike } from "../geom/groupCode";

/** What a fixture tells us before a group capture. */
export interface GroupMemberInfo {
  id: string;
  name: string;
  features: string[];
  /** Physical LEDs (its map's ledCount, else the device's configured count). */
  ledCount: number;
  /** Its stored map (null: none — it can't be localized until it is mapped). */
  map: OutputMap | null;
  /** Its stored room pose (null: unposed). */
  pose: FixturePoseFlat | null;
  /** Its stored capture profile when the firmware has one (sensor stack). */
  profile: CaptureProfileLike | null;
  error?: string;
}

export interface MemberPlan {
  id: string;
  /** StartMappingOptions (camelCase wire shape) incl. ledCount + group fields, no epoch. */
  options: Record<string, number>;
}

export interface ArmResult {
  /** The shared pattern epoch on the PHONE's clock (performance.now() ms). */
  epochLocalMs: number;
  /** The shared code params (identical across members; the first's echo). */
  codeParams: CodeParams | null;
  members: { id: string; ok: boolean; error?: string; skewBoundMs?: number }[];
}

export interface GroupTransport {
  readonly kind: "bridge" | "direct";
  prepare(onProgress?: (done: number, total: number, name: string) => void): Promise<GroupMemberInfo[]>;
  start(plans: MemberPlan[], onProgress?: (done: number, total: number) => void): Promise<ArmResult>;
  stop(): Promise<void>;
  setPoses(poses: { id: string; pose: FixturePoseFlat | null }[]): Promise<{ id: string; ok: boolean; error?: string }[]>;
}

/** The epoch is set slightly in the PAST: a past epoch just phase-aligns the
 * running pattern, so later-armed fixtures join the same frame grid. */
export const EPOCH_LEAD_MS = 1000;

/** True when every member's echoed code params agree (one decoder reads all). */
export function sameCode(a: CodeParams, b: CodeParams): boolean {
  return a.ledCount === b.ledCount && a.bits === b.bits && a.symbols === b.symbols && a.cycleFrames === b.cycleFrames && a.bitPeriodMs === b.bitPeriodMs;
}

// ---------------------------------------------------------------------------
// Direct (no bridge): one fixture at a time
// ---------------------------------------------------------------------------

export interface DirectDevice {
  id: string;
  name: string;
  wssUrl: string;
}

/** Opens a connected client to a device (reusing the app's own when it is that
 * device) and how to release it. */
export type DirectOpener = (dev: DirectDevice) => Promise<{ client: LedMapperClient; release: () => void }>;

export class DirectGroupTransport implements GroupTransport {
  readonly kind = "direct" as const;
  constructor(
    private readonly devices: readonly DirectDevice[],
    private readonly open: DirectOpener,
    private readonly now: () => number = () => performance.now(),
  ) {}

  private async with<T>(dev: DirectDevice, fn: (c: LedMapperClient) => Promise<T>): Promise<T> {
    const { client, release } = await this.open(dev);
    try {
      return await fn(client);
    } finally {
      release();
    }
  }

  async prepare(onProgress?: (done: number, total: number, name: string) => void): Promise<GroupMemberInfo[]> {
    const out: GroupMemberInfo[] = [];
    for (const [i, dev] of this.devices.entries()) {
      onProgress?.(i, this.devices.length, dev.name);
      try {
        out.push(await this.with(dev, (c) => readMember(dev, c)));
      } catch (e) {
        out.push({ id: dev.id, name: dev.name, features: [], ledCount: 0, map: null, pose: null, profile: null, error: String((e as Error).message ?? e) });
      }
    }
    onProgress?.(this.devices.length, this.devices.length, "");
    return out;
  }

  async start(plans: MemberPlan[], onProgress?: (done: number, total: number) => void): Promise<ArmResult> {
    const E = Math.round(this.now() - EPOCH_LEAD_MS);
    const res: ArmResult = { epochLocalMs: E, codeParams: null, members: [] };
    for (const [i, plan] of plans.entries()) {
      onProgress?.(i, plans.length);
      const dev = this.devices.find((d) => d.id === plan.id);
      if (!dev) {
        res.members.push({ id: plan.id, ok: false, error: "unknown device" });
        continue;
      }
      try {
        const r = await this.with(dev, async (c) => {
          const sync = await c.syncClock(8);
          const { ledCount, ...rest } = plan.options;
          const started = await c.startMapping(ledCount!, { ...rest, epochMs: deviceEpochMs(E, sync.offsetMs) });
          return { cp: started.codeParams, skew: Math.max(0, sync.rttMs) / 2 };
        });
        if (res.codeParams === null) res.codeParams = r.cp;
        else if (!sameCode(res.codeParams, r.cp)) throw new Error("its code book differs from the group's (firmware too old?)");
        res.members.push({ id: plan.id, ok: true, skewBoundMs: r.skew });
      } catch (e) {
        res.members.push({ id: plan.id, ok: false, error: String((e as Error).message ?? e) });
      }
    }
    onProgress?.(plans.length, plans.length);
    return res;
  }

  async stop(): Promise<void> {
    for (const dev of this.devices) {
      await this.with(dev, (c) => c.stopMappingNoSolve().then(() => undefined)).catch(() => undefined);
    }
  }

  async setPoses(poses: { id: string; pose: FixturePoseFlat | null }[]) {
    const out: { id: string; ok: boolean; error?: string }[] = [];
    for (const p of poses) {
      const dev = this.devices.find((d) => d.id === p.id);
      if (!dev) {
        out.push({ id: p.id, ok: false, error: "unknown device" });
        continue;
      }
      try {
        await this.with(dev, async (c) => {
          if (!(c.welcome?.features ?? []).includes("fixture_pose")) throw new Error("firmware can't store a pose (update it)");
          await c.setFixturePose(p.pose, true);
        });
        out.push({ id: p.id, ok: true });
      } catch (e) {
        out.push({ id: p.id, ok: false, error: String((e as Error).message ?? e) });
      }
    }
    return out;
  }
}

/** Read one fixture's identity, stored map, pose and capture profile. */
async function readMember(dev: DirectDevice, c: LedMapperClient): Promise<GroupMemberInfo> {
  const w = c.welcome;
  const features = w?.features ?? [];
  let map: OutputMap | null = null;
  if (features.includes("stored_map")) {
    map = await c.pullStoredMap().then((b: MappingBundle) => b.map ?? null, () => null);
  }
  // Capture profile (sensor stack: get_capture_profile, feature "capture_profile");
  // duck-typed so this builds before that client method exists.
  let profile: CaptureProfileLike | null = null;
  const gp = (c as unknown as { getCaptureProfile?: () => Promise<CaptureProfileLike> }).getCaptureProfile;
  if (features.includes("capture_profile") && typeof gp === "function") {
    profile = await gp.call(c).then(
      (p) => (p && (!map || !p.mapId || p.mapId === map.mapId) ? p : null),
      () => null,
    );
  }
  const pose = (w as unknown as { pose?: FixturePoseFlat } | null)?.pose ?? null;
  return {
    id: dev.id,
    name: w?.deviceName || dev.name,
    features,
    ledCount: map?.ledCount || w?.codeParams?.ledCount || 0,
    map,
    pose: pose && pose.translation?.length === 3 ? pose : null,
    profile,
  };
}

// ---------------------------------------------------------------------------
// Through a bridge (live VJ multiplexer)
// ---------------------------------------------------------------------------

/**
 * The `group_capture` live query (agent/src/bridge/live.ts):
 *   {action: "prepare", to}            -> results[]: {name, features, led_count, map, pose, profile}
 *   {action: "start", members:[{to, options}], epoch_lead_ms}
 *                                      -> data: {hub_epoch_ms, hub_now_ms}, results[]: {code_params, skew_bound_ms}
 *   {action: "stop", to}               -> results[]
 *   {action: "set_pose", poses:[{to, pose|null}]} -> results[]
 * Clock: the bridge picks the epoch on ITS clock and converts it per player with
 * its own (LAN) syncs; the app maps it to its clock from the reply's hub_now
 * (error <= half the app↔bridge round trip, common to all fixtures — the
 * decoder's self-clocking alignment absorbs a common offset).
 */
export class BridgeGroupTransport implements GroupTransport {
  readonly kind = "bridge" as const;
  constructor(
    private readonly bridge: Pick<BridgeLiveClient, "query">,
    private readonly ids: readonly string[],
    private readonly now: () => number = () => performance.now(),
  ) {}

  async prepare(): Promise<GroupMemberInfo[]> {
    const r = await this.bridge.query("group_capture", { action: "prepare" }, [...this.ids]);
    if (!r.ok) throw new Error(r.error ?? "the bridge refused group_capture (update it)");
    return (r.results ?? []).map((p) => {
      const v = (p.result ?? {}) as {
        name?: string;
        features?: string[];
        led_count?: number;
        map?: OutputMap | null;
        pose?: FixturePoseFlat | null;
        profile?: CaptureProfileLike | null;
      };
      return {
        id: p.player.id,
        name: v.name ?? p.player.name,
        features: v.features ?? [],
        ledCount: v.led_count ?? v.map?.ledCount ?? 0,
        map: v.map ?? null,
        pose: v.pose ?? null,
        profile: v.profile ?? null,
        ...(p.ok ? {} : { error: p.error ?? "failed" }),
      };
    });
  }

  async start(plans: MemberPlan[]): Promise<ArmResult> {
    const t0 = this.now();
    const r = await this.bridge.query("group_capture", {
      action: "start",
      epoch_lead_ms: EPOCH_LEAD_MS,
      members: plans.map((p) => ({ to: p.id, options: p.options })),
    });
    const t1 = this.now();
    if (!r.ok) throw new Error(r.error ?? "group_capture start failed");
    const d = (r.data ?? {}) as { hub_epoch_ms?: number; hub_now_ms?: number };
    // hub_now was read when the reply left the bridge: ≈ the midpoint here.
    const offset = (d.hub_now_ms ?? 0) - (t0 + t1) / 2;
    const epochLocalMs = (d.hub_epoch_ms ?? 0) - offset;
    let codeParams: CodeParams | null = null;
    const members = (r.results ?? []).map((p) => {
      const v = (p.result ?? {}) as { code_params?: CodeParams; skew_bound_ms?: number };
      if (p.ok && v.code_params && codeParams === null) codeParams = v.code_params;
      return { id: p.player.id, ok: p.ok, ...(p.error ? { error: p.error } : {}), ...(v.skew_bound_ms !== undefined ? { skewBoundMs: v.skew_bound_ms } : {}) };
    });
    return { epochLocalMs, codeParams, members };
  }

  async stop(): Promise<void> {
    await this.bridge.query("group_capture", { action: "stop" }, [...this.ids]).catch(() => undefined);
  }

  async setPoses(poses: { id: string; pose: FixturePoseFlat | null }[]) {
    const r = await this.bridge.query("group_capture", {
      action: "set_pose",
      poses: poses.map((p) => ({ to: p.id, pose: p.pose })),
    });
    if (!r.ok) throw new Error(r.error ?? "set_pose failed");
    return (r.results ?? []).map((p) => ({ id: p.player.id, ok: p.ok, ...(p.error ? { error: p.error } : {}) }));
  }
}
