/**
 * Trust-on-first-use pinning of each player's TLS certificate, keyed by device id
 * (the MAC) — like SSH's known_hosts (docs/design/per-device-cert.md).
 *
 * Every player generates its own EC P-256 key + self-signed certificate on first
 * boot; the certificate never changes for the life of the device (it carries no IP,
 * so DHCP doesn't rotate it). So the first certificate the bridge sees for an id is
 * remembered (hub.json `players[id].pin`), and a later, different certificate for the
 * same id is refused with a clear warning: either the device was factory-reset
 * (flash erased -> a new identity; re-trust it with `trust_player`) or something else
 * is answering as that device.
 *
 * Firmware before per-device certs served ONE shared certificate (its key was in the
 * open-source image, so it proved nothing). A remembered pin equal to that legacy hash
 * is replaced silently: the upgrade to a per-device cert is expected, not an attack.
 */

/** SHA-256 of the shared CN=heapless certificate every pre-per-device netstack image
 * served. Kept in sync with firmware/player_app/device_cert_core.h and
 * web/src/net/deviceTrust.ts. */
export const LEGACY_SHARED_CERT_SHA256 = "9a2b1729debfa516f1b3a5ade76df3a3332b97868ed667f89298ffc574a1d641";

export function normFingerprint(fp: string | null | undefined): string {
  return (fp ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

export function isLegacyShared(fp: string | null | undefined): boolean {
  return normFingerprint(fp) === LEGACY_SHARED_CERT_SHA256;
}

export type TrustVerdict =
  /** The operator pinned a certificate explicitly (--pin): only that one is accepted. */
  | { kind: "operator"; pin: string }
  /** First time we see this device id: remember what it presented. */
  | { kind: "first-sight"; pin: string }
  /** Same certificate as remembered. */
  | { kind: "known"; pin: string }
  /** The remembered pin was the legacy shared cert; the device now has its own. */
  | { kind: "legacy-repin"; pin: string; previous: string }
  /** A DIFFERENT certificate than remembered for this id: refuse until re-trusted. */
  | { kind: "changed"; pin: string; presented: string }
  /** The manifest names a certificate other than the one the connection presented. */
  | { kind: "mismatch"; presented: string; claimed: string }
  /** Nothing to pin against (no device id or no certificate seen). */
  | { kind: "unverified" };

export interface TrustInput {
  /** The device id (MAC) the manifest names. */
  id?: string | undefined;
  /** SHA-256 of the certificate the connection actually presented. */
  presented?: string | null | undefined;
  /** The manifest's tls.cert_sha256 (a claim, over that same connection). */
  claimed?: string | null | undefined;
  /** The pin remembered for this id. */
  known?: string | null | undefined;
  /** An explicit operator pin (--pin). */
  operatorPin?: string | null | undefined;
}

/** Decide whether to trust what a player presented. Pure; see {@link TrustVerdict}. */
export function decideTrust(t: TrustInput): TrustVerdict {
  const presented = normFingerprint(t.presented);
  const claimed = normFingerprint(t.claimed);
  const known = normFingerprint(t.known);
  const op = normFingerprint(t.operatorPin);
  if (op) return { kind: "operator", pin: op };
  if (!presented) return known ? { kind: "known", pin: known } : { kind: "unverified" };
  if (claimed && claimed !== presented) return { kind: "mismatch", presented, claimed };
  if (!t.id) return { kind: "unverified" };
  if (!known) return { kind: "first-sight", pin: presented };
  if (known === presented) return { kind: "known", pin: known };
  if (known === LEGACY_SHARED_CERT_SHA256) return { kind: "legacy-repin", pin: presented, previous: known };
  return { kind: "changed", pin: known, presented };
}

/** Whether a verdict lets the bridge connect (and remember `pin`). */
export function trusted(
  v: TrustVerdict,
): v is Extract<TrustVerdict, { kind: "operator" | "first-sight" | "known" | "legacy-repin" }> {
  return v.kind === "operator" || v.kind === "first-sight" || v.kind === "known" || v.kind === "legacy-repin";
}

/** The operator-facing explanation for a refused verdict. */
export function trustError(name: string, id: string, v: TrustVerdict): string | null {
  if (v.kind === "changed") {
    return (
      `REFUSING ${name} (${id}): its TLS certificate changed (remembered sha256 ${short(v.pin)}, ` +
      `now presenting ${short(v.presented)}). A player keeps one certificate for life, so either it was factory-reset ` +
      `(flash erased) — then re-trust it with trust_player {player: "${id}"} (CLI: trust-player ${id}) — or another ` +
      `device is answering as it.`
    );
  }
  if (v.kind === "mismatch") {
    return (
      `REFUSING ${name} (${id}): the connection presented certificate ${short(v.presented)} but the player's ` +
      `manifest names ${short(v.claimed)} — something between the bridge and the player is intercepting TLS.`
    );
  }
  return null;
}

function short(fp: string): string {
  return `${fp.slice(0, 16)}…`;
}
