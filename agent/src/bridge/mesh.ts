/**
 * The bridge in the Splanc mesh (issue #697; docs/design/mesh-pi-transport.md §7).
 *
 * Two halves:
 *
 * - **The bridge's own membership.** On the Pi bridge image, `pimesh serve` (the
 *   splanc-mesh service, pi/mesh_radio/src/bridge.rs) runs the mesh stack on the Pi's
 *   radio. {@link PimeshClient} speaks its control socket (one line in, one JSON line
 *   out); {@link BridgeMesh} polls it for the status file, the app's live session and the
 *   tools, and carries the app's `join` / `leave`. Joining is by approval only: the bridge
 *   gets the mesh id and the admin's PUBLIC key, never a site secret, so a gateway lists it
 *   as pending and the admin admits it in the app, like any fixture (mesh.md §7). The
 *   provisioner token pimesh issues stays here (0600), so only this bridge's own owner path
 *   can move it to another mesh.
 *
 * - **Mesh traffic through a fixture on the LAN** (the "C6 gateway over the LAN" path): the
 *   bridge already holds a session to every fixture, so a mesh fixture it reaches is a
 *   gateway for its tools. Reading the mesh (`get_mesh`, the topology) needs nothing.
 *   Relaying control (`mesh_send`) on a mesh with an admin key needs the gateway unlocked,
 *   and the bridge does that only as a **delegate**: it holds a P-256 key of its own; the
 *   app (which holds the admin key) certifies it with a Delegation (docs/design/
 *   share-links.md, "Revocable access"; firmware/mesh/src/admin.rs), and the bridge signs
 *   delegated grants with it. Members enforce the delegate rules (a grant never outlives
 *   its certificate; a delegate cannot sign rotations), and a key rotation that lists the
 *   key revokes it. The bridge never holds the admin secret.
 */

import { webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { BRIDGE_FIRMWARE, deviceHasMesh, MESH_RELAY_TYPES, meshResultError, type MeshResultInfo, type MeshStateInfo } from "../../../web/src/net/mesh";
import { isMemberOf, unlockFixture } from "../../../web/src/net/meshAdmin";
import { decodeDelegation, fromHex, toHex, webCryptoSigner, type MeshAdminSigner } from "../../../web/src/net/meshKeys";
import type { Hub } from "../hub";
import type { DeviceSession } from "../session";
import { ToolError } from "../session";

export const DEFAULT_MESH_SOCKET = "/run/splanc-mesh/mesh.sock";
/** What a bridge sends as its status `firmware` (pimesh bridge::BRIDGE_FIRMWARE). */
export { BRIDGE_FIRMWARE };

/** One radio neighbour as pimesh reports it. */
export interface MemberNeighbour {
  node: number;
  /** dBm; 0 = not measured. */
  rssi: number;
  tx_ok_pct?: number;
}

/** `pimesh serve`'s `status` (pi/mesh_radio/src/bridge.rs status_json). */
export interface MemberStatus {
  v: 1;
  node: number;
  phase: "off" | "searching" | "joining" | "member";
  member: boolean;
  mesh_id: number;
  admin_key: boolean;
  key_hash: string;
  device_key: string;
  firmware: number;
  channel: number | null;
  heard_channel: number | null;
  channel_ok: boolean;
  sync: number;
  neighbours: MemberNeighbour[];
  members_heard: number;
  via: string;
  uptime_s: number;
  log: string[];
}

/** The member status, or null when `x` isn't one (an old or broken pimesh). */
export function parseMemberStatus(x: unknown): MemberStatus | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (o["v"] !== 1 || typeof o["node"] !== "number" || typeof o["phase"] !== "string") return null;
  if (!["off", "searching", "joining", "member"].includes(o["phase"] as string)) return null;
  const nb = Array.isArray(o["neighbours"]) ? (o["neighbours"] as unknown[]) : [];
  return {
    v: 1,
    node: o["node"] as number,
    phase: o["phase"] as MemberStatus["phase"],
    member: o["member"] === true,
    mesh_id: Number(o["mesh_id"] ?? 0) >>> 0,
    admin_key: o["admin_key"] === true,
    key_hash: String(o["key_hash"] ?? ""),
    device_key: String(o["device_key"] ?? ""),
    firmware: Number(o["firmware"] ?? 0) >>> 0,
    channel: typeof o["channel"] === "number" ? (o["channel"] as number) : null,
    heard_channel: typeof o["heard_channel"] === "number" ? (o["heard_channel"] as number) : null,
    channel_ok: o["channel_ok"] !== false,
    sync: Number(o["sync"] ?? 0),
    neighbours: nb
      .filter((n): n is Record<string, unknown> => !!n && typeof n === "object" && typeof (n as Record<string, unknown>)["node"] === "number")
      .map((n) => ({ node: n["node"] as number, rssi: Number(n["rssi"] ?? 0), ...(typeof n["tx_ok_pct"] === "number" ? { tx_ok_pct: n["tx_ok_pct"] as number } : {}) })),
    members_heard: Number(o["members_heard"] ?? 0),
    via: String(o["via"] ?? ""),
    uptime_s: Number(o["uptime_s"] ?? 0),
    log: Array.isArray(o["log"]) ? (o["log"] as unknown[]).map(String) : [],
  };
}

