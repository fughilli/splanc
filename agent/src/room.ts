/**
 * The room frame (docs/design/agent-multi-fixture.md §2): each fixture's map
 * lives in its own frame; a pose places it in its room's shared frame,
 * p_room = translation + scale * R(rotation) * p_map. Until the firmware can hold
 * a pose (the `fixture_pose` feature, which adds the `led.room` builtin), the hub
 * keeps poses in its config and uses them here: for room summaries, room-frame
 * previews and the agent's own reasoning. Unposed fixtures in a room are laid out
 * side by side along +x, flagged, so the agent knows to ask where they are.
 */

import type { MappingBundle } from "../../web/src/net/proto";
import type { Pose } from "./config";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const IDENTITY: Quat = [0, 0, 0, 1];

export function normQuat(q: Quat): Quat {
  const n = Math.hypot(...q);
  if (!(n > 0)) return IDENTITY;
  return q.map((x) => x / n) as Quat;
}

/** Rotate v by unit quaternion q ([x, y, z, w]). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function applyPose(p: Pose, v: Vec3): Vec3 {
  const r = rotate(normQuat(p.rotation), v);
  return [p.translation[0] + p.scale * r[0], p.translation[1] + p.scale * r[1], p.translation[2] + p.scale * r[2]];
}

/** A rotation about +y (up) by `deg` degrees, as a quaternion. */
export function yaw(deg: number): Quat {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export function bbox(points: Vec3[]): Box | null {
  if (points.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  return { min, max };
}

export interface FixtureInRoom {
  id: string;
  name: string;
  bundle: MappingBundle | null;
  pose?: Pose;
}

export interface PlacedFixture {
  id: string;
  name: string;
  /** The pose used: the stored one, or the side-by-side default. */
  pose: Pose;
  posed: boolean;
  /** LED positions in the room frame (map order). */
  points: Vec3[];
  box: Box | null;
}

/** Place every fixture of a room in the room frame. Fixtures with no pose are
 * laid out along +x after the posed ones, 0.5 m apart. */
export function placeFixtures(room: string, fixtures: FixtureInRoom[]): PlacedFixture[] {
  const out: PlacedFixture[] = [];
  let cursor = 0;
  const raw = (f: FixtureInRoom): Vec3[] => (f.bundle?.map?.leds ?? []).map((l) => [l.xyz[0]!, l.xyz[1]!, l.xyz[2]!]);
  for (const f of fixtures.filter((f) => f.pose)) {
    const pts = raw(f).map((v) => applyPose(f.pose!, v));
    const box = bbox(pts);
    if (box) cursor = Math.max(cursor, box.max[0] + 0.5);
    out.push({ id: f.id, name: f.name, pose: f.pose!, posed: true, points: pts, box });
  }
  for (const f of fixtures.filter((f) => !f.pose)) {
    const local = raw(f);
    const lb = bbox(local);
    const pose: Pose = {
      room,
      translation: [cursor - (lb?.min[0] ?? 0), 0, 0],
      rotation: IDENTITY,
      scale: 1,
    };
    const pts = local.map((v) => applyPose(pose, v));
    const box = bbox(pts);
    if (box) cursor = box.max[0] + 0.5;
    out.push({ id: f.id, name: f.name, pose, posed: false, points: pts, box });
  }
  return out;
}

const r3 = (v: number) => +v.toFixed(3);

export function summarizeRoom(room: string, placed: PlacedFixture[]): Record<string, unknown> {
  const all = bbox(placed.flatMap((p) => p.points));
  return {
    room,
    fixtures: placed.map((p) => ({
      id: p.id,
      name: p.name,
      leds: p.points.length,
      posed: p.posed,
      pose: { translation: p.pose.translation.map(r3), rotation: p.pose.rotation.map(r3), scale: p.pose.scale },
      bounding_box_m: p.box ? { min: p.box.min.map(r3), max: p.box.max.map(r3) } : null,
    })),
    total_leds: placed.reduce((s, p) => s + p.points.length, 0),
    bounding_box_m: all
      ? { min: all.min.map(r3), max: all.max.map(r3), size: all.max.map((m, k) => r3(m - all.min[k]!)) }
      : null,
    units: "meters",
    up_axis: "+y",
    ...(placed.some((p) => !p.posed)
      ? {
          note:
            "some fixtures have no pose yet and are shown side by side along +x: ask the user where they are " +
            "(use identify_player to tell them apart), then set_fixture_pose",
        }
      : {}),
  };
}
