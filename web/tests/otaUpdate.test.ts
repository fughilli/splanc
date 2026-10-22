/** Over-the-air firmware update driver (net/otaUpdate.ts) against a simulated
 * device: the app -> loader handoff, the stop-and-wait stream, resume after a reset,
 * the health wait, rollback and refusals (docs/design/ota.md). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WelcomeMessage } from "@ledmapper/protocol";
import type { OtaStatusFlat } from "../src/net/proto";
import {
  inLoader,
  MANIFEST_LEN,
  OtaError,
  splitPackage,
  updateFirmware,
  versionNumber,
  type OtaDevice,
  type OtaProgress,
} from "../src/net/otaUpdate";

function u32le(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}

function pkg(image: Uint8Array, version: number, goodSig = true): Uint8Array {
  const m = new Uint8Array(MANIFEST_LEN);
  m.set(u32le(version), 0);
  m.set(u32le(image.length), 4);
  m.fill(goodSig ? 1 : 0xee, 44);
  const out = new Uint8Array(MANIFEST_LEN + image.length);
  out.set(m);
  out.set(image, MANIFEST_LEN);
  return out;
}

type Mode = "app" | "handoff" | "loader" | "installed";

class FakeDevice implements OtaDevice {
  mode: Mode = "app";
  slot = new Uint8Array(400_000);
  appVersion = 0;
  last = "";
  session: { manifest: Uint8Array; next: number } | null = null;
  job: { manifest: Uint8Array; offset: number } | null = null;
  pending: { version: number; image: Uint8Array } | null = null;
  healthPolls = 0;
  welcome: WelcomeMessage | null = this.makeWelcome();
  private listeners: ((w: WelcomeMessage) => void)[] = [];
  legacy = false;
  failNextChunkAt = -1;

  makeWelcome(): WelcomeMessage {
    const w = { type: "welcome", fwVersion: "1.0" } as unknown as WelcomeMessage & { ota?: { mode: string } };
    if (this.mode === "loader") w.ota = { mode: "MODE_LOADER" };
    return w;
  }

  /** The device restarts: the socket drops, then a fresh welcome arrives. */
  reboot(): void {
    this.welcome = null;
    if (this.mode === "handoff") this.mode = "loader";
    else if (this.mode === "installed") {
      const p = this.pending!;
      const crashes = p.image[0] === 0x43; // "C"
      if (crashes) {
        this.mode = "loader";
        this.last = "rolled_back";
        this.pending = null;
      } else {
        this.mode = "app";
        this.appVersion = p.version;
        this.healthPolls = 0;
      }
    }
    this.session = null;
    queueMicrotask(() => {
      this.welcome = this.makeWelcome();
      for (const l of [...this.listeners]) l(this.welcome);
    });
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
      mode: this.mode === "loader" ? "MODE_LOADER" : "MODE_APP",
      state,
      error: this.legacy ? "legacy_layout" : error,
      version: 0,
      size: 0,
      offset: this.session?.next ?? 0,
      appVersion: this.appVersion,
      appFwVersion: "",
      loaderReason: "",
      lastResult: this.last,
      loaderVersion: 0,
      maxChunk: 4096,
      slotSize: this.slot.length,
    };
  }

  private live(): void {
    if (!this.welcome) throw new Error("socket closed");
  }

  async getOtaStatus(): Promise<OtaStatusFlat> {
    this.live();
    if (this.mode === "app" && this.pending && this.healthPolls++ >= 1) {
      this.last = "ok";
      this.pending = null;
    }
    return this.status("STATE_IDLE");
  }

  async otaBegin(manifest: Uint8Array): Promise<OtaStatusFlat> {
    this.live();
    if (this.mode === "app") {
      this.mode = "handoff";
      setTimeout(() => this.reboot(), 1);
      return this.status("STATE_REBOOTING");
    }
    if (manifest[44] === 0xee) return this.status("STATE_FAILED", "bad_signature");
    const same = this.job && this.job.manifest.every((b, i) => b === manifest[i]);
    const off = same ? Math.floor(this.job!.offset / 4096) * 4096 : 0;
    this.session = { manifest, next: off };
    this.job = { manifest, offset: off };
    return this.status("STATE_RECEIVING");
  }

  async otaChunk(offset: number, data: Uint8Array): Promise<OtaStatusFlat> {
    this.live();
    const s = this.session!;
    if (offset !== s.next) return this.status("STATE_FAILED", "out_of_order");
    if (this.failNextChunkAt >= 0 && offset >= this.failNextChunkAt) {
      this.failNextChunkAt = -1;
      this.reboot(); // a reset mid-transfer: back in the loader with the job kept
      throw new Error("socket closed");
    }
    this.slot.set(data, offset);
    s.next += data.length;
    if (Math.floor(s.next / 65536) > Math.floor(this.job!.offset / 65536)) this.job!.offset = s.next;
    return this.status("STATE_RECEIVING");
  }

  async otaFinish(): Promise<OtaStatusFlat> {
    this.live();
    const s = this.session!;
    const size = s.manifest[4]! | (s.manifest[5]! << 8) | (s.manifest[6]! << 16);
    if (s.next !== size) return this.status("STATE_FAILED", "incomplete");
    const version = s.manifest[0]! | (s.manifest[1]! << 8) | (s.manifest[2]! << 16) | (s.manifest[3]! << 24);
    this.pending = { version, image: this.slot.slice(0, size) };
    this.last = "installed";
    this.job = null;
    this.mode = "installed";
    const st = this.status("STATE_INSTALLED");
    setTimeout(() => this.reboot(), 1);
    return st;
  }
}