/** The bridge's mesh in the status file, the live welcome and the tools: no keys, no log. */
export interface MeshSummary {
  /** pimesh answers (false: no splanc-mesh service, or it is down). */
  available: boolean;
  node?: number;
  phase?: MemberStatus["phase"];
  mesh_id?: number;
  /** The bridge's Wi-Fi is on the channel the mesh's adverts announce. */
  channel_ok?: boolean;
  channel?: number | null;
  neighbours?: number;
  /** This bridge holds a delegation for its mesh (it may relay control). */
  delegated?: boolean;
  /** What the screens say, one line. */
  text: string;
}

export function meshSummary(s: MemberStatus | null, delegated: boolean): MeshSummary {
  if (!s) return { available: false, text: "Mesh: not running on this bridge" };
  const out: MeshSummary = {
    available: true,
    node: s.node,
    phase: s.phase,
    mesh_id: s.mesh_id,
    channel_ok: s.channel_ok,
    channel: s.channel,
    neighbours: s.neighbours.length,
    delegated,
    text: "",
  };
  const n = s.neighbours.length;
  if (s.phase === "off") out.text = "Mesh: not joined (add the bridge from the app)";
  else if (s.phase === "searching") out.text = "Mesh: looking for the mesh";
  else if (s.phase === "joining") out.text = "Mesh: waiting for approval in the app";
  else out.text = `Mesh: member, ${n} radio neighbour${n === 1 ? "" : "s"}`;
  if (s.phase !== "off" && !s.channel_ok) {
    out.text = `Mesh: on channel ${s.channel ?? "?"}, the lamps are on ${s.heard_channel ?? "?"}: put the bridge on their 2.4 GHz Wi-Fi`;
  }
  return out;
}

/** One request/response on pimesh's control socket. */
export class PimeshClient {
  constructor(
    readonly path: string,
    private readonly timeoutMs = 2000,
  ) {}

