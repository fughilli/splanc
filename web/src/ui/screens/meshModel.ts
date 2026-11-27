/**
 * What the device sheet's Mesh section shows, from the connected fixture's `get_mesh` and
 * the meshes this app administers (pure: no DOM, unit-tested).
 */

import { isBridgeFirmware, meshPeers, type MeshMemberInfo, type MeshPendingInfo, type MeshStateInfo } from "../../net/mesh";
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

/** What a Splanc bridge in the mesh is called when the app has no name for it (issue #697). */
export const BRIDGE_LABEL = "Splanc bridge";

/** A pending joiner's name: a bridge says it is one (its join's firmware marker). */
export function pendingLabel(p: MeshPendingInfo): string {
  return isBridgeFirmware(p.firmware) ? BRIDGE_LABEL : nodeLabel(p.node ?? 0);
}

function memberDetail(m: MeshMemberInfo, self: boolean): string {
  const parts: string[] = isBridgeFirmware(m.firmware) ? ["Bridge"] : [];
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
      name: self ? selfName : r?.label || (isBridgeFirmware(m.firmware) ? BRIDGE_LABEL : nodeLabel(m.node)),
      self,
      detail: memberDetail(m, self),
      synced: (m.sync ?? 0) >= 2,
      keyHash: r?.keyHash ?? null,
    };
  });
  const n = rows.length;
  // A bridge in the mesh (issue #697) is not a fixture: counted apart.
  const b = [selfState, ...meshPeers(s)].filter((m) => isBridgeFirmware(m.firmware)).length;
  const f = n - b;
  const status = `${f} fixture${f === 1 ? "" : "s"}${b ? (b === 1 ? " and the bridge" : ` and ${b} bridges`) : ""} · ${SYNC[s.sync ?? 0] ?? SYNC[0]}`;
  return {
    kind,
    meshName: kind === "dev" ? "Mesh" : kind === "foreign" ? "A mesh from another device" : meshName,
    status,
    members: rows,
    pending: kind === "admin" ? s.pending ?? [] : [],
    canControl: n > 1 && (kind === "dev" || (kind === "admin" && !!s.session)),
  };
}

/** One member's outcome in a whole-mesh change. */
export interface MeshResultRow {
  node: number;
  name: string;
  ok: boolean;
  text: string;
}

export interface MeshResultSummary {
  /** "Reached all 4 fixtures" / "Reached 3 of 4 fixtures". */
  line: string;
  rows: MeshResultRow[];
  allOk: boolean;
  /** Still waiting for some members (the firmware's timeout hasn't run out). */
  partial: boolean;
}

const MEMBER_STATUS = ["MESH_MEMBER_OK", "MESH_MEMBER_MISSING", "MESH_MEMBER_REFUSED", "MESH_MEMBER_FAILED"];

/** A pushed `mesh.result` (per-member answers to a whole-mesh change, e.g. an effect share)
 * as what the user needs: which fixtures got it and which didn't, and why. The connected
 * fixture's own answer (`gatewayStatus`) counts as one more row. */
export function meshResultSummary(
  r: { members?: { node: number; status?: string | number; latencyMs?: number }[]; complete?: boolean; gatewayStatus?: number },
  name: (node: number) => string,
  self?: { node: number; name: string },
): MeshResultSummary {
  const rows: MeshResultRow[] = [];
  if (self) {
    const ok = !r.gatewayStatus;
    rows.push({ node: self.node, name: self.name, ok, text: ok ? "Got it" : "Refused it" });
  }
  for (const m of r.members ?? []) {
    const st = typeof m.status === "number" ? (MEMBER_STATUS[m.status] ?? String(m.status)) : (m.status ?? "MESH_MEMBER_OK");
    const ok = st === "MESH_MEMBER_OK";
    const text = ok
      ? m.latencyMs
        ? `Got it in ${m.latencyMs} ms`
        : "Got it"
      : st === "MESH_MEMBER_MISSING"
        ? "Didn't answer in time"
        : st === "MESH_MEMBER_REFUSED"
          ? "Refused it"
          : "Couldn't apply it";
    rows.push({ node: m.node, name: name(m.node), ok, text });
  }
  const good = rows.filter((x) => x.ok).length;
  const n = rows.length;
  const allOk = n > 0 && good === n;
  return {
    line: n === 0 ? "No fixture answered" : allOk ? `Reached all ${n} fixtures` : `Reached ${good} of ${n} fixtures`,
    rows,
    allOk,
    partial: r.complete === false,
  };
}
