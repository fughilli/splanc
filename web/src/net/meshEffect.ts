/**
 * Effect sharing over the mesh (docs/design/mesh-m6.md, mesh M6).
 *
 * An effect program of any size (up to the player's effect limit) goes to the connected
 * fixture inside one `mesh_send{inner: submit_effect}`. The fixture checks it as a load
 * would and answers like one (`result_ready{effectId}` or the error), shares it with every
 * member as a content-addressed blob, and once they all hold it, every fixture (the
 * connected one too) loads it on the same show-clock frame. Members that join or reboot
 * later get the current effect and its uniform values from the fixture the app is
 * connected to (catch-up). The aggregated per-member result is pushed as `mesh.result`
 * (op id = `opId`) to `client.onMeshResult` subscribers when `wantReply`.
 *
 * Too big for one transport window (BLE, or > 4 KiB on wss), the whole `mesh_send` goes
 * as `upload_chunk` windows of kind EFFECT, which the firmware reassembles and hands to the
 * mesh gateway.
 */

import type { ClientMessage } from "@ledmapper/protocol";

export interface MeshShareOptions {
  /** Make it the running effect (default true). */
  activate?: boolean;
  /** FX deck 0 = A (default), 1 = B. */
  deck?: number;
  /** Mesh node ids (at most 8); empty = every member. */
  nodes?: number[];
  /** A group (1..255) instead of nodes. */
  group?: number;
  /** The connected fixture loaded it already (the members only switch). */
  skipGateway?: boolean;
  /** How far ahead of "every member has it" the switch goes (0 = the firmware's 250 ms). */
  leadMs?: number;
  /** Collect per-member answers into a pushed `mesh.result` (default true). */
  wantReply?: boolean;
  /** How long members may take to fetch it before the switch (0 = 12 s). */
  timeoutMs?: number;
  /** The app's op id for the pushed result (0: the fixture picks one). */
  opId?: number;
}

/** The `mesh_send` that shares the encoded `submit_effect` frame `inner`. */
export function meshShareMessage(inner: Uint8Array, o: MeshShareOptions = {}): ClientMessage {
  const targets: Record<string, unknown> = {};
  if (o.nodes && o.nodes.length > 0) targets.nodes = o.nodes;
  if (o.group) targets.group = o.group;
  if (o.skipGateway) targets.skipGateway = true;
  return {
    type: "mesh_send",
    opId: o.opId ?? 0,
    targets,
    inner,
    wantReply: o.wantReply ?? true,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.leadMs ? { leadMs: o.leadMs } : {}),
  } as unknown as ClientMessage;
}

/** The `submit_effect` a share carries. */
export function meshEffectMessage(effectId: string, fxb: Uint8Array, o: MeshShareOptions = {}): ClientMessage {
  return {
    type: "submit_effect",
    effectId,
    fxb,
    activate: o.activate ?? true,
    deck: o.deck ?? 0,
  } as unknown as ClientMessage;
}

/** What {@link meshLargeShare} needs of a client (LedmapperClient has it). */
export interface MeshShareClient {
  meshShareEffect(effectId: string, fxb: Uint8Array, opts?: MeshShareOptions): Promise<unknown>;
}

/** For a message the app already sent to the connected fixture (it loaded it there): share
 * it with the other members only (`skipGateway`; they switch together, the connected one
 * switched on arrival). The app-UI's large-effect hook (`setMeshLargeSender`) calls this;
 * `client.submitEffect` with whole-mesh control on takes the frame-aligned path itself. */
export function meshLargeShare(client: object, msg: ClientMessage): Promise<unknown> | null {
  const m = msg as unknown as { type: string; effectId?: string; fxb?: Uint8Array; activate?: boolean; deck?: number };
  if (m.type !== "submit_effect" || !m.fxb) return null;
  return (client as MeshShareClient).meshShareEffect(m.effectId ?? "", m.fxb, { activate: m.activate ?? true, deck: m.deck ?? 0, skipGateway: true });
}
