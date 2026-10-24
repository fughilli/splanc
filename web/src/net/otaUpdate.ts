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
 */

import type { WelcomeMessage } from "@ledmapper/protocol";
import type { OtaStatusFlat } from "./proto";

export const MANIFEST_LEN = 108;

/** What the updater needs from a connection (LedMapperClient has all of it). */
export interface OtaDevice {
  readonly welcome: WelcomeMessage | null;
  getOtaStatus(): Promise<OtaStatusFlat>;
  otaBegin(manifest: Uint8Array, allowDowngrade?: boolean, keyEpoch?: Uint8Array): Promise<OtaStatusFlat>;
  otaChunk(offset: number, data: Uint8Array): Promise<OtaStatusFlat>;
  otaFinish(): Promise<OtaStatusFlat>;
  /** Resolve on the next connection handshake whose welcome satisfies `pred`; the
   * connection must keep reconnecting while this is pending (LedMapperClient does,
   * past its cert-trust give-up). Rejects after `timeoutMs`. */
  waitForWelcome(pred: (w: WelcomeMessage) => boolean, timeoutMs: number): Promise<WelcomeMessage>;
  /** The device is restarting (or the link stopped answering): drop the current
   * socket so the reconnect starts now instead of when TCP keepalive notices the
   * half-open connection. Optional (a transport that sees the drop itself). */
  expectRestart?(): void;
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
  | "wait" // waiting for the device to come back on Wi-Fi (message has the seconds)
  | "transfer" // streaming the image
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
  /** How long to wait for the device to come back after each restart (the app ->
   * loader handoff: a reboot, a Wi-Fi join and the TLS identity load; then the
   * loader -> new app boot). Default 180 s. */
  reconnectMs?: number;
  /** After the device answers a restart (REBOOTING / INSTALLED) it restarts ~0.4 s
   * later without closing the socket; wait this long, then drop the socket and
   * reconnect. Default 1500 ms. */
  restartSettleMs?: number;
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

/** What a user can do when the device doesn't come back — shown with every timeout. */
export const RECOVERY_TEXT =
  "If it is in its updater (recovery mode), reload this page and reconnect to it, then press " +
  "Update over Wi-Fi again — that works from the updater. An updater that isn't sent an " +
  "update returns to the current firmware by itself within 5 minutes.";

/** Wait for the device's next handshake (`pred`), reporting the elapsed seconds once
 * a second so the UI never shows a silent spinner. A timeout becomes an OtaError
 * with `code` and the user-facing `text`. */
async function awaitDevice(
  dev: OtaDevice,
  pred: (w: WelcomeMessage) => boolean,
  timeoutMs: number,
  tick: (seconds: number) => void,
  code: string,
  text: string,
  pending?: Promise<WelcomeMessage>,
): Promise<WelcomeMessage> {
  const t0 = Date.now();
  const iv = setInterval(() => tick(Math.round((Date.now() - t0) / 1000)), 1000);
  try {
    return await (pending ?? dev.waitForWelcome(pred, timeoutMs));
  } catch (e) {
    if (e instanceof OtaError) throw e;
    throw new OtaError(code, `${text} (waited ${Math.round(timeoutMs / 1000)} s)`);
  } finally {
    clearInterval(iv);
  }
}

/** A request that got no reply in time (the link stalled; the socket may still
 * look open) — as opposed to one that failed because the socket closed. */
function timedOut(e: unknown): boolean {
  return e instanceof Error && (e.name === "RequestTimeoutError" || /timed out/i.test(e.message));
}

/** How many times the app is asked to restart into the updater before giving up
 * (it can come back as the app: a restart that didn't take, or the updater's idle
 * return). */
const MAX_HANDOFFS = 3;

/** Install `pkg` on `dev`. Throws OtaError with the device's refusal code. */
export async function updateFirmware(dev: OtaDevice, pkg: Uint8Array, opts: OtaOptions = {}): Promise<OtaResult> {
  const { manifest, image, info } = splitPackage(pkg);
  const sleep = opts.sleep ?? defaultSleep;
  const reconnectMs = opts.reconnectMs ?? 180_000;
  const settleMs = opts.restartSettleMs ?? 1500;
  const total = info.size;
  const report = (phase: OtaPhase, sent: number, message?: string): void =>
    opts.onProgress?.({ phase, sent, total, version: info.version, ...(message ? { message } : {}) });
  const waiting = (what: string, sent: number) => (sec: number) =>
    report("wait", sent, `${what} (${sec} s)`);
  /** The device answered a restart: let the reply land, then drop the (about to be
   * half-open) socket so the reconnect starts now. */
  const restarting = async (): Promise<void> => {
    if (!dev.expectRestart) return;
    await sleep(settleMs);
    dev.expectRestart();
  };
  let handoffs = 0;

  /** From the app: ask it to restart into the loader and wait for the loader. */
  const handoff = async (): Promise<void> => {
    if (inLoader(dev.welcome)) return;
    const st = await dev.getOtaStatus();
    if (st.error === "legacy_layout") {
      throw new OtaError("legacy_layout", "This device needs a one-time USB update before it can update over Wi-Fi.");
    }
    for (;;) {
      if (++handoffs > MAX_HANDOFFS) {
        throw new OtaError(
          "back_in_app",
          "The device keeps coming back running its current firmware instead of its updater, so the " +
            "update didn't start. Nothing was changed; try again.",
        );
      }
      report("handoff", 0, "Restarting into the updater…");
      // Registered BEFORE the offer: from here the connection keeps reconnecting.
      const back = dev.waitForWelcome(() => true, reconnectMs);
      let r: OtaStatusFlat;
      try {
        r = await dev.otaBegin(manifest, opts.allowDowngrade ?? false, opts.keyEpoch);
      } catch (e) {
        // The reply was lost (the app may already be restarting): find out from
        // whatever comes back.
        report("handoff", 0, `No answer to the update offer (${String(e)}); waiting for the device…`);
        if (timedOut(e)) dev.expectRestart?.();
        const w = await awaitDevice(dev, () => true, reconnectMs, waiting("Waiting for the device", 0),
          "handoff_timeout", `The device didn't come back on Wi-Fi. ${RECOVERY_TEXT}`, back);
        if (inLoader(w)) return;
        continue;
      }
      if (failed(r)) {
        back.catch(() => undefined);
        throw new OtaError(r.error, `The device refused the update: ${r.error}`);
      }
      await restarting();
      const w = await awaitDevice(dev, () => true, reconnectMs, waiting("Waiting for the updater", 0),
        "handoff_timeout", `The device didn't come back in its updater. ${RECOVERY_TEXT}`, back);
      if (inLoader(w)) return;
      report("handoff", 0, "The device came back running its current firmware; asking it again…");
    }
  };

  await handoff();

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
      const at = Math.max(0, offset);
      report("resume", at, String(e));
      // A link that stopped answering (a timed-out chunk, socket still open — or
      // half-open under a device that reset): drop it and resume on a FRESH
      // connection; a late reply on the old one would otherwise be taken as the
      // answer to the next request. A socket that closed reconnects by itself.
      let w = dev.welcome;
      if (timedOut(e) && dev.expectRestart) {
        const back = dev.waitForWelcome(() => true, reconnectMs);
        dev.expectRestart();
        w = await awaitDevice(dev, () => true, reconnectMs, waiting("Reconnecting to the updater", at),
          "resume_timeout", `Lost the connection to the updater mid-transfer. ${RECOVERY_TEXT}`, back);
      } else if (!w) {
        w = await awaitDevice(dev, () => true, reconnectMs, waiting("Reconnecting to the updater", at),
          "resume_timeout", `Lost the connection to the updater mid-transfer. ${RECOVERY_TEXT}`);
      }
      // The updater gave the device back to its app (nothing was left installed):
      // hand it over again and start the transfer over.
      if (!inLoader(w)) await handoff();
      offset = -1;
    }
  }
  const transferMs = Date.now() - t0;

  report("verify", total, "Verifying…");
  const backAfterInstall = dev.waitForWelcome(() => true, reconnectMs);
  let installed = true;
  try {
    const fin = await dev.otaFinish();
    if (fin.state !== "STATE_INSTALLED") {
      backAfterInstall.catch(() => undefined);
      throw new OtaError(fin.error || "not_installed", `The image didn't install: ${fin.error}`);
    }
  } catch (e) {
    if (e instanceof OtaError) throw e;
    // The verify reply was lost: the health check below finds out what happened.
    installed = false;
    dev.expectRestart?.();
  }
  report("reboot", total, "Starting the new firmware…");
  if (installed) await restarting();
  await awaitDevice(dev, () => true, reconnectMs, waiting("Waiting for the new firmware", total),
    "reboot_timeout",
    "The image was sent and verified, but the device didn't come back on Wi-Fi after restarting into it. " +
      "Reload this page and reconnect to check which version it runs.",
    backAfterInstall);

  // The new app boots pending verify and proves itself healthy, or rolls back.
  report("health", total, "Checking the new firmware is healthy…");
  const tHealth = Date.now();
  const deadline = tHealth + (opts.healthMs ?? 240_000);
  let final: OtaStatusFlat | null = null;
  let outcome: OtaResult["outcome"] = "timeout";
  while (Date.now() < deadline) {
    try {
      if (!dev.welcome) {
        await awaitDevice(dev, () => true, Math.max(1000, deadline - Date.now()),
          waiting("Waiting for the new firmware", total), "health_timeout", "", undefined);
      }
      final = await dev.getOtaStatus();
      if (final.mode === "MODE_LOADER" && final.lastResult === "rolled_back") {
        outcome = "rolled_back";
        break;
      }
      if (final.mode === "MODE_APP" && final.lastResult === "ok" && final.appVersion === info.version) {
        outcome = "ok";
        break;
      }
      report("health", total, `Checking the new firmware is healthy (${Math.round((Date.now() - tHealth) / 1000)} s)…`);
    } catch {
      // Rebooting (a rollback restarts it) or the link stopped answering: reconnect.
      if (dev.welcome) dev.expectRestart?.();
    }
    await sleep(3000);
  }
  report(outcome === "ok" ? "done" : "rolled_back", total, outcome);
  if ((opts.expectHealthy ?? true) && outcome !== "ok") {
    throw new OtaError(
      outcome,
      outcome === "rolled_back"
        ? "The new firmware didn't start correctly; the device rolled back to its updater. Try another version."
        : "The device didn't confirm the new firmware in time. Reload this page and reconnect to check which version it runs.",
    );
  }
  return { version: info.version, outcome, resumes, final, transferMs };
}
