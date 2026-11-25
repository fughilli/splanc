/**
 * Mesh administration from the app (mesh M7 wire, M8 flows; docs/design/mesh-m7.md "How a
 * person adds a fixture to a closed mesh"): provision a fixture into a mesh, unlock the
 * connected fixture as the gateway with a signed grant, admit a pending joiner, remove a
 * fixture (eject, or revoke for good) — each a few `mesh_admin` / `get_mesh` round trips on
 * whatever connection the app has to that fixture (wss or BLE; the client hides which).
 *
 * The secrets come from store/meshStore.ts and are never logged; site secrets are zeroed
 * once sent.
 */

import { meshAdminError, type MeshAdminOp, type MeshAdminResultInfo, type MeshPendingInfo, type MeshStateInfo } from "./mesh";
import { decodeDelegation, keyHash, NO_EXPIRY, ORDER_REVOKED, randomBytes, randomU32, signGrant, signRekeyOrder, toHex, type MeshAdminSigner } from "./meshKeys";
import type { MeshMemberRecord, MeshRecord } from "../store/meshStore";

/** What these operations need of a connection (LedMapperClient has it). */
export interface MeshAdminClient {
  getMesh(timeoutMs?: number): Promise<MeshStateInfo>;
  meshAdmin(op: MeshAdminOp, timeoutMs?: number): Promise<MeshAdminResultInfo>;
}

/** A fixture's refusal, as a sentence (`code` is the MeshAdminError name). */
export class MeshAdminFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MeshAdminFailure";
  }
}

function errName(r: MeshAdminResultInfo): string {
  return typeof r.error === "string" ? r.error : String(r.error ?? "");
}

async function admin(c: MeshAdminClient, op: MeshAdminOp, timeoutMs?: number): Promise<MeshAdminResultInfo> {
  const r = await c.meshAdmin(op, timeoutMs);
  const err = meshAdminError(r);
  if (err !== null) throw new MeshAdminFailure(err, errName(r));
  return r;
}

/** Phase names (MeshState.phase). */
export const MESH_PHASE = { off: 0, searching: 1, joining: 2, member: 3 } as const;

/** A fixture is in `meshId` (or any mesh) as a member. */
export function isMemberOf(s: MeshStateInfo | null | undefined, meshId?: number): boolean {
  if (!s || !s.on || !s.member) return false;
  return meshId === undefined || (s.meshId ?? 0) >>> 0 === meshId >>> 0;
}

/** The mesh holds an admin key, so it needs this app's grant to be administered. */
export function isClosedMesh(s: MeshStateInfo | null | undefined): boolean {
  return !!s?.on && !!s.adminKey;
}

// -- provision -------------------------------------------------------------------------

export interface ProvisionResult {
  state: MeshStateInfo;
  member: Omit<MeshMemberRecord, "deviceId" | "label">;
  /** The fixture's provisioner token (16 B, desk D-324): lets this app take it out of the
   * mesh (leave, re-provision) without a grant. Null on firmware that issues none. */
  provisionerToken: Uint8Array | null;
}

/** Put the connected fixture in `mesh` (with the site secret: it joins by itself within
 * ~5 s), then read back its node id and device key for the roster. Throws MeshAdminFailure
 * on a refusal (e.g. LOCKED: it already belongs to a mesh with another admin). */
export async function provisionFixture(
  c: MeshAdminClient,
  mesh: Pick<MeshRecord, "meshId" | "adminPublic">,
  siteSecret: Uint8Array | null,
): Promise<ProvisionResult> {
  const ans = await admin(c, {
    provision: {
      meshId: mesh.meshId >>> 0,
      ...(siteSecret ? { siteSecret } : {}),
      adminKey: mesh.adminPublic,
    },
  });
  // The node id is the fixture's own (from its device key); ask until the mesh reports it.
  let state: MeshStateInfo = {};
  for (let i = 0; i < 6; i++) {
    state = await c.getMesh();
    if (state.on && state.node && state.deviceKey && state.deviceKey.length === 65) break;
    await sleep(250);
  }
  if (!state.node || !state.deviceKey || state.deviceKey.length !== 65) {
    throw new MeshAdminFailure("the fixture turned its mesh on but did not report its key", "NO_KEY");
  }
  const tok = ans.provisionerToken;
  return {
    state,
    member: { node: state.node, keyHash: toHex(await keyHash(state.deviceKey)) },
    provisionerToken: tok && tok.length === 16 ? tok : null,
  };
}

