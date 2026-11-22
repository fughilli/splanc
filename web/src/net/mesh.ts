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
 * bigger than one mesh packet go through mesh effect sharing (`MeshLargeSender`, M6).
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
  // Membership (mesh M7).
  mode?: string | number;
  /** 0 unprovisioned, 1 searching, 2 waiting for approval, 3 member. */
  phase?: number;
  keyEpoch?: number;
  adminKey?: boolean;
  siteSecret?: boolean;
  /** This fixture's device key (what a grant names). */
  deviceKey?: Uint8Array;
  /** The admin session this connection unlocked (0: none) and its roster. */
  session?: number;
  roster?: number;
  pending?: MeshPendingInfo[];
  revoked?: number;
  groups?: number[];
  sessionsSynced?: number;
  /** Mesh time in seconds: what a grant's expiry is in. */
  meshS?: number;
}

/** A fixture waiting to join (approval: `admit`). */
export interface MeshPendingInfo {
  node?: number;
  keyHash?: Uint8Array;
  firmware?: number;
  heardBy?: number;
}

/** The answer to a `mesh_admin`. */
export interface MeshAdminResultInfo {
  op?: number;
  error?: string | number;
  value?: number;
  /** provision: the provisioner token (16 bytes, desk D-324). Keep it per fixture: it lets
   * this user leave or re-provision the fixture without an admin grant. */
  provisionerToken?: Uint8Array;
}

/** A `mesh` server message (MeshInfo oneof): a result, a state or an admin answer. */
export interface MeshInfoMessage {
  type: "mesh";
  result?: MeshResultInfo;
  state?: MeshStateInfo;
  admin?: MeshAdminResultInfo;
}

/** One `mesh_admin` operation (ledmapper.proto MeshAdmin, mesh M7). The app signs grants
 * and rotation orders with the admin secret (M8); this is the wire. */
export type MeshAdminOp =
  | { provision: { meshId: number; siteSecret?: Uint8Array; adminKey?: Uint8Array; mode?: number; channel?: number; groups?: number[]; provisionerToken?: Uint8Array } }
  | { unlock: { grant: Uint8Array } }
  | { admit: { node: number; keyHash: Uint8Array } }
  | { revoke: { order: Uint8Array; meshKey: Uint8Array; siteSecret: Uint8Array; exclude?: number[] } }
  | { leave: { provisionerToken?: Uint8Array } }
  | { groups: { node: number; groups: number[] } }
  | { eject: { node: number; keyHash: Uint8Array } };

const ADMIN_ERRORS: Record<string, string> = {
  MESH_ADMIN_BAD_REQUEST: "the fixture did not understand the request",
  MESH_ADMIN_LOCKED: "unlock the mesh with the admin secret first",
  MESH_ADMIN_LOCKED_OUT: "a wrong admin grant was just tried; wait 2 s",
  MESH_ADMIN_BAD_GRANT: "the admin grant was refused (another mesh's admin, or expired)",
  MESH_ADMIN_NO_MESH: "this fixture is not in a mesh",
  MESH_ADMIN_NO_MEMBERS: "no fixture has joined the admin session yet",
  MESH_ADMIN_BUSY: "the mesh is busy, try again",
  MESH_ADMIN_BAD_ORDER: "the key rotation was refused",
  MESH_ADMIN_UNSUPPORTED: "this fixture cannot do that",
};
const ADMIN_ERROR_NUM = ["", ...Object.keys(ADMIN_ERRORS)];

/** A `mesh_admin` answer's error as a sentence, or null when it was done. */
export function meshAdminError(r: MeshAdminResultInfo | undefined): string | null {
  if (!r || r.error === undefined || r.error === 0 || r.error === "MESH_ADMIN_OK") return null;
  const name = typeof r.error === "number" ? ADMIN_ERROR_NUM[r.error] ?? String(r.error) : r.error;
  return ADMIN_ERRORS[name] ?? name;
}

