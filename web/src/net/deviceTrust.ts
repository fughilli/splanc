/**
 * Per-device certificate pins, trust-on-first-use (docs/design/per-device-cert.md).
 *
 * Every player generates its own TLS key + self-signed certificate on first boot and
 * keeps it for life (no IP in it, so DHCP changes don't rotate it). The app remembers
 * the certificate SHA-256 each device id (welcome MAC) reported the first time it was
 * seen — like SSH's known_hosts — and warns when a known device later reports a
 * different one: that happens after a factory reset (flash erased -> new identity;
 * the user re-trusts) or when something else is answering as that device.
 *
 * What this can and can't prove: in a browser the TLS handshake (and the "trust this
 * certificate" exception) belongs to the browser, so the app sees the hash the device
 * REPORTS over the connection (get_tls_info), not the handshake's certificate. It
 * reliably catches a reset or a different device under a known id; the cryptographic
 * check is the browser's own per-certificate exception, which a changed certificate
 * re-triggers. The agent bridge (Node) pins the actual handshake certificate.
 *
 * Firmware before per-device certs served one shared certificate (its private key was
 * in the open-source image). A pin equal to that legacy hash is replaced silently.
 */

/** SHA-256 of the shared CN=heapless certificate every pre-per-device netstack image
 * served. Kept in sync with firmware/player_app/device_cert_core.h and
 * agent/src/trust.ts. */
export const LEGACY_SHARED_CERT_SHA256 = "9a2b1729debfa516f1b3a5ade76df3a3332b97868ed667f89298ffc574a1d641";

export function normFingerprint(fp: string | null | undefined): string {
  return (fp ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

export type CertVerdict =
  /** First time this device id reports a certificate: remembered now. */
  | { kind: "first-sight"; pin: string }
  | { kind: "known"; pin: string }
  /** The remembered pin was the legacy shared cert; re-pinned silently. */
  | { kind: "legacy-repin"; pin: string; previous: string }
  /** A different certificate than remembered for this device id. */
  | { kind: "changed"; known: string; reported: string }
  /** The device is still generating its first-boot identity (wss:443 not open yet). */
  | { kind: "generating" }
  /** Nothing to compare (no MAC, or firmware that doesn't report a certificate). */
  | { kind: "none" };

/** The pure decision: what the remembered pin and the device's report imply. */
export function decideCert(
  known: string | null | undefined,
  report: { state?: string; certSha256?: string } | null | undefined,
): CertVerdict {
  if (!report) return { kind: "none" };
  if (report.state === "generating") return { kind: "generating" };
  const reported = normFingerprint(report.certSha256);
  if (!reported) return { kind: "none" };
  const k = normFingerprint(known);
  if (!k) return { kind: "first-sight", pin: reported };
  if (k === reported) return { kind: "known", pin: k };
  if (k === LEGACY_SHARED_CERT_SHA256) return { kind: "legacy-repin", pin: reported, previous: k };
  return { kind: "changed", known: k, reported };
}

const KEY = "ledmapper.certPins";

interface PinRecord {
  sha256: string;
  /** ISO time the pin was set (first sight or re-trust). */
  since: string;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** localStorage-backed device-id -> certificate pin map (the app's known_hosts). */
export class CertPinStore {
  constructor(private readonly storage: () => Storage | null = () => globalThis.localStorage ?? null) {}

  private read(): Record<string, PinRecord> {
    try {
      const raw = this.storage()?.getItem(KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : {};
      return v && typeof v === "object" ? (v as Record<string, PinRecord>) : {};
    } catch {
      return {};
    }
  }

  private write(m: Record<string, PinRecord>): void {
    try {
      this.storage()?.setItem(KEY, JSON.stringify(m));
    } catch {
      // Private mode / quota: TOFU degrades to "first sight" every session.
    }
  }

  get(mac: string): string | undefined {
    return this.read()[mac.toUpperCase()]?.sha256;
  }

  set(mac: string, sha256: string): void {
    const m = this.read();
    m[mac.toUpperCase()] = { sha256: normFingerprint(sha256), since: new Date().toISOString() };
    this.write(m);
  }

  forget(mac: string): void {
    const m = this.read();
    delete m[mac.toUpperCase()];
    this.write(m);
  }

  /** Decide on a device's report and record what TOFU accepts (first sight, legacy
   * re-pin). A "changed" verdict is NOT recorded — the caller warns, and only an
   * explicit {@link CertPinStore.retrust} replaces the pin. */
  check(mac: string, report: { state?: string; certSha256?: string } | null | undefined): CertVerdict {
    if (!mac) return { kind: "none" };
    const v = decideCert(this.get(mac), report);
    if (v.kind === "first-sight" || v.kind === "legacy-repin") this.set(mac, v.pin);
    return v;
  }

  /** The user confirmed a factory reset: accept the device's new certificate. */
  retrust(mac: string, sha256: string): void {
    this.set(mac, sha256);
  }
}

export const certPins = new CertPinStore();

/** The warning shown for a "changed" verdict. */
export function certChangedMessage(label: string): string {
  return (
    `${label}'s security certificate changed since you first connected. A device keeps one certificate for ` +
    `life, so this is expected only if it was factory-reset (its flash erased). If you didn't reset it, ` +
    `another device may be answering as it — disconnect.`
  );
}