/** Poll until the connected fixture is a member of `meshId` (or `timeoutMs` passes). */
export async function waitForMember(
  c: MeshAdminClient,
  meshId: number,
  opts: { timeoutMs?: number; intervalMs?: number; onState?: (s: MeshStateInfo) => void; aborted?: () => boolean } = {},
): Promise<MeshStateInfo> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (;;) {
    // A fixture that is turning its mesh on can be slow to answer one poll (a P4 lamp's
    // C6 front end builds the mesh and saves its state meanwhile): a timed-out poll is
    // retried until the deadline rather than failing a join that is going fine.
    let s: MeshStateInfo;
    try {
      s = await c.getMesh();
    } catch (e) {
      if ((e as Error)?.name !== "RequestTimeoutError" || Date.now() > deadline || opts.aborted?.()) throw e;
      continue;
    }
    opts.onState?.(s);
    if (isMemberOf(s, meshId)) return s;
    if (Date.now() > deadline || opts.aborted?.()) return s;
    await sleep(opts.intervalMs ?? 1000);
  }
}

// -- unlock ----------------------------------------------------------------------------

/** How long a grant is good for, in mesh seconds (renewed well before). */
export const GRANT_TTL_S = 8 * 3600;
/** Renew this long before a grant runs out. */
export const GRANT_RENEW_S = 15 * 60;

export interface Unlocked {
  session: number;
  notAfter: number;
}

/** Sign a grant for the connected fixture and present it: this connection may then
 * administer the mesh and command it as its gateway (until it drops or the grant expires). */
export async function unlockFixture(
  c: MeshAdminClient,
  signer: MeshAdminSigner,
  meshId: number,
  state?: MeshStateInfo,
  opts: { session?: number; ttlS?: number; delegation?: Uint8Array | null } = {},
): Promise<Unlocked> {
  const s = state ?? (await c.getMesh());
  if (!s.on || !s.node || !s.deviceKey || s.deviceKey.length !== 65) {
    throw new MeshAdminFailure("this fixture is not in a mesh yet", "MESH_ADMIN_NO_MESH");
  }
  const session = opts.session ?? randomU32();
  const meshS = s.meshS ?? 0;
  let notAfter = (meshS + (opts.ttlS ?? GRANT_TTL_S)) >>> 0;
  // A delegate (revocable access, docs/design/share-links.md): its grants name it and never
  // outlive its certificate, which goes along for the gateway to check and pass on.
  const cert = opts.delegation ? decodeDelegation(opts.delegation) : null;
  if (opts.delegation && !cert) throw new MeshAdminFailure("the shared access on this phone is damaged", "MESH_ADMIN_BAD_GRANT");
  if (cert && cert.notAfter !== NO_EXPIRY) {
    if (cert.notAfter <= meshS) throw new MeshAdminFailure("the access shared with you has expired", "MESH_ADMIN_BAD_GRANT");
    notAfter = Math.min(notAfter, cert.notAfter) >>> 0;
  }
  const fields = { meshId: meshId >>> 0, session, gateway: s.node, gatewayKey: s.deviceKey, notAfter };
  const grant = cert ? await signGrant(signer, fields, { by: await keyHash(signer.publicKey) }) : await signGrant(signer, fields);
  const r = await admin(c, { unlock: cert ? { grant, delegation: opts.delegation! } : { grant } });
  return { session: r.value || session, notAfter };
}

const unlockedBy = new WeakMap<object, Unlocked & { meshId: number }>();

/** The grant this app presented on `c` (null: none yet). */
export function unlockedSession(c: object): (Unlocked & { meshId: number }) | null {
  return unlockedBy.get(c) ?? null;
}

/** Unlock `c` if its fixture is in a mesh this app administers and the connection holds no
 * live session (or one about to expire). Quiet: returns false when there is nothing to do or
 * the fixture refused (the caller shows the state it reads). */
export async function ensureUnlocked(
  c: MeshAdminClient & object,
  lookup: (meshId: number) => Promise<{ signer: MeshAdminSigner; delegation?: Uint8Array | null } | null>,
  state?: MeshStateInfo,
): Promise<boolean> {
  const s = state ?? (await c.getMesh());
  if (!isMemberOf(s) || !s.adminKey) return false;
  const meshId = (s.meshId ?? 0) >>> 0;
  const held = unlockedBy.get(c);
  const live = !!s.session && held !== undefined && held.session === s.session && held.meshId === meshId;
  if (live && (s.meshS ?? 0) + GRANT_RENEW_S < held.notAfter) return true;
  const k = await lookup(meshId);
  if (!k) return false;
  try {
    const u = await unlockFixture(c, k.signer, meshId, s, { delegation: k.delegation ?? null });
    unlockedBy.set(c, { ...u, meshId });
    return true;
  } catch {
    return false;
  }
}

