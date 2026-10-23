/** Over-the-air updates for a PULL device (Splanc MAX, docs/design/max-ota.md):
 * updateFirmware dispatches on the welcome's "ota_pull" feature, sends only the
 * manifest, and follows the device's own download -> verify -> reboot into the new
 * system once -> health check through get_ota_status, across reboots. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WelcomeMessage } from "@ledmapper/protocol";
import type { OtaStatusFlat } from "../src/net/proto";
import { MANIFEST_LEN, maxManifestAsset, OtaError, pullsImage, updateFirmware, type OtaDevice, type OtaProgress } from "../src/net/otaUpdate";

function manifest(version: number, size: number, sig = 1): Uint8Array {
  const m = new Uint8Array(MANIFEST_LEN);
  new DataView(m.buffer).setUint32(0, version, true);
  new DataView(m.buffer).setUint32(4, size, true);
  m.fill(sig, 44);
  return m;
}

type Outcome = "healthy" | "unhealthy";

/** The player + root updater of a Pi, advanced one step per get_ota_status poll. */
class FakeMax implements OtaDevice {
  welcome: WelcomeMessage | null = this.makeWelcome();
  appVersion = 1_009_000;
  phase: "idle" | "downloading" | "importing" | "staged" | "trial" | "failed" = "idle";
  last = "";
  error = "";
  version = 0;
  size = 0;
  fetched = 0;
  polls = 0;
  sourceUrl: string | undefined;
  begins: Uint8Array[] = [];
  private listeners: ((w: WelcomeMessage) => void)[] = [];

  constructor(
    readonly outcome: Outcome = "healthy",
    readonly downloadFails = false,
  ) {}

  makeWelcome(): WelcomeMessage {
    return { type: "welcome", features: ["ota", "ota_pull"] } as unknown as WelcomeMessage;
  }

  reboot(): void {
    this.welcome = null;
    setTimeout(() => {
      this.welcome = this.makeWelcome();
      for (const l of [...this.listeners]) l(this.welcome);
    }, 1);
  }

  waitForWelcome(pred: (w: WelcomeMessage) => boolean): Promise<WelcomeMessage> {
    return new Promise((resolve) => {
      const l = (w: WelcomeMessage): void => {
        if (!pred(w)) return;
        this.listeners = this.listeners.filter((x) => x !== l);
        resolve(w);
      };
      this.listeners.push(l);
    });
  }

  status(state: string, error = ""): OtaStatusFlat {
    return {
      mode: "MODE_APP",
      state,
      error,
      version: this.version,
      size: this.size,
      offset: this.fetched,
      appVersion: this.appVersion,
      appFwVersion: "",
      loaderReason: "",
      lastResult: this.last,
      loaderVersion: 0,
      maxChunk: 0,
      slotSize: 0,
      board: "pi3",
    };
  }

  private live(): void {
    if (!this.welcome) throw new Error("socket closed");
  }

  async otaBegin(m: Uint8Array, _down?: boolean, _epoch?: Uint8Array, sourceUrl?: string): Promise<OtaStatusFlat> {
    this.live();
    this.begins.push(m);
    if (m.length !== MANIFEST_LEN) return this.status("STATE_FAILED", "bad_manifest");
    if (m[44] === 0xee) return this.status("STATE_FAILED", "bad_signature");
    const dv = new DataView(m.buffer, m.byteOffset);
    this.version = dv.getUint32(0, true);
    this.size = dv.getUint32(4, true);
    this.sourceUrl = sourceUrl;
    this.phase = "downloading";
    this.last = "";
    this.fetched = 0;
    return this.status("STATE_DOWNLOADING");
  }

