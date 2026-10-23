/**
 * Firmware update over Wi-Fi (docs/design/ota.md) — the client side, shared by the
 * web app's Flash screen and the agent's `update_firmware` tool.
 *
 * The image always goes to the device's update LOADER, never the running app:
 *   1. the app checks the signed manifest (ota_begin) and restarts into the loader;
 *   2. we wait for the loader's welcome (welcome.ota.mode == MODE_LOADER), send
 *      ota_begin again, then stream the image stop-and-wait in ota_chunks;
 *      a dropped link or a device reset resumes from the offset the loader reports;
 *   3. ota_finish: the loader re-hashes the slot against the signed digest and
 *      boots the new app;
 *   4. the new app must prove healthy (≈20 s) before it marks itself valid; if it
 *      crashes or stays unhealthy the device rolls back to the loader, which says
 *      so (last_result "rolled_back").
 *
 * `.ota` package = the 108-byte signed manifest followed by the image. Pure logic
 * against the `OtaDevice` seam (LedMapperClient implements it), unit-tested with a
 * simulated device in web/tests/otaUpdate.test.ts; the Python HITL client
 * (pi/hitl/harness/ota_core.py) is the same state machine.
 *
 * A Splanc MAX (Raspberry Pi, docs/design/max-ota.md; welcome feature "ota_pull")
 * PULLS its image: the client sends only the manifest (`max-<board>-<ver>.manifest`,
 * 108 bytes — a full package works too, its image is ignored) and follows the
 * device's own download, verify, reboot into the new system once, and health check
 * by polling get_ota_status (pullUpdate below). `updateFirmware` dispatches on the
 * device, so every caller (Flash screen, agent, bridge) handles both.
 */

import type { WelcomeMessage } from "@ledmapper/protocol";
import type { OtaStatusFlat } from "./proto";

export const MANIFEST_LEN = 108;

/** What the updater needs from a connection (LedMapperClient has all of it). */
export interface OtaDevice {
  readonly welcome: WelcomeMessage | null;
  getOtaStatus(): Promise<OtaStatusFlat>;
  otaBegin(manifest: Uint8Array, allowDowngrade?: boolean, keyEpoch?: Uint8Array, sourceUrl?: string): Promise<OtaStatusFlat>;
  otaChunk(offset: number, data: Uint8Array): Promise<OtaStatusFlat>;
  otaFinish(): Promise<OtaStatusFlat>;
  waitForWelcome(pred: (w: WelcomeMessage) => boolean, timeoutMs: number): Promise<WelcomeMessage>;
}

export interface OtaManifest {
  version: number;
  size: number;
  sha256: Uint8Array;
  flags: number;
}

export interface OtaPackage {
  manifest: Uint8Array;
  image: Uint8Array;
  info: OtaManifest;
}

export class OtaError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OtaError";
  }
}

export type OtaPhase =
  | "handoff" // the app is restarting into the loader
  | "transfer" // streaming the image
  | "download" // a pull device (Splanc MAX) is fetching the image itself
  | "resume" // the link dropped; resuming
  | "verify" // the loader is checking the image
  | "reboot" // booting the new app
  | "health" // waiting for it to prove healthy
  | "done"
  | "rolled_back";

export interface OtaProgress {
  phase: OtaPhase;
  sent: number;
  total: number;
  version: number;
  message?: string;
}

