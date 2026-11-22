/**
 * What the device sheet's Mesh section shows, from the connected fixture's `get_mesh` and
 * the meshes this app administers (pure: no DOM, unit-tested).
 */

import { meshPeers, type MeshMemberInfo, type MeshPendingInfo, type MeshStateInfo } from "../../net/mesh";
import { isMemberOf } from "../../net/meshAdmin";
import type { MeshRecord } from "../../store/meshStore";

export type MeshSectionKind =
  /** Mesh firmware, not in a mesh: offer to create one / add it to one. */
  | "none"
  /** Provisioned, looking for its mesh or waiting to be admitted. */
  | "joining"
  /** A member of a mesh this app administers. */
  | "admin"
  /** A member of a closed mesh some other phone/browser administers. */
  | "foreign"
  /** A dev mesh (no admin key; M5 envelope trust). */
  | "dev";

export interface MeshMemberRow {
  node: number;
  name: string;
  self: boolean;
  /** "Time synced · −42 dBm · 80 fps". */
  detail: string;
  synced: boolean;
  /** Its device-key hash when this app knows it (what removing it needs). */
  keyHash: string | null;
}

export interface MeshSectionModel {
  kind: MeshSectionKind;
  meshName: string;
  /** One status line under the heading. */
  status: string;
  members: MeshMemberRow[];
  pending: MeshPendingInfo[];
  /** The "Control the whole mesh" switch works on this connection. */
  canControl: boolean;
}

const SYNC = ["time not synced yet", "syncing time", "time synced"];

export function nodeLabel(node: number): string {
  return `Fixture ${node.toString(16).toUpperCase().padStart(4, "0")}`;
}

function memberDetail(m: MeshMemberInfo, self: boolean): string {
  const parts: string[] = [];
  const sync = m.sync ?? 0;
  parts.push(sync >= 2 ? "Time synced" : sync === 1 ? "Syncing time" : "Not synced yet");
  if (self) parts.push("connected to this phone");
  else if (m.rssi) parts.push(`${m.rssi} dBm`);
  else parts.push("via another fixture");
  if (m.fps) parts.push(`${m.fps} fps`);
  return parts.join(" · ");
}

/** The section for `s` (the connected fixture's state), `rec` (this app's record of its
 * mesh, if any) and `selfName` (the connected fixture's name). */
export function meshSectionModel(s: MeshStateInfo | null, rec: MeshRecord | undefined, selfName: string): MeshSectionModel {
  const base: MeshSectionModel = { kind: "none", meshName: "", status: "", members: [], pending: [], canControl: false };
  if (!s || !s.on) {
    return { ...base, status: "Link this fixture with your other Splanc fixtures so they change together, on the same frame." };
  }
  const meshName = rec?.name ?? "Mesh";
  if (!isMemberOf(s)) {
    const waiting = s.phase === 2;
    return {
      ...base,
      kind: "joining",
      meshName,
      status: waiting ? `Waiting to be admitted to “${meshName}”` : `Looking for “${meshName}”…`,
    };
  }
  const closed = !!s.adminKey;
  const kind: MeshSectionKind = !closed ? "dev" : rec ? "admin" : "foreign";
  const byNode = new Map((rec?.members ?? []).map((m) => [m.node, m]));
  const selfState: MeshMemberInfo = { node: s.node ?? 0, sync: s.sync ?? 0, timeErrUs: s.timeErrUs ?? 0 };
  const rows: MeshMemberRow[] = [selfState, ...meshPeers(s)].map((m, i) => {
    const self = i === 0;
    const r = byNode.get(m.node);
    return {
      node: m.node,
      name: self ? selfName : r?.label || nodeLabel(m.node),
      self,
      detail: memberDetail(m, self),
      synced: (m.sync ?? 0) >= 2,
      keyHash: r?.keyHash ?? null,
    };
  });
  const n = rows.length;
  const status = `${n} fixture${n === 1 ? "" : "s"} · ${SYNC[s.sync ?? 0] ?? SYNC[0]}`;
  return {
    kind,
    meshName: kind === "dev" ? "Mesh" : kind === "foreign" ? "A mesh from another device" : meshName,
    status,
    members: rows,
    pending: kind === "admin" ? s.pending ?? [] : [],
    canControl: n > 1 && (kind === "dev" || (kind === "admin" && !!s.session)),
  };
}