const fast = { sleep: async () => undefined, reconnectMs: 2000, healthMs: 2000 };

test("an update hands over to the loader, streams, and waits for health", async () => {
  const dev = new FakeDevice();
  const image = new Uint8Array(150_000).map((_, i) => (i * 7) & 255);
  image[0] = 0xe9;
  const phases: string[] = [];
  const r = await updateFirmware(dev, pkg(image, 1_009_000), {
    ...fast,
    onProgress: (p: OtaProgress) => phases.push(p.phase),
  });
  assert.equal(r.outcome, "ok");
  assert.equal(dev.appVersion, 1_009_000);
  assert.deepEqual(dev.slot.subarray(0, image.length), image);
  assert.equal(phases[0], "handoff");
  for (const p of ["transfer", "verify", "reboot", "health", "done"]) assert.ok(phases.includes(p), p);
});

test("a reset mid-transfer resumes from the persisted offset", async () => {
  const dev = new FakeDevice();
  const image = new Uint8Array(300_000).map((_, i) => (i * 13) & 255);
  image[0] = 0xe9;
  dev.failNextChunkAt = 150_000;
  const r = await updateFirmware(dev, pkg(image, 2), fast);
  assert.equal(r.outcome, "ok");
  assert.equal(r.resumes, 1);
  assert.deepEqual(dev.slot.subarray(0, image.length), image);
});

test("a rolled-back image is reported", async () => {
  const image = new Uint8Array(20_000);
  image[0] = 0x43; // the fake's "crashes at boot" marker
  const r = await updateFirmware(new FakeDevice(), pkg(image, 3), { ...fast, expectHealthy: false });
  assert.equal(r.outcome, "rolled_back");
  await assert.rejects(updateFirmware(new FakeDevice(), pkg(image, 3), fast), (e: unknown) => {
    return e instanceof OtaError && e.code === "rolled_back";
  });
});

test("the loader's refusals surface with their codes", async () => {
  const bad = pkg(new Uint8Array(5000), 4, false);
  await assert.rejects(updateFirmware(new FakeDevice(), bad, fast), (e: unknown) => {
    return e instanceof OtaError && e.code === "bad_signature";
  });
  const legacy = new FakeDevice();
  legacy.legacy = true;
  await assert.rejects(updateFirmware(legacy, pkg(new Uint8Array(5000), 4), fast), (e: unknown) => {
    return e instanceof OtaError && e.code === "legacy_layout";
  });
});

test("packages and versions parse", () => {
  const p = splitPackage(pkg(new Uint8Array(10), 1_010_002));
  assert.equal(p.info.version, 1_010_002);
  assert.equal(p.image.length, 10);
  assert.throws(() => splitPackage(new Uint8Array(50)), OtaError);
  const truncated = pkg(new Uint8Array(10), 1).subarray(0, MANIFEST_LEN + 5);
  assert.throws(() => splitPackage(truncated), OtaError);
  assert.equal(versionNumber("1.9.0"), 1_009_000);
  assert.equal(versionNumber("v2.0.13-3-gabc"), 2_000_013);
  assert.equal(versionNumber("dev"), null);
  assert.equal(inLoader({ ota: { mode: "MODE_LOADER" } } as unknown as WelcomeMessage), true);
  assert.equal(inLoader({} as WelcomeMessage), false);
});