  call(line: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.path);
      let buf = "";
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`pimesh: no answer in ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      sock.setEncoding("utf8");
      sock.on("connect", () => sock.write(`${line}\n`));
      sock.on("data", (d: string) => {
        buf += d;
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(t);
        sock.end();
        try {
          resolve(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
        } catch {
          reject(new Error("pimesh: unreadable answer"));
        }
      });
      sock.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  async status(): Promise<MemberStatus> {
    const s = parseMemberStatus(await this.call("status"));
    if (!s) throw new Error("pimesh: unexpected status");
    return s;
  }
}

/** What the bridge keeps (0600): its delegate key, the delegation the app gave it, and
 * pimesh's provisioner token. */
interface MeshFile {
  v: 1;
  delegate?: { jwk: JsonWebKey; public: string };
  /** Hex of the 138-byte certificate, and the mesh it is for. */
  delegation?: { mesh_id: number; cert: string };
  token?: string;
}

export interface BridgeMeshOptions {
  /** pimesh's socket (SPLANC_MESH_SOCKET, else the image's default). */
  socket?: string;
  /** Where the bridge keeps mesh.json (its config dir). */
  stateDir: string;
  pollMs?: number;
  log?: (...a: unknown[]) => void;
  /** Tests: the client to use instead of a socket. */
  client?: Pick<PimeshClient, "call" | "status">;
}

export class BridgeMesh {
  private readonly client: Pick<PimeshClient, "call" | "status">;
  private readonly file: string;
  private readonly log: (...a: unknown[]) => void;
  private data: MeshFile = { v: 1 };
  private signer_: MeshAdminSigner | null = null;
  private last: MemberStatus | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Called when the member status changed (the status file, the live session). */
  onChange: (() => void) | null = null;

  constructor(private readonly opts: BridgeMeshOptions) {
    this.client = opts.client ?? new PimeshClient(opts.socket ?? process.env["SPLANC_MESH_SOCKET"] ?? DEFAULT_MESH_SOCKET);
    this.file = join(opts.stateDir, "mesh.json");
    this.log = opts.log ?? (() => undefined);
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8")) as MeshFile;
      if (d && d.v === 1) this.data = d;
    } catch {
      // first start
    }
  }

  /** Whether this host runs pimesh at all (the Pi image does; a laptop agent doesn't). */
  static present(socket = process.env["SPLANC_MESH_SOCKET"] ?? DEFAULT_MESH_SOCKET): boolean {
    return existsSync(socket);
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 5000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<MemberStatus | null> {
    let s: MemberStatus | null = null;
    try {
      s = await this.client.status();
    } catch {
      s = null;
    }
    const was = JSON.stringify(this.last === null ? null : { ...this.last, uptime_s: 0, log: [] });
    this.last = s;
    if (JSON.stringify(s === null ? null : { ...s, uptime_s: 0, log: [] }) !== was) this.onChange?.();
    return s;
  }

  get member(): MemberStatus | null {
    return this.last;
  }

  /** This bridge holds a delegation for the mesh it is in. */
  get delegated(): boolean {
    const d = this.data.delegation;
    return !!d && !!this.last && this.last.mesh_id === d.mesh_id && d.mesh_id !== 0;
  }

  summary(): MeshSummary {
    return meshSummary(this.last, this.delegated);
  }

  private save(): void {
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Join `meshId` by approval (the admin then admits the bridge in the app). `adminKey`:
   * the mesh's admin public key (65 B), absent only on a dev mesh. */
  async join(meshId: number, adminKey: Uint8Array | null, channel = 0): Promise<MemberStatus | null> {
    if (!Number.isInteger(meshId) || meshId <= 0 || meshId > 0xffffffff) throw new ToolError("bad mesh id");
    if (adminKey && (adminKey.length !== 65 || adminKey[0] !== 0x04)) throw new ToolError("the admin key must be 65 bytes, uncompressed P-256");
    if (!Number.isInteger(channel) || channel < 0 || channel > 14) throw new ToolError("bad channel");
    const args = [meshId.toString(16), adminKey ? toHex(adminKey) : "-", String(channel)];
    if (this.data.token) args.push(this.data.token);
    const r = await this.client.call(`provision ${args.join(" ")}`);
    if (r["ok"] !== true) throw new ToolError(`the bridge's mesh refused: ${String(r["error"] ?? "unknown error")}`);
    this.data.token = String(r["token"] ?? "");
    // A certificate for another mesh is no use now.
    if (this.data.delegation && this.data.delegation.mesh_id !== meshId >>> 0) delete this.data.delegation;
    this.save();
    this.log(`mesh: joining ${meshId.toString(16)} (waiting for the admin's approval)`);
    return this.poll();
  }

  /** Join the mesh the fixtures on this network are in, knowing only its id (a meshed
   * fixture's get_mesh; no unlock): the admin key comes with the admit, authenticated. */
  async joinLan(hub: Hub): Promise<MemberStatus | null> {
    const g = await pickGateway(hub);
    const id = (g.state.meshId ?? 0) >>> 0;
    if (!id) throw new ToolError(`${g.name} reports no mesh id`);
    return this.join(id, null, 0);
  }

  async leave(): Promise<MemberStatus | null> {
    const r = await this.client.call(this.data.token ? `leave ${this.data.token}` : "leave");
    if (r["ok"] !== true) throw new ToolError(`the bridge's mesh refused: ${String(r["error"] ?? "unknown error")}`);
    delete this.data.token;
    delete this.data.delegation;
    this.save();
    this.log("mesh: left");
    return this.poll();
  }

  /** The bridge's delegate key (made on first use): what the app certifies. */
  async delegateKey(): Promise<Uint8Array> {
    return (await this.signer()).publicKey;
  }

  private async signer(): Promise<MeshAdminSigner> {
    if (this.signer_) return this.signer_;
    const subtle = webcrypto.subtle;
    let d = this.data.delegate;
    if (!d) {
      const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const jwk = await subtle.exportKey("jwk", kp.privateKey);
      const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
      d = { jwk, public: toHex(pub) };
      this.data.delegate = d;
      this.save();
    }
    const key = await subtle.importKey("jwk", d.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    this.signer_ = webCryptoSigner(key as unknown as CryptoKey, fromHex(d.public));
    return this.signer_;
  }

  /** Keep the app's certificate for this bridge's delegate key. */
  async setDelegation(cert: Uint8Array): Promise<void> {
    const c = decodeDelegation(cert);
    if (!c) throw new ToolError("not a delegation certificate");
    const mine = await this.delegateKey();
    if (toHex(c.key) !== toHex(mine)) throw new ToolError("that certificate is for another key, not this bridge's");
    this.data.delegation = { mesh_id: c.meshId >>> 0, cert: toHex(cert) };
    this.save();
    this.log(`mesh: delegated for mesh ${c.meshId.toString(16)}`);
    this.onChange?.();
  }

  /** The signer and certificate for `meshId`, if this bridge is a delegate there. */
  async delegateFor(meshId: number): Promise<{ signer: MeshAdminSigner; delegation: Uint8Array } | null> {
    const d = this.data.delegation;
    if (!d || d.mesh_id !== meshId >>> 0) return null;
    return { signer: await this.signer(), delegation: fromHex(d.cert) };
  }
}