// -- admit / remove --------------------------------------------------------------------

/** Admit a fixture waiting to join (MeshState.pending), through the unlocked gateway. */
export async function admitPending(c: MeshAdminClient, p: MeshPendingInfo): Promise<void> {
  if (!p.node || !p.keyHash) throw new MeshAdminFailure("that fixture did not say who it is", "MESH_ADMIN_BAD_REQUEST");
  await admin(c, { admit: { node: p.node, keyHash: p.keyHash } });
}

/** Send one member out of the mesh (it forgets it and turns its mesh off; it can be added
 * again). Through the unlocked gateway. */
export async function ejectMember(c: MeshAdminClient, node: number, keyHashHex: string): Promise<void> {
  await admin(c, { eject: { node, keyHash: fromHex8(keyHashHex) } });
}

/** The connected fixture leaves its mesh: with its provisioner token (D-324), or on a
 * connection unlocked with a grant. */
export async function leaveMesh(c: MeshAdminClient, provisionerToken?: Uint8Array | null): Promise<void> {
  await admin(c, { leave: provisionerToken ? { provisionerToken } : {} });
}

export interface Rotation {
  keyEpoch: number;
  revVersion: number;
  siteSecret: Uint8Array;
  revoked: string[];
  nodes: number[];
  /** The order started a fresh revocation list (D-443): the store replaces, not merges. */
  replaced?: boolean;
}

/** The firmware's revocation list (rekey.rs REVOKED_MAX) and the order flag that replaces it
 * (REV_REPLACE). Desk D-443: the list never fills. Every block already rolls the mesh key and
 * site secret for the remaining members, so once the list nears capacity the next block starts
 * a fresh one holding only the newly blocked fixtures; the older ones keep only a dead key. */
export const REVOKED_MAX = 8;
export const REV_REPLACE = 0x8000;

/** Whether this block starts a fresh list: the stored entries plus the new ones would leave
 * fewer than two free slots. */
export function revocationReplaces(stored: number, adding: number): boolean {
  return stored + adding > REVOKED_MAX - 2;
}

/** Remove fixtures for good: a signed rotation to a new mesh key and site secret that leaves
 * them out, with their device keys on the revocation list. Resolves with what the store
 * must now keep (the new site secret: the caller saves it, then zeroes it). */
export async function revokeMembers(
  c: MeshAdminClient,
  signer: MeshAdminSigner,
  mesh: Pick<MeshRecord, "meshId" | "keyEpoch" | "revVersion"> & { revoked?: string[] },
  out: { node: number; keyHash: string }[],
  state?: MeshStateInfo,
  /** Revoked delegates still able to sign (not expired): a fresh list (D-443) carries them
   * again, or they would work again (docs/design/share-links.md). */
  keep: string[] = [],
): Promise<Rotation> {
  const s = state ?? (await c.getMesh());
  const epoch = (((s.keyEpoch ?? mesh.keyEpoch) + 1) & 0xff) || 1;
  const revVersion = ((mesh.revVersion & 0x7fff) + 1) & 0x7fff || 1;
  const stored = Math.max(s.revoked ?? 0, mesh.revoked?.length ?? 0);
  const replaced = revocationReplaces(stored, out.length);
  const hashes = [...new Set([...out.map((m) => m.keyHash), ...(replaced ? keep : [])])];
  if (hashes.length > ORDER_REVOKED) {
    throw new MeshAdminFailure(`at most ${ORDER_REVOKED} fixtures or people per removal`, "MESH_ADMIN_BAD_REQUEST");
  }
  const meshKey = randomBytes(16);
  const siteSecret = randomBytes(32);
  const order = await signRekeyOrder(signer, {
    meshId: mesh.meshId >>> 0,
    epoch,
    meshKey,
    siteSecret,
    revVersion: replaced ? revVersion | REV_REPLACE : revVersion,
    revoked: hashes.map(fromHex8),
  });
  // A delegate (node 0) is no fixture: nothing to exclude from the wraps.
  const nodes = out.map((m) => m.node).filter((n) => n > 0);
  try {
    await admin(c, { revoke: { order, meshKey, siteSecret, exclude: nodes } }, 10_000);
  } finally {
    meshKey.fill(0);
  }
  return { keyEpoch: epoch, revVersion, siteSecret, revoked: hashes, nodes, replaced };
}

function fromHex8(h: string): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16) || 0;
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