/** The `mesh_admin` client message for `op`. */
export function meshAdminMessage(op: MeshAdminOp): ClientMessage {
  return { type: "mesh_admin", ...op } as unknown as ClientMessage;
}

/** Live moves (seq'd, or any uniform write) go on arrival; discrete changes are scheduled. */
export function meshLeadMs(msg: { type: string; seq?: unknown }): number {
  if (msg.type === "set_uniforms" || msg.type === "blend_keypoints") return 0;
  if (msg.seq !== undefined && msg.seq !== null) return 0;
  return MESH_LEAD_MS;
}

/** Whether the gateway reports every member's answer (a pushed `mesh.result`, shown as
 * "Last change sent to the mesh"): for discrete changes (an effect switch, brightness, a
 * crossfade set once) and a slider's committed value, not for each move of a drag. The
 * gateway collects only a few operations at once (splanc_mesh::gateway::OPS), so a 30 Hz
 * drag asking for answers would finish them early, as missed. */
export function meshWantsReply(msg: { type: string; seq?: unknown; commit?: unknown }): boolean {
  if (msg.commit === true) return true;
  if (msg.type === "set_uniforms" || msg.type === "blend_keypoints") return msg.commit === undefined && msg.seq == null;
  return msg.seq === undefined || msg.seq === null;
}

/** `msg` wrapped for the whole mesh, or null when it is not relayable (it then goes to the
 * connected fixture alone): off the allow-list, or too big for one mesh packet. */
export function wrapForMesh(msg: ClientMessage, encode: (m: ClientMessage) => Uint8Array): ClientMessage | null {
  const flat = msg as unknown as { type: string; seq?: unknown; applyAtMs?: unknown; commit?: unknown };
  if (!MESH_RELAY_TYPES.has(flat.type)) return null;
  const inner = encode(msg);
  if (inner.length > MESH_INNER_MAX) return null;
  const lead = flat.applyAtMs === undefined ? meshLeadMs(flat) : 0;
  return {
    type: "mesh_send",
    opId: 0,
    targets: {},
    inner,
    wantReply: meshWantsReply(flat),
    ...(lead > 0 ? { leadMs: lead } : {}),
  } as unknown as ClientMessage;
}

/** How a message goes out under "Control the whole mesh": wrapped in one mesh packet,
 * shared as a large payload (an effect program bigger than one packet), or to the connected
 * fixture alone (not relayable). */
export type MeshRoute = { kind: "wrap"; wire: ClientMessage } | { kind: "large"; inner: Uint8Array } | { kind: "direct" };

export function meshRoute(msg: ClientMessage, encode: (m: ClientMessage) => Uint8Array): MeshRoute {
  const flat = msg as unknown as { type: string };
  if (!MESH_RELAY_TYPES.has(flat.type)) return { kind: "direct" };
  const wire = wrapForMesh(msg, encode);
  return wire ? { kind: "wrap", wire } : { kind: "large", inner: encode(msg) };
}

/** Delivers a relayable message too big for one mesh packet (an effect program) to every
 * member: mesh effect sharing (M6, firmware in progress). The connected fixture always gets
 * the message directly as well; the sharer gets it to the others. Pluggable so the app's
 * control paths stay the same when the firmware API lands. */
export interface MeshLargeSender {
  share(client: object, msg: ClientMessage, inner: Uint8Array): void;
}
let largeSender: MeshLargeSender | null = null;
export function setMeshLargeSender(s: MeshLargeSender | null): void {
  largeSender = s;
}
export function meshLargeSender(): MeshLargeSender | null {
  return largeSender;
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

/** Whether the player runs the mesh firmware variant: it advertises "mesh" in
 * welcome.features and answers get_mesh / mesh_send (desk #76). Other players don't know
 * the mesh arms at all, so the app never sends them one. */
export function deviceHasMesh(w: { features?: string[] } | null | undefined): boolean {
  return (w?.features ?? []).includes("mesh");
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