// -- the LAN gateway ------------------------------------------------------------------

/** A connected mesh fixture to act as the gateway: `name` (a player selector) if given,
 * else the first connected player that advertises the mesh and is a member. */
export async function pickGateway(hub: Hub, name?: string): Promise<{ session: DeviceSession; name: string; state: MeshStateInfo }> {
  await hub.ready();
  const tried: string[] = [];
  for (const p of hub.registry.list()) {
    if (name && p.name !== name && p.id !== name && p.host !== name) continue;
    let s: DeviceSession;
    try {
      s = await hub.session(p);
    } catch (e) {
      tried.push(`${p.name}: ${(e as Error).message}`);
      continue;
    }
    if (!deviceHasMesh(s.client.welcome as unknown as { features?: string[] })) {
      tried.push(`${p.name}: no mesh firmware`);
      continue;
    }
    const state = await s.run(() => s.client.getMesh());
    if (isMemberOf(state)) return { session: s, name: p.name, state };
    tried.push(`${p.name}: not in a mesh`);
  }
  throw new ToolError(`no fixture on this network can be the mesh gateway${tried.length ? ` (${tried.join("; ")})` : ""}`);
}

/** The mesh's topology through a gateway, with this bridge's own membership. */
export async function meshView(hub: Hub, mesh: BridgeMesh | null, gateway?: string): Promise<Record<string, unknown>> {
  const bridge = mesh ? mesh.summary() : null;
  const g = await pickGateway(hub, gateway);
  const state = await g.session.run(() => g.session.client.getMeshTopology());
  const bridgeNode = bridge?.available && bridge.phase === "member" ? bridge.node : undefined;
  const members = (state.members ?? []).map((m) => ({
    node: m.node,
    kind: m.firmware === BRIDGE_FIRMWARE || m.node === bridgeNode ? "bridge" : "fixture",
    ...(m.rssi ? { rssi: m.rssi } : {}),
    seen_ms_ago: m.seenMsAgo ?? 0,
    ...(m.fps !== undefined ? { fps: m.fps } : {}),
    sync: m.sync ?? 0,
    hops: m.hops ?? 0,
    neighbours: (m.neighbours ?? []).map((n) => ({ node: n.node, rssi: n.rssi ?? 0, ...(n.txOkPct !== undefined ? { tx_ok_pct: n.txOkPct } : {}), ...(n.rangeM !== undefined ? { range_m: n.rangeM } : {}) })),
  }));
  return {
    gateway: g.name,
    mesh_id: state.meshId ?? 0,
    gateway_node: state.node ?? 0,
    admin_key: !!state.adminKey,
    sync: state.sync ?? 0,
    gateway_neighbours: (state.neighbours ?? []).map((n) => ({ node: n.node, rssi: n.rssi ?? 0, ...(n.txOkPct !== undefined ? { tx_ok_pct: n.txOkPct } : {}) })),
    members,
    pending: (state.pending ?? []).map((p) => ({ node: p.node, kind: p.firmware === BRIDGE_FIRMWARE ? "bridge" : "fixture" })),
    ...(bridge ? { bridge } : {}),
  };
}

