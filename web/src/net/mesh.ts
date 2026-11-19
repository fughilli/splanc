/**
 * The mesh gateway from the app's side (docs/design/mesh.md §8–9, mesh M5).
 *
 * Any fixture the phone is connected to can relay control to the fixtures meshed with it:
 * `mesh_send` wraps one ordinary ClientMessage, the fixture applies it itself and floods it
 * to the others, and its direct reply is its own reply to that message, so every existing
 * request/response path keeps working. Discrete changes (effect, brightness, crossfade) are
 * scheduled `MESH_LEAD_MS` ahead on the mesh's show clock so every fixture changes on the
 * same frame; live slider moves go on arrival (they are superseded within milliseconds).
 *
 * Only the relay allow-list goes over the mesh (the firmware checks it too). Effect programs
 * bigger than one mesh packet reach only the connected fixture until effect sharing (M6).
 */

import type { ClientMessage } from "@ledmapper/protocol";

/** The ClientMessage types the firmware relays (splanc_mesh::gateway::RELAYED). */
export const MESH_RELAY_TYPES: ReadonlySet<string> = new Set([
  "set_effect",
  "set_uniforms",
  "set_brightness",
  "set_crossfade",
  "blend_keypoints",
  "submit_effect",
]);

/** How far ahead a discrete change is scheduled (≥ 150 ms per mesh hop, design §6.3). */
export const MESH_LEAD_MS = 150;

/** The largest encoded inner message one mesh packet carries (200 B payload less the
 * session, control and protobuf headers). */
export const MESH_INNER_MAX = 160;

export interface MeshMemberInfo {
  node: number;
  rssi?: number;
  seenMsAgo?: number;
  firmware?: number;
  uptimeS?: number;
  fps?: number;
  heapFree?: number;
  heapMin?: number;
  brightness?: number;
  sync?: number;
  timeErrUs?: number;
  lastError?: number;
  lastErrorOp?: number;
}

export interface MeshMemberResultInfo {
  node: number;
  status?: string | number;
  code?: number;
  latencyMs?: number;
}

export interface MeshResultInfo {
  opId?: number;
  error?: string | number;
  members?: MeshMemberResultInfo[];
  complete?: boolean;
  applyAtMs?: number;
  gatewayStatus?: number;
}

export interface MeshStateInfo {
  on?: boolean;
  member?: boolean;
  node?: number;
  meshId?: number;
  channel?: number;
  gateway?: boolean;
  envelopeTrust?: boolean;
  sync?: number;
  timeErrUs?: number;
  epochGen?: number;
  members?: MeshMemberInfo[];
  lastResult?: MeshResultInfo;
}

/** A `mesh` server message (MeshInfo oneof): a result or a state. */
export interface MeshInfoMessage {
  type: "mesh";
  result?: MeshResultInfo;
  state?: MeshStateInfo;
}

/** Live moves (seq'd, or any uniform write) go on arrival; discrete changes are scheduled. */
export function meshLeadMs(msg: { type: string; seq?: unknown }): number {
  if (msg.type === "set_uniforms" || msg.type === "blend_keypoints") return 0;
  if (msg.seq !== undefined && msg.seq !== null) return 0;
  return MESH_LEAD_MS;
}

/** `msg` wrapped for the whole mesh, or null when it is not relayable (it then goes to the
 * connected fixture alone): off the allow-list, or too big for one mesh packet. */
export function wrapForMesh(msg: ClientMessage, encode: (m: ClientMessage) => Uint8Array): ClientMessage | null {
  const flat = msg as unknown as { type: string; seq?: unknown; applyAtMs?: unknown };
  if (!MESH_RELAY_TYPES.has(flat.type)) return null;
  const inner = encode(msg);
  if (inner.length > MESH_INNER_MAX) return null;
  const lead = flat.applyAtMs === undefined ? meshLeadMs(flat) : 0;
  return {
    type: "mesh_send",
    opId: 0,
    targets: {},
    inner,
    wantReply: false,
    ...(lead > 0 ? { leadMs: lead } : {}),
  } as unknown as ClientMessage;
}

const SEND_ERRORS: Record<string, string> = {
  MESH_SEND_NO_MESH: "this fixture is not in a mesh",
  MESH_SEND_NOT_ALLOWED: "that change cannot be sent over the mesh",
  MESH_SEND_TOO_BIG: "too big to send over the mesh",
  MESH_SEND_BUSY: "the mesh is busy, try again",
  MESH_SEND_LOCKED: "this connection cannot control the mesh",
  MESH_SEND_BAD_REQUEST: "the fixture did not understand the request",
};
const SEND_ERROR_NUM = ["", "MESH_SEND_NO_MESH", "MESH_SEND_NOT_ALLOWED", "MESH_SEND_TOO_BIG", "MESH_SEND_BUSY", "MESH_SEND_LOCKED", "MESH_SEND_BAD_REQUEST"];

/** A result's gateway-level error as a sentence, or null when it went out. */
export function meshResultError(r: MeshResultInfo | undefined): string | null {
  if (!r || r.error === undefined || r.error === 0 || r.error === "MESH_SEND_OK") return null;
  const name = typeof r.error === "number" ? SEND_ERROR_NUM[r.error] ?? String(r.error) : r.error;
  return SEND_ERRORS[name] ?? name;
}

/** The fixtures meshed with the connected one (it never lists itself). */
export function meshPeers(s: MeshStateInfo | null | undefined): MeshMemberInfo[] {
  if (!s || !s.on || !s.member) return [];
  return (s.members ?? []).filter((m) => m.node !== s.node);
}

const SYNC_TEXT = ["time not synced yet", "syncing time", "time synced"];

/** One line for the device card: "Meshed with 2 fixtures · time synced", or null. */
export function meshSummary(s: MeshStateInfo | null | undefined): string | null {
  const peers = meshPeers(s);
  if (!s || !s.member || peers.length === 0) return null;
  const n = peers.length;
  return `Meshed with ${n} other fixture${n === 1 ? "" : "s"} · ${SYNC_TEXT[s.sync ?? 0] ?? SYNC_TEXT[0]}`;
}
