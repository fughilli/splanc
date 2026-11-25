/**
 * The meshes this app administers (mesh M7/M8; docs/design/mesh-m7.md "How a person adds a
 * fixture"). One record per mesh the user created here:
 *
 *  - the mesh id and the user's name for it;
 *  - the admin secret (16 B, desk D-442): the P-256 admin key derives from it
 *    (net/meshKeys.ts adminSignerFromSecret, as mesh_admin_tool does), so the mesh can be
 *    backed up and administered from a second phone (exportBackup / importBackup). It is
 *    sealed like the site secret; fixtures get only the key's public half;
 *  - the site secret (32 B; it lets the user's own fixtures join by themselves), sealed with
 *    AES-GCM under a second non-extractable key kept beside it, so the plaintext never sits
 *    in storage (localStorage, backups, a diagnostics export);
 *  - the roster the app learned while provisioning: which saved device is which mesh node
 *    and its device-key hash (what eject and revoke name), and the key epoch / revocation
 *    version the next rotation must exceed.
 *
 * Nothing here is ever logged. The store reads IndexedDB lazily (CJS-safe for node:test, which
 * swaps in the memory backend).
 */

import {
  adminSignerFromSecret,
  decodeDelegation,
  keyHash,
  NO_EXPIRY,
  signDelegation,
  verifyAdminSignature,
  delegationSignedBytes,
  fromHex,
  randomBytes,
  randomU32,
  toHex,
  webCryptoSigner,
  type MeshAdminSigner,
} from "../net/meshKeys";

/** A fixture the app put in a mesh (or admitted into it). */
export interface MeshMemberRecord {
  /** The saved device (deviceStore id); "" for one admitted from the pending list. */
  deviceId: string;
  label: string;
  /** Its mesh node id (MeshState.node). */
  node: number;
  /** SHA-256(device key)[..8], hex. */
  keyHash: string;
}

/** What screens see of a mesh (no secrets). */
/** Someone the owner shared revocable access with (docs/design/share-links.md). */
export interface DelegateRecord {
  /** The delegate key's hash (hex): what its grants name and a revocation lists. */
  keyHash: string;
  /** Who it is for, as the owner typed it. */
  label: string;
  issuedAt: string;
  /** Its expiry on the wall clock (ISO; absent: until revoked). */
  expiresAt?: string;
  /** Revoked by a key rotation (it stays listed so later rotations keep it revoked). */
  revoked?: boolean;
}

export interface MeshRecord {
  meshId: number;
  name: string;
  createdAt: string;
  /** "admin": this phone holds the admin secret. "delegate": it holds revocable access
   * someone shared (a delegate key and its certificate). */
  role: "admin" | "delegate";
  /** A delegate's expiry (ISO; absent: until revoked). */
  delegateUntil?: string;
  /** The people the owner shared revocable access with (admin role). */
  delegates: DelegateRecord[];
  /** The admin public key (65 B) the fixtures hold. */
  adminPublic: Uint8Array;
  keyEpoch: number;
  revVersion: number;
  members: MeshMemberRecord[];
  /** Device-key hashes (hex) removed for good. */
  revoked: string[];
}

interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

interface StoredMesh extends Omit<MeshRecord, "role" | "delegates"> {
  /** A delegate's certificate (138 B): present when `admin` holds a delegate key, not the
   * admin secret. */
  delegation?: Uint8Array;
  delegates?: DelegateRecord[];
  /** The admin secret (D-442), sealed. */
  admin?: Sealed;
  /** A device-bound key from before D-442 (non-extractable; such a mesh cannot be exported). */
  adminPrivate?: CryptoKey;
  site: Sealed;
  /** Provisioner tokens (D-324) by node, sealed like the site secret. */
  tokens?: Record<string, Sealed>;
}