export interface OtaOptions {
  allowDowngrade?: boolean;
  onProgress?: (p: OtaProgress) => void;
  /** How long to wait for the device to come back after each restart. */
  reconnectMs?: number;
  /** How long the new app gets to prove healthy (its own deadline is 120 s). */
  healthMs?: number;
  maxResumes?: number;
  /** Override the chunk size (≤ the device's max_chunk). */
  chunkBytes?: number;
  /** The newest signed key-epoch record (80 B, docs/design/ota.md "Key rotation") —
   * how a key revocation reaches devices. Sent with every ota_begin. */
  keyEpoch?: Uint8Array;
  /** Return once the outcome is known instead of throwing on a rollback. */
  expectHealthy?: boolean;
  /** Pull devices: fetch the image from this URL instead of the release (dev / LAN). */
  sourceUrl?: string;
  /** Pull devices: the whole update — download, import, reboot, health (default 30 min). */
  pullMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface OtaResult {
  version: number;
  outcome: "ok" | "rolled_back" | "timeout";
  resumes: number;
  final: OtaStatusFlat | null;
  transferMs: number;
}

function u32(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

/** The manifest's fields (the signature is the device's to check). */
export function parseManifest(m: Uint8Array): OtaManifest {
  if (m.length !== MANIFEST_LEN) throw new OtaError("bad_package", `manifest is ${m.length} bytes`);
  return { version: u32(m, 0), size: u32(m, 4), sha256: m.slice(8, 40), flags: u32(m, 40) };
}

/** A release version string as the manifest's number (1.9.0 -> 1009000). */
export function versionNumber(v: string): number | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (min > 999 || pat > 999) return null;
  return maj * 1_000_000 + min * 1_000 + pat;
}

/** Split an `.ota` package; checks the image length against the manifest (the
 * digest and signature are verified by the device). */
export function splitPackage(pkg: Uint8Array): OtaPackage {
  if (pkg.length <= MANIFEST_LEN) throw new OtaError("bad_package", "package too short");
  const manifest = pkg.slice(0, MANIFEST_LEN);
  const image = pkg.subarray(MANIFEST_LEN);
  const info = parseManifest(manifest);
  if (info.size !== image.length) throw new OtaError("bad_package", "image length doesn't match the manifest");
  return { manifest, image, info };
}

export function inLoader(w: WelcomeMessage | null): boolean {
  const ota = (w as unknown as { ota?: { mode?: string } } | null)?.ota;
  return ota?.mode === "MODE_LOADER";
}

function failed(st: OtaStatusFlat): boolean {
  return st.state === "STATE_FAILED";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A device that downloads its own image (Splanc MAX: welcome feature "ota_pull"). */
export function pullsImage(w: WelcomeMessage | null): boolean {
  return ((w?.features as string[] | undefined) ?? []).includes("ota_pull");
}

/** The release asset holding a pull device's manifest (`board` from ota_status.board). */
export function maxManifestAsset(board: string, version: string): string {
  const v = version.replace(/^v/, "");
  return `max-${board}-${v}.manifest`;
}

/** Install `pkg` on `dev`. Throws OtaError with the device's refusal code. A pull
 * device takes just the manifest (the first 108 bytes of `pkg`). */
export async function updateFirmware(dev: OtaDevice, pkg: Uint8Array, opts: OtaOptions = {}): Promise<OtaResult> {
  if (pullsImage(dev.welcome)) {
    if (pkg.length < MANIFEST_LEN) throw new OtaError("bad_package", "package too short");
    return pullUpdate(dev, pkg.slice(0, MANIFEST_LEN), opts);
  }
  const { manifest, image, info } = splitPackage(pkg);
  const sleep = opts.sleep ?? defaultSleep;
  const reconnectMs = opts.reconnectMs ?? 120_000;
  const total = info.size;
  const report = (phase: OtaPhase, sent: number, message?: string): void =>
    opts.onProgress?.({ phase, sent, total, version: info.version, ...(message ? { message } : {}) });

  if (!inLoader(dev.welcome)) {
    const st = await dev.getOtaStatus();
    if (st.error === "legacy_layout") {
      throw new OtaError("legacy_layout", "This device needs a one-time USB update before it can update over Wi-Fi.");
    }
    report("handoff", 0, "Restarting into the updater…");
    const back = dev.waitForWelcome(inLoader, reconnectMs);
    const r = await dev.otaBegin(manifest, opts.allowDowngrade ?? false, opts.keyEpoch);
    if (failed(r)) {
      back.catch(() => undefined);
      throw new OtaError(r.error, `The device refused the update: ${r.error}`);
    }
    await back;
  }

  const t0 = Date.now();
  let resumes = 0;
  let offset = -1;
  let chunk = 4096;
  for (;;) {
    try {
      if (offset < 0) {
        const st = await dev.otaBegin(manifest, opts.allowDowngrade ?? false, opts.keyEpoch);
        if (failed(st)) throw new OtaError(st.error, `The updater refused the image: ${st.error}`);
        offset = st.offset;
        chunk = Math.min(opts.chunkBytes ?? st.maxChunk ?? 4096, st.maxChunk || 4096);
        report("transfer", offset);
      }
      while (offset < total) {
        const end = Math.min(offset + chunk, total);
        const st = await dev.otaChunk(offset, image.subarray(offset, end));
        if (failed(st) && st.error !== "out_of_order") throw new OtaError(st.error, `Chunk at ${offset}: ${st.error}`);
        offset = st.offset;
        report("transfer", offset);
      }
      break;
    } catch (e) {
      if (e instanceof OtaError) throw e;
      if (++resumes > (opts.maxResumes ?? 8)) throw new OtaError("link", `Gave up after ${resumes - 1} resumes: ${String(e)}`);
      report("resume", Math.max(0, offset), String(e));
      if (!inLoader(dev.welcome)) await dev.waitForWelcome(inLoader, reconnectMs);
      offset = -1;
    }
  }
  const transferMs = Date.now() - t0;

  report("verify", total, "Verifying…");
  const backAfterInstall = dev.waitForWelcome(() => true, reconnectMs);
  const fin = await dev.otaFinish();
  if (fin.state !== "STATE_INSTALLED") {
    backAfterInstall.catch(() => undefined);
    throw new OtaError(fin.error || "not_installed", `The image didn't install: ${fin.error}`);
  }
  report("reboot", total, "Starting the new firmware…");
  await backAfterInstall;

  // The new app boots pending verify and proves itself healthy, or rolls back.
  report("health", total, "Checking the new firmware is healthy…");
  const deadline = Date.now() + (opts.healthMs ?? 240_000);
  let final: OtaStatusFlat | null = null;
  let outcome: OtaResult["outcome"] = "timeout";
  while (Date.now() < deadline) {
    try {
      if (!dev.welcome) await dev.waitForWelcome(() => true, Math.max(1000, deadline - Date.now()));
      final = await dev.getOtaStatus();
      if (final.mode === "MODE_LOADER" && final.lastResult === "rolled_back") {
        outcome = "rolled_back";
        break;
      }
      if (final.mode === "MODE_APP" && final.lastResult === "ok" && final.appVersion === info.version) {
        outcome = "ok";
        break;
      }
    } catch {
      // rebooting (a rollback restarts it) — try again
    }
    await sleep(3000);
  }
  report(outcome === "ok" ? "done" : "rolled_back", total, outcome);
  if ((opts.expectHealthy ?? true) && outcome !== "ok") {
    throw new OtaError(
      outcome,
      outcome === "rolled_back"
        ? "The new firmware didn't start correctly; the device rolled back to its updater. Try another version."
        : "The device didn't confirm the new firmware in time.",
    );
  }
  return { version: info.version, outcome, resumes, final, transferMs };
}

/**
 * A pull device (Splanc MAX): offer the manifest, then follow the device's own
 * download -> import -> reboot into the new system ONCE -> health check, by polling
 * get_ota_status. The link may drop at any time (the Pi reboots; a phone sleeps):
 * the device carries on by itself, and this just reconnects and keeps reading.
 * Outcome "ok" = the new system proved healthy and is now the default;
 * "rolled_back" = it didn't, and the Pi is back on its old system.
 */
export async function pullUpdate(dev: OtaDevice, manifest: Uint8Array, opts: OtaOptions = {}): Promise<OtaResult> {
  const info = parseManifest(manifest);
  const sleep = opts.sleep ?? defaultSleep;
  const reconnectMs = opts.reconnectMs ?? 180_000;
  const total = info.size;
  const report = (phase: OtaPhase, sent: number, message?: string): void =>
    opts.onProgress?.({ phase, sent, total, version: info.version, ...(message ? { message } : {}) });

  const t0 = Date.now();
  const begun = await dev.otaBegin(manifest, opts.allowDowngrade ?? false, opts.keyEpoch, opts.sourceUrl);
  if (failed(begun)) throw new OtaError(begun.error, `The device refused the update: ${begun.error}`);
  report("download", begun.offset, "The device is downloading the firmware…");

  const deadline = t0 + (opts.pullMs ?? 30 * 60_000);
  let installed = false;
  let transferMs = 0;
  let resumes = 0;
  let final: OtaStatusFlat | null = begun;
  let outcome: OtaResult["outcome"] = "timeout";
  let st: OtaStatusFlat | null = begun;
  for (;;) {
    if (st) {
      final = st;
      const mine = st.version === info.version;
      if (st.state === "STATE_FAILED" && !installed) {
        throw new OtaError(st.error || "failed", `The update failed on the device: ${st.error}`);
      } else if (st.state === "STATE_DOWNLOADING") {
        report("download", st.offset);
      } else if (st.state === "STATE_VERIFYING") {
        transferMs ||= Date.now() - t0;
        report("verify", total, "Verifying and installing…");
      } else if (st.state === "STATE_INSTALLED") {
        transferMs ||= Date.now() - t0;
        if (!installed) report("reboot", total, "Starting the new firmware…");
        installed = true;
      } else if (st.state === "STATE_IDLE") {
        if (st.lastResult === "ok" && st.appVersion === info.version) {
          outcome = "ok";
          break;
        }
        if (st.lastResult === "rolled_back" && (installed || mine)) {
          outcome = "rolled_back";
          break;
        }
        if (st.lastResult === "installed") {
          if (!installed) report("reboot", total);
          installed = true;
          report("health", total, "Checking the new firmware is healthy…");
        } else if (st.lastResult === "aborted") {
          throw new OtaError("aborted", "The update was cancelled on the device.");
        }
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(2000);
    try {
      if (!dev.welcome) await dev.waitForWelcome(() => true, Math.max(1000, Math.min(reconnectMs, deadline - Date.now())));
      st = await dev.getOtaStatus();
    } catch {
      // rebooting (into the new system, or back to the old one) — keep reading
      resumes++;
      st = null;
    }
  }
  report(outcome === "ok" ? "done" : "rolled_back", total, outcome);
  if ((opts.expectHealthy ?? true) && outcome !== "ok") {
    throw new OtaError(
      outcome,
      outcome === "rolled_back"
        ? `The new firmware didn't start correctly; the device went back to its previous version${final?.error ? ` (${final.error})` : ""}.`
        : "The device didn't confirm the new firmware in time.",
    );
  }
  return { version: info.version, outcome, resumes, final, transferMs };
}
