/**
 * Admin access in a share link (docs/design/share-links.md): what a "mesh" or "fixture"
 * link carries, and what opening one changes on the receiving phone.
 *
 *  - mesh: the mesh backup body (meshStore.exportBody): admin secret, site secret, roster,
 *    provisioner tokens. The receiver administers the whole mesh, as the sender does.
 *  - fixture: one fixture's address, name and certificate pin, and, when it is in a mesh,
 *    its provisioner token. The receiver can find and connect to it, and take it out of
 *    its mesh or re-provision it, but nothing mesh-wide.
 */

import { fromHex, toHex } from "../net/meshKeys";
import type { ShareEnvelope } from "../net/shareLink";
import { certPins, normFingerprint, type CertPinStore } from "../net/deviceTrust";
import { meshStore, type MeshBackupBody, type MeshStore } from "./meshStore";
import { deviceStore } from "./deviceStore";

export interface FixtureShareBody {
  label: string;
  /** wss://host[:port]/ws, as the sender last reached it. */
  wssUrl: string;
  /** The fixture's MAC (welcome.mac): what its certificate pin is keyed by. */
  mac?: string;
  /** Its certificate SHA-256 (hex), as the sender pinned it. */
  cert?: string;
  mesh?: { meshId: number; node: number; name?: string; token?: string };
}

export interface ShareDeps {
  meshes: Pick<MeshStore, "get" | "exportBody" | "importBody" | "provisionerToken" | "putFixtureToken">;
  devices: { upsert(wssUrl: string, label?: string): { id: string } };
  pins: Pick<CertPinStore, "get" | "set">;
}

const live = (): ShareDeps => ({ meshes: meshStore, devices: deviceStore, pins: certPins });

/** What a link holds, said the way the receiver reads it before accepting. */
export interface SharePreview {
  title: string;
  lines: string[];
  /** Why it can't be added (accept is then off). */
  blocked?: string | undefined;
  /** Said under the button: what changes on this phone. */
  note?: string | undefined;
}

/** The body of a "mesh" link. */
export async function meshShareBody(meshId: number, deps: ShareDeps = live()): Promise<MeshBackupBody> {
  return deps.meshes.exportBody(meshId);
}

/** The body of a "fixture" link. The token comes from this phone's store when it holds one. */
export async function fixtureShareBody(
  f: { label: string; wssUrl: string; mac?: string | undefined; mesh?: { meshId: number; node: number; name?: string } | undefined },
  deps: ShareDeps = live(),
): Promise<FixtureShareBody> {
  const body: FixtureShareBody = { label: f.label, wssUrl: f.wssUrl };
  const mac = (f.mac ?? "").toUpperCase();
  if (mac) {
    body.mac = mac;
    const pin = deps.pins.get(mac);
    if (pin) body.cert = pin;
  }
  if (f.mesh && f.mesh.meshId && f.mesh.node) {
    const tok = await deps.meshes.provisionerToken(f.mesh.meshId, f.mesh.node).catch(() => null);
    body.mesh = { meshId: f.mesh.meshId >>> 0, node: f.mesh.node };
    if (f.mesh.name) body.mesh.name = f.mesh.name;
    if (tok) {
      body.mesh.token = toHex(tok);
      tok.fill(0);
    }
  }
  return body;
}

/** Whether a fixture link gives any admin rights (a token), or only the address. */
export function fixtureHasToken(b: FixtureShareBody): boolean {
  return !!b.mesh?.token;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export async function previewShare(env: ShareEnvelope, deps: ShareDeps = live()): Promise<SharePreview> {
  if (env.kind === "mesh") {
    const b = env.body as Partial<MeshBackupBody>;
    if (typeof b?.meshId !== "number" || !b.admin || !b.site) return { title: "A mesh", lines: [], blocked: "This link is damaged." };
    const name = (b.name ?? "").trim() || "A mesh";
    const lines = [
      `${plural(b.members?.length ?? 0, "fixture")}${b.members?.length ? `: ${b.members.map((m) => m.label).filter(Boolean).slice(0, 4).join(", ")}` : ""}`,
      "This phone will be able to add, remove and control every fixture in it.",
    ];
    const have = await deps.meshes.get(b.meshId);
    if (have && have.keyEpoch > (b.keyEpoch ?? 1)) {
      return { title: name, lines, blocked: "This link is older than the copy of the mesh on this phone (its keys changed since). Ask for a new link." };
    }
    return { title: name, lines, note: have ? "This phone already has this mesh: its copy is updated." : undefined };
  }
  const b = env.body as Partial<FixtureShareBody>;
  if (!b?.wssUrl || !b.label) return { title: "A fixture", lines: [], blocked: "This link is damaged." };
  const lines = [b.mesh?.name ? `In the mesh “${b.mesh.name}”` : b.mesh ? "In a mesh" : "Not in a mesh"];
  lines.push(
    b.mesh?.token
      ? "This phone will be able to connect to it, control it, and take it out of its mesh."
      : "This phone will be able to find it and connect to it.",
  );
  let note: string | undefined;
  if (b.mac && b.cert) {
    const known = deps.pins.get(b.mac);
    if (known && normFingerprint(known) !== normFingerprint(b.cert)) {
      note = "This phone knows this fixture with a different security certificate. It keeps its own; check the fixture if you didn't reset it.";
    }
  }
  return { title: b.label, lines, note };
}

export interface AcceptResult {
  kind: "mesh" | "fixture";
  name: string;
  /** The saved device a fixture link added (to open it). */
  deviceId?: string;
}

/** Apply an opened link to this phone. */
export async function acceptShare(env: ShareEnvelope, deps: ShareDeps = live()): Promise<AcceptResult> {
  const p = await previewShare(env, deps);
  if (p.blocked) throw new Error(p.blocked);
  if (env.kind === "mesh") {
    const rec = await deps.meshes.importBody(env.body as Partial<MeshBackupBody>);
    return { kind: "mesh", name: rec.name };
  }
  const b = env.body as FixtureShareBody;
  const dev = deps.devices.upsert(b.wssUrl, b.label);
  // Trust on first use, passed along: the pin is taken only where this phone has none.
  if (b.mac && b.cert && !deps.pins.get(b.mac)) deps.pins.set(b.mac, b.cert);
  if (b.mesh?.token) {
    const tok = fromHex(b.mesh.token);
    try {
      if (tok.length === 16) await deps.meshes.putFixtureToken(b.mesh.meshId, b.mesh.node, tok);
    } finally {
      tok.fill(0);
    }
  }
  return { kind: "fixture", name: b.label, deviceId: dev.id };
}