/** A key-value store holding structured-clonable values (IndexedDB, or memory in tests). */
export interface MeshBackend {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const DB_NAME = "splanc-mesh";
const DB_VERSION = 1;
const OS = "kv";
const WRAP_KEY = "wrap-key";
const MESH_PREFIX = "mesh:";
/** A mesh backup's text form (exportBackup): this prefix, then base64 JSON. */
export const BACKUP_PREFIX = "splanc-mesh-1:";
/** A fixture's token kept without its mesh (putFixtureToken): `token:<meshId>:<node>`. */
const TOKEN_PREFIX = "token:";

/** A mesh backup's body (exportBody): hex secrets, the roster, and the tokens by node. */
export interface MeshBackupBody {
  v: 1;
  meshId: number;
  name: string;
  admin: string;
  site: string;
  keyEpoch: number;
  revVersion: number;
  revoked: string[];
  members: { label: string; node: number; keyHash: string }[];
  /** Provisioner tokens (hex) by node; absent in backups made before share links. */
  tokens?: Record<string, string>;
  /** Revocable access (a delegate): `admin` is the delegate's secret, this its certificate
   * (hex), `adminPublic` the owner's admin key (hex) and `until` its expiry (ISO). */
  delegation?: string;
  adminPublic?: string;
  until?: string;
}

function utf8ToB64(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToUtf8(s: string): string {
  const bin = atob(s.replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

class IdbBackend implements MeshBackend {
  private dbp: Promise<IDBDatabase> | null = null;
  private db(): Promise<IDBDatabase> {
    if (this.dbp === null) {
      this.dbp = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("this browser cannot store the mesh key (no IndexedDB)"));
          return;
        }
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains(OS)) r.result.createObjectStore(OS);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      this.dbp.catch(() => (this.dbp = null));
    }
    return this.dbp;
  }
  private req<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest): Promise<T> {
    return this.db().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(OS, mode);
          const r = fn(tx.objectStore(OS));
          tx.oncomplete = () => resolve(r.result as T);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  }
  get(key: string): Promise<unknown> {
    return this.req("readonly", (os) => os.get(key));
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.req("readwrite", (os) => os.put(value, key));
  }
  async del(key: string): Promise<void> {
    await this.req("readwrite", (os) => os.delete(key));
  }
  async keys(): Promise<string[]> {
    return ((await this.req<IDBValidKey[]>("readonly", (os) => os.getAllKeys())) ?? []).map(String);
  }
}

export class MemoryMeshBackend implements MeshBackend {
  readonly m = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.m.get(key);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.m.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.m.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.m.keys()];
  }
}

function publicView(s: StoredMesh): MeshRecord {
  const v: MeshRecord = {
    meshId: s.meshId,
    name: s.name,
    createdAt: s.createdAt,
    role: s.delegation ? "delegate" : "admin",
    delegates: (s.delegates ?? []).map((d) => ({ ...d })),
    adminPublic: s.adminPublic,
    keyEpoch: s.keyEpoch,
    revVersion: s.revVersion,
    members: s.members.map((m) => ({ ...m })),
    revoked: [...s.revoked],
  };
  if (s.delegateUntil) v.delegateUntil = s.delegateUntil;
  return v;
}

type Listener = () => void;

export class MeshStore {
  private backend: MeshBackend | null = null;
  private cache = new Map<number, MeshRecord>();
  private loaded: Promise<void> | null = null;
  private listeners = new Set<Listener>();

  /** Swap the storage (tests; demo mode). Drops the cache. */
  setBackend(b: MeshBackend): void {
    this.backend = b;
    this.cache.clear();
    this.loaded = null;
  }