  async getOtaStatus(): Promise<OtaStatusFlat> {
    this.live();
    this.polls++;
    switch (this.phase) {
      case "downloading":
        this.fetched = Math.min(this.size, this.fetched + Math.ceil(this.size / 3));
        if (this.downloadFails && this.fetched > this.size / 2) {
          this.phase = "failed";
          this.error = "download_failed: curl exit 22";
          return this.status("STATE_FAILED", this.error);
        }
        if (this.fetched === this.size) this.phase = "importing";
        return this.status("STATE_DOWNLOADING");
      case "importing":
        this.phase = "staged";
        this.last = "installed";
        return this.status("STATE_VERIFYING");
      case "staged":
        // The updater reboots into the new system once.
        this.phase = "trial";
        setTimeout(() => this.reboot(), 0);
        return this.status("STATE_INSTALLED");
      case "trial":
        if (this.outcome === "healthy") {
          this.appVersion = this.version;
          this.last = "ok";
          this.phase = "idle";
        } else {
          // the deadline passes: back to the old system
          this.last = "rolled_back";
          this.error = "unhealthy: render loop not advancing";
          this.phase = "idle";
          this.reboot();
          throw new Error("socket closed");
        }
        return this.status("STATE_IDLE");
      case "failed":
        return this.status("STATE_FAILED", this.error);
      default:
        return this.status("STATE_IDLE", this.error);
    }
  }

  async otaChunk(): Promise<OtaStatusFlat> {
    throw new Error("a pull device never gets ota_chunk");
  }

  async otaFinish(): Promise<OtaStatusFlat> {
    throw new Error("a pull device never gets ota_finish");
  }
}

const fast = { sleep: async () => undefined, reconnectMs: 2000, pullMs: 5000 };

test("a pull device gets only the manifest and is followed to a healthy install", async () => {
  const dev = new FakeMax();
  const phases: string[] = [];
  const m = manifest(1_010_000, 300_000_000);
  // A full package works too: only its manifest goes to the device.
  const pkg = new Uint8Array(MANIFEST_LEN + 10);
  pkg.set(m);
  const r = await updateFirmware(dev, pkg, { ...fast, sourceUrl: "http://lan/x", onProgress: (p: OtaProgress) => phases.push(p.phase) });
  assert.equal(r.outcome, "ok");
  assert.equal(dev.appVersion, 1_010_000);
  assert.equal(dev.begins.length, 1);
  assert.equal(dev.begins[0]!.length, MANIFEST_LEN);
  assert.equal(dev.sourceUrl, "http://lan/x");
  for (const p of ["download", "verify", "reboot", "done"]) assert.ok(phases.includes(p), `${p} in ${phases}`);
  assert.ok(!phases.includes("transfer") && !phases.includes("handoff"));
});

test("an unhealthy new system is reported as rolled back", async () => {
  const r = await updateFirmware(new FakeMax("unhealthy"), manifest(1_010_000, 1000), { ...fast, expectHealthy: false });
  assert.equal(r.outcome, "rolled_back");
  assert.ok(r.resumes >= 1, "the Pi rebooted under the client");
  await assert.rejects(updateFirmware(new FakeMax("unhealthy"), manifest(1_010_000, 1000), fast), (e: unknown) => {
    return e instanceof OtaError && e.code === "rolled_back" && /previous version/.test(e.message);
  });
});

test("refusals and device-side failures surface with their codes", async () => {
  await assert.rejects(updateFirmware(new FakeMax(), manifest(1_010_000, 1000, 0xee), fast), (e: unknown) => {
    return e instanceof OtaError && e.code === "bad_signature";
  });
  await assert.rejects(updateFirmware(new FakeMax("healthy", true), manifest(1_010_000, 1000), fast), (e: unknown) => {
    return e instanceof OtaError && e.code.startsWith("download_failed");
  });
  await assert.rejects(updateFirmware(new FakeMax(), new Uint8Array(20), fast), (e: unknown) => {
    return e instanceof OtaError && e.code === "bad_package";
  });
});

test("dispatch and asset names", () => {
  assert.equal(pullsImage({ features: ["ota", "ota_pull"] } as unknown as WelcomeMessage), true);
  assert.equal(pullsImage({ features: ["ota"] } as unknown as WelcomeMessage), false);
  assert.equal(pullsImage(null), false);
  assert.equal(maxManifestAsset("pi3", "v1.10.0"), "max-pi3-1.10.0.manifest");
});