/** Relay one ClientMessage to the mesh through a LAN gateway. On a mesh with an admin key
 * the gateway is unlocked with a grant this bridge signs as a delegate (refused without a
 * delegation); on a dev mesh get_mesh opened the session already. */
export async function meshRelay(
  hub: Hub,
  mesh: BridgeMesh | null,
  msg: { type: string } & Record<string, unknown>,
  opts: { gateway?: string; nodes?: number[]; group?: number; leadMs?: number; timeoutMs?: number } = {},
): Promise<MeshResultInfo & { gateway: string }> {
  if (!MESH_RELAY_TYPES.has(msg.type) || msg.type === "submit_effect") {
    throw new ToolError(`${msg.type} cannot be sent over the mesh (allowed: ${[...MESH_RELAY_TYPES].filter((t) => t !== "submit_effect").join(", ")})`);
  }
  const g = await pickGateway(hub, opts.gateway);
  const s = g.session;
  const meshId = (g.state.meshId ?? 0) >>> 0;
  // `gateway`: this connection already holds the gateway session (a live grant, or a dev
  // mesh's envelope trust opened by get_mesh).
  if (g.state.adminKey && !g.state.gateway) {
    const k = mesh ? await mesh.delegateFor(meshId) : null;
    if (!k) throw new ToolError("this mesh has an admin key: the bridge needs the app's permission (a delegation) to control it");
    await s.run(() => unlockFixture(s.client, k.signer, meshId, g.state, { delegation: k.delegation }));
  }
  const r = await s.run(() =>
    s.client.meshSend(msg as never, {
      ...(opts.nodes ? { nodes: opts.nodes } : {}),
      ...(opts.group ? { group: opts.group } : {}),
      ...(opts.leadMs !== undefined ? { leadMs: opts.leadMs } : { leadMs: 150 }),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    }),
  );
  const err = meshResultError(r);
  if (err) throw new ToolError(`the mesh gateway ${g.name}: ${err}`);
  return { ...r, gateway: g.name };
}