  private be(): MeshBackend {
    return (this.backend ??= new IdbBackend());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Load every record into the cache (once). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const be = this.be();
      for (const k of await be.keys()) {
        if (!k.startsWith(MESH_PREFIX)) continue;
        const s = (await be.get(k)) as StoredMesh | undefined;
        if (s) this.cache.set(s.meshId, publicView(s));
      }
    })().catch((e) => {
      this.loaded = null;
      throw e;
    });
    return this.loaded;
  }

  async list(): Promise<MeshRecord[]> {
    await this.load();
    return [...this.cache.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(meshId: number): Promise<MeshRecord | undefined> {
    await this.load();
    return this.cache.get(meshId >>> 0);
  }

  /** The cached record (after any list/get/load), for synchronous lookups while rendering. */
  peek(meshId: number | undefined): MeshRecord | undefined {
    return meshId === undefined ? undefined : this.cache.get(meshId >>> 0);
  }

  private async stored(meshId: number): Promise<StoredMesh> {
    const s = (await this.be().get(MESH_PREFIX + (meshId >>> 0))) as StoredMesh | undefined;
    if (!s) throw new Error("this app does not hold that mesh's admin key");
    return s;
  }

  private async write(s: StoredMesh): Promise<MeshRecord> {
    await this.be().put(MESH_PREFIX + s.meshId, s);
    const v = publicView(s);
    this.cache.set(s.meshId, v);
    this.emit();
    return v;
  }

  private async wrapKey(): Promise<CryptoKey> {
    const be = this.be();
    const k = (await be.get(WRAP_KEY)) as CryptoKey | undefined;
    if (k) return k;
    const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await be.put(WRAP_KEY, fresh);
    return fresh;
  }

  private async seal(plain: Uint8Array, meshId: number): Promise<Sealed> {
    const iv = randomBytes(12);
    const ad = new TextEncoder().encode(`splanc mesh site ${meshId >>> 0}`);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: ad as BufferSource },
      await this.wrapKey(),
      plain as BufferSource,
    );
    return { iv, ct: new Uint8Array(ct) };
  }

  private async unseal(s: Sealed, meshId: number): Promise<Uint8Array> {
    const ad = new TextEncoder().encode(`splanc mesh site ${meshId >>> 0}`);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: s.iv as BufferSource, additionalData: ad as BufferSource },
      await this.wrapKey(),
      s.ct as BufferSource,
    );
    return new Uint8Array(pt);
  }

  /** A new mesh: a fresh id, admin secret and site secret, kept here. */
  async create(name: string, opts: { meshId?: number } = {}): Promise<MeshRecord> {
    await this.load();
    let meshId = opts.meshId ?? randomU32();
    while (opts.meshId === undefined && this.cache.has(meshId)) meshId = randomU32();
    const secret = randomBytes(16);
    const adminPublic = (await adminSignerFromSecret(secret, meshId)).publicKey;
    const admin = await this.seal(secret, meshId);
    secret.fill(0);
    const site = randomBytes(32);
    const sealed = await this.seal(site, meshId);
    site.fill(0);
    return this.write({
      meshId,
      name: name.trim() || "Home mesh",
      createdAt: new Date().toISOString(),
      adminPublic,
      admin,
      site: sealed,
      keyEpoch: 1,
      revVersion: 0,
      members: [],
      revoked: [],
    });
  }

  private signers = new Map<number, MeshAdminSigner>();

  /** The admin signer for a mesh (derived once per session from its sealed secret). */
  async signer(meshId: number): Promise<MeshAdminSigner> {
    const have = this.signers.get(meshId >>> 0);
    if (have) return have;
    const s = await this.stored(meshId);
    let signer: MeshAdminSigner;
    if (s.admin) {
      const secret = await this.unseal(s.admin, meshId);
      signer = await adminSignerFromSecret(secret, meshId);
      secret.fill(0);
    } else if (s.adminPrivate) {
      signer = webCryptoSigner(s.adminPrivate, s.adminPublic);
    } else {
      throw new Error("this app does not hold that mesh's admin key");
    }
    this.signers.set(meshId >>> 0, signer);
    return signer;
  }

  /** Whether the mesh's admin key can be backed up (made after D-442). */
  async exportable(meshId: number): Promise<boolean> {
    const s = await this.stored(meshId);
    return s.admin !== undefined && !s.delegation;
  }

  /** The mesh as one text a second phone imports (D-442): its id, name, admin secret, site
   * secret, key epoch, revocations and members. Whoever holds it administers the mesh. */
  async exportBackup(meshId: number): Promise<string> {
    return BACKUP_PREFIX + utf8ToB64(JSON.stringify(await this.exportBody(meshId)));
  }

  /** The backup's body (also what a share link carries, docs/design/share-links.md): the
   * backup fields plus the provisioner tokens this app holds, by node. */
  async exportBody(meshId: number): Promise<MeshBackupBody> {
    const s = await this.stored(meshId);
    if (s.delegation) throw new Error("access shared with you can't be shared or backed up: ask the mesh's owner");
    if (!s.admin) throw new Error("this mesh was made before admin backups: re-create it to back it up");
    const admin = await this.unseal(s.admin, meshId);
    const site = await this.unseal(s.site, meshId);
    const tokens: Record<string, string> = {};
    for (const [node, t] of Object.entries(s.tokens ?? {})) {
      const b = await this.unseal(t, meshId);
      tokens[node] = toHex(b);
      b.fill(0);
    }
    const body: MeshBackupBody = {
      v: 1,
      meshId: s.meshId >>> 0,
      name: s.name,
      admin: toHex(admin),
      site: toHex(site),
      keyEpoch: s.keyEpoch,
      revVersion: s.revVersion,
      revoked: s.revoked,
      members: s.members.map((m) => ({ label: m.label, node: m.node, keyHash: m.keyHash })),
    };
    if (Object.keys(tokens).length) body.tokens = tokens;
    admin.fill(0);
    site.fill(0);
    return body;
  }

  /** A mesh from another phone's backup (exportBackup). Replaces this app's copy of the same
   * mesh. Checks the admin secret against nothing but itself: the fixtures decide. */
  async importBackup(text: string): Promise<MeshRecord> {
    const t = text.trim();
    if (!t.startsWith(BACKUP_PREFIX)) throw new Error("not a Splanc mesh backup");
    let b: Partial<MeshBackupBody>;
    try {
      b = JSON.parse(b64ToUtf8(t.slice(BACKUP_PREFIX.length))) as Partial<MeshBackupBody>;
    } catch {
      throw new Error("this mesh backup is damaged");
    }
    return this.importBody(b);
  }

  /** A backup body (importBackup, or a share link's). Tokens this phone already holds for
   * the mesh (its own, or a fixture shared on its own) are kept. */
  async importBody(b: Partial<MeshBackupBody>): Promise<MeshRecord> {
    if (b?.v !== 1 || typeof b.meshId !== "number" || !b.admin || !b.site) throw new Error("this mesh backup is damaged");
    const meshId = b.meshId >>> 0;
    const admin = fromHex(b.admin);
    const site = fromHex(b.site);
    if (admin.length !== 16 || site.length !== 32) throw new Error("this mesh backup is damaged");
    await this.load();
    const be = this.be();
    const prev = (await be.get(MESH_PREFIX + meshId)) as StoredMesh | undefined;
    // Revocable access: the secret is a delegate's, certified by the owner's admin key.
    let delegation: Uint8Array | undefined;
    let adminPublic: Uint8Array;
    if (b.delegation) {
      const cert = fromHex(b.delegation);
      const d = decodeDelegation(cert);
      const owner = b.adminPublic ? fromHex(b.adminPublic) : new Uint8Array(0);
      const mine = (await adminSignerFromSecret(admin, meshId)).publicKey;
      const ok =
        d !== null && owner.length === 65 && d.meshId === meshId && toHex(d.key) === toHex(mine) &&
        (await verifyAdminSignature(owner, delegationSignedBytes(d), d.sig));
      if (!ok) throw new Error("this mesh backup is damaged");
      if (prev && !prev.delegation) throw new Error("this phone already administers this mesh");
      delegation = cert;
      adminPublic = owner;
    } else {
      adminPublic = (await adminSignerFromSecret(admin, meshId)).publicKey;
    }
    const tokens: Record<string, Sealed> = { ...(prev?.tokens ?? {}) };
    for (const [node, hex] of Object.entries(b.tokens ?? {})) {
      const raw = fromHex(hex);
      if (raw.length === 16) tokens[node] = await this.seal(raw, meshId);
      raw.fill(0);
    }
    const loose = `${TOKEN_PREFIX}${meshId}:`;
    for (const k of await be.keys()) {
      if (!k.startsWith(loose)) continue;
      const node = k.slice(loose.length);
      const t = (await be.get(k)) as Sealed | undefined;
      if (t && !tokens[node]) tokens[node] = t;
      await be.del(k);
    }
    const rec: StoredMesh = {
      meshId,
      name: (b.name ?? "").trim() || "Home mesh",
      createdAt: new Date().toISOString(),
      adminPublic,
      admin: await this.seal(admin, meshId),
      site: await this.seal(site, meshId),
      keyEpoch: b.keyEpoch ?? 1,
      revVersion: b.revVersion ?? 0,
      members: (b.members ?? []).map((m) => ({ deviceId: "", label: m.label ?? "", node: m.node ?? 0, keyHash: m.keyHash ?? "" })),
      revoked: [...(b.revoked ?? [])],
    };
    if (Object.keys(tokens).length) rec.tokens = tokens;
    if (delegation) {
      rec.delegation = delegation;
      if (b.until) rec.delegateUntil = b.until;
    } else if (prev?.delegates?.length) {
      rec.delegates = prev.delegates;
    }
    admin.fill(0);
    site.fill(0);
    this.signers.delete(meshId);
    return this.write(rec);
  }

  /** A delegate's certificate (null: this phone holds the admin secret itself). */
  async delegation(meshId: number): Promise<Uint8Array | null> {
    return (await this.stored(meshId)).delegation ?? null;
  }

  /** Revocable access for someone (docs/design/share-links.md): a fresh delegate key,
   * certified by this mesh's admin key until `notAfter` (mesh seconds; NO_EXPIRY: until
   * revoked). Returns the share body and `commit`, which lists the delegate here: call it
   * once the link was actually sent, so an abandoned share leaves nothing behind. */
  async issueDelegate(
    meshId: number,
    opts: { label: string; notAfter: number; expiresAt?: string },
  ): Promise<{ body: MeshBackupBody; keyHash: string; commit: () => Promise<void> }> {
    const owner = await this.exportBody(meshId);
    delete owner.tokens;
    const secret = randomBytes(16);
    const delegate = await adminSignerFromSecret(secret, meshId);
    const cert = await signDelegation(await this.signer(meshId), {
      meshId: meshId >>> 0,
      key: delegate.publicKey,
      notAfter: opts.expiresAt ? opts.notAfter >>> 0 : NO_EXPIRY,
    });
    const kh = toHex(await keyHash(delegate.publicKey));
    const rec = await this.get(meshId);
    const body: MeshBackupBody = {
      ...owner,
      admin: toHex(secret),
      delegation: toHex(cert),
      adminPublic: toHex(rec!.adminPublic),
    };
    if (opts.expiresAt) body.until = opts.expiresAt;
    secret.fill(0);
    const entry: DelegateRecord = { keyHash: kh, label: opts.label.trim() || "Someone", issuedAt: new Date().toISOString() };
    if (opts.expiresAt) entry.expiresAt = opts.expiresAt;
    return {
      body,
      keyHash: kh,
      commit: async () => {
        const s = await this.stored(meshId);
        s.delegates = [...(s.delegates ?? []).filter((d) => d.keyHash !== kh), entry];
        await this.write(s);
      },
    };
  }

  /** A delegate revoked by a rotation (rotated() already holds the new keys). */
  async markDelegateRevoked(meshId: number, keyHash: string): Promise<MeshRecord> {
    const s = await this.stored(meshId);
    s.delegates = (s.delegates ?? []).map((d) => (d.keyHash === keyHash ? { ...d, revoked: true } : d));
    return this.write(s);
  }

  /** Forget a delegate that expired (nothing to revoke any more). */
  async dropDelegate(meshId: number, keyHash: string): Promise<MeshRecord> {
    const s = await this.stored(meshId);
    s.delegates = (s.delegates ?? []).filter((d) => d.keyHash !== keyHash);
    return this.write(s);
  }

  /** The site secret, for a provision about to go to a fixture. Callers zero it after use. */
  async siteSecret(meshId: number): Promise<Uint8Array> {
    const s = await this.stored(meshId);
    return this.unseal(s.site, meshId);
  }

  /** Record (or update, by device id or node) a member, with its provisioner token. */
  async putMember(meshId: number, m: MeshMemberRecord, provisionerToken?: Uint8Array | null): Promise<MeshRecord> {
    const s = await this.stored(meshId);
    if (provisionerToken) (s.tokens ??= {})[String(m.node)] = await this.seal(provisionerToken, meshId);
    s.members = s.members.filter((x) => x.node !== m.node && (m.deviceId === "" || x.deviceId !== m.deviceId));
    s.members.push({ ...m });
    return this.write(s);
  }

  /** A member's provisioner token (null: none kept): from the mesh's record or, for a
   * fixture shared on its own (putFixtureToken), from beside it. */
  async provisionerToken(meshId: number, node: number): Promise<Uint8Array | null> {
    const id = meshId >>> 0;
    const s = (await this.be().get(MESH_PREFIX + id)) as StoredMesh | undefined;
    const t = s?.tokens?.[String(node)] ?? ((await this.be().get(`${TOKEN_PREFIX}${id}:${node}`)) as Sealed | undefined);
    return t ? this.unseal(t, id) : null;
  }

  /** One fixture's provisioner token, shared without its mesh's admin key (a share link of
   * kind "fixture"). It lets this phone take that fixture out of the mesh or re-provision
   * it, nothing mesh-wide. Kept in the mesh's record when this phone holds the mesh. */
  async putFixtureToken(meshId: number, node: number, token: Uint8Array): Promise<void> {
    const id = meshId >>> 0;
    const s = (await this.be().get(MESH_PREFIX + id)) as StoredMesh | undefined;
    const sealed = await this.seal(token, id);
    if (s) {
      (s.tokens ??= {})[String(node)] = sealed;
      await this.write(s);
      return;
    }
    await this.be().put(`${TOKEN_PREFIX}${id}:${node}`, sealed);
    this.emit();
  }

  /** Forget a token kept by putFixtureToken (the fixture left that mesh). */
  async dropFixtureToken(meshId: number, node: number): Promise<void> {
    await this.be().del(`${TOKEN_PREFIX}${meshId >>> 0}:${node}`);
    this.emit();
  }

  async dropMember(meshId: number, node: number): Promise<MeshRecord> {
    const s = await this.stored(meshId);
    if (s.tokens) delete s.tokens[String(node)];
    s.members = s.members.filter((x) => x.node !== node);
    return this.write(s);
  }

  /** After a successful revoke: the new keys' epoch and site secret, and who is out. */
  async rotated(
    meshId: number,
    r: { keyEpoch: number; revVersion: number; siteSecret: Uint8Array; revoked: string[]; nodes: number[]; replaced?: boolean },
  ): Promise<MeshRecord> {
    const s = await this.stored(meshId);
    s.site = await this.seal(r.siteSecret, meshId);
    s.keyEpoch = r.keyEpoch;
    s.revVersion = r.revVersion;
    // A replacing order (D-443) starts a fresh list on the fixtures: keep the same here.
    s.revoked = r.replaced ? [...r.revoked] : [...new Set([...s.revoked, ...r.revoked])];
    s.members = s.members.filter((m) => !r.nodes.includes(m.node) && !r.revoked.includes(m.keyHash));
    return this.write(s);
  }

  async rename(meshId: number, name: string): Promise<MeshRecord> {
    const s = await this.stored(meshId);
    s.name = name.trim() || s.name;
    return this.write(s);
  }

  /** Forget a mesh here (its fixtures keep it; recovery is then the USB console). */
  async forget(meshId: number): Promise<void> {
    this.signers.delete(meshId >>> 0);
    await this.be().del(MESH_PREFIX + (meshId >>> 0));
    this.cache.delete(meshId >>> 0);
    this.emit();
  }
}

/** Revoked people whose access hasn't expired: a rotation that starts a fresh revocation
 * list (D-443) must carry them, or their access would work again. */
export function keepRevoked(rec: Pick<MeshRecord, "delegates">, now = Date.now()): string[] {
  return rec.delegates.filter((d) => d.revoked && (!d.expiresAt || Date.parse(d.expiresAt) > now)).map((d) => d.keyHash);
}

export const meshStore = new MeshStore();
