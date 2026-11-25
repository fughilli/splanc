/**
 * The Matter bridge (docs/design/smart-home-integrations.md section 4; docs/guides/matter.md):
 * every lamp the bridge knows becomes a bridged Matter light, so Apple Home, Home
 * Assistant, Alexa or SmartThings control it locally. One commissioning covers every
 * lamp, current and future.
 *
 *   controller ──Matter (UDP, IPv6/IPv4, port 5540)──▶ this ServerNode (Aggregator)
 *                                                        ├─ "Coil (bedroom)"  Dimmable Light
 *                                                        └─ …                  Dimmable Light
 *                                                      LampDriver (lamps.ts) ─▶ hub ─▶ lamps
 *
 * Stack: matter.js (@matter/main), the TypeScript implementation Matterbridge and
 * Home Assistant Matter Hub build on. It runs inside the bridge's own Node process, so
 * on a 512 MB Pi 3 A+ it adds the matter.js heap (tens of MB) to a process that already
 * runs, rather than a second runtime (the CHIP SDK's C++ bridge-app would need its own
 * process, an IPC to the hub, and a CHIP build for every target).
 *
 * Mapping: OnOff -> set_power (the lamp's ON/OFF transition plays), LevelControl ->
 * set_brightness (level 1..254 <-> 0..1). The lamp's power_state pushes flow back as
 * attribute changes, so a lid tap shows up in the controller. Reachable follows the
 * bridge's view of the lamp. Colour is not offered yet: Splanc has no colour
 * convention (a well-known `color` uniform), see the study's section 1.
 *
 * Identity: the CSA test vendor id 0xFFF1 and product 0x8001 with matter.js's test
 * attestation (DAC/PAI chained to the test PAA). Controllers show it as an
 * uncertified device (Apple: "Add Anyway"); Google Home refuses it for consumer
 * accounts. docs/design/matter-certification.md is the route to a certified bridge.
 */

import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

import type { LampDriver, LampInfo, LampState } from "./lamps";
import { writeAtomic } from "./lanBridge";

/** The CSA's test vendor id (no certification: controllers warn, Google refuses). */
export const TEST_VENDOR_ID = 0xfff1;
/** A product id from the test range 0x8000..0x801F. */
export const TEST_PRODUCT_ID = 0x8001;
export const DEFAULT_MATTER_PORT = 5540;
const LEVEL_MAX = 254;
/** A slider drag sends many level changes: forward the last one after this quiet gap. */
const LEVEL_DEBOUNCE_MS = 150;

export type MatterState = "starting" | "ready" | "error" | "stopped";

/** The `matter` block of the bridge status file (display contract, optional in v1). */
export interface MatterStatus {
  state: MatterState;
  /** At least one controller (fabric) has commissioned the bridge. */
  commissioned: boolean;
  /** The bridge is advertising itself for commissioning (pairing codes are valid). */
  commissionable: boolean;
  /** "MT:…" QR payload and the 11-digit manual code (shown on the OLED/HDMI). */
  qr: string;
  manual: string;
  /** The controllers that commissioned it (their fabric labels / vendor ids). */
  fabrics: { label: string; vendor: number }[];
  lamps: number;
  port: number;
  error: string | null;
}

export interface MatterBridgeOptions {
  lamps: LampDriver;
  /** Fabric data, the pairing credentials and endpoint numbers live here. */
  stateDir: string;
  port?: number;
  /** BasicInformation serial / unique id seed (the bridge id). */
  serial?: string;
  log?: (...a: unknown[]) => void;
  /** Called whenever the status block changes (the bridge rewrites status.json). */
  onChange?: () => void;
  /** Tests: a private matter.js environment (default: the process's). */
  environment?: Environment;
}

/** Passcodes the Matter spec forbids (Core spec 5.1.7.1). */
const INVALID_PASSCODES = new Set([0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321]);

export interface PairingSecrets {
  passcode: number;
  discriminator: number;
  uniqueId: string;
}

/** This bridge's setup passcode + discriminator: random once, then kept (a reflash of
 * the card makes new ones). Never the well-known 20202021 test code. */
export function loadPairingSecrets(dir: string, rand: (max: number) => number = (m) => randomInt(m)): PairingSecrets {
  const file = join(dir, "pairing.json");
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as PairingSecrets;
    if (validPasscode(p.passcode) && p.discriminator >= 0 && p.discriminator <= 0xfff && p.uniqueId) return p;
  } catch {
    // none yet
  }
  let passcode = 0;
  while (!validPasscode(passcode)) passcode = 1 + rand(99_999_998);
  const p: PairingSecrets = { passcode, discriminator: rand(0x1000), uniqueId: randomBytes(16).toString("hex") };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(file, JSON.stringify(p), 0o600);
  return p;
}

export function validPasscode(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 99_999_998 && !INVALID_PASSCODES.has(n);
}

export const levelOf = (brightness: number): number => Math.max(1, Math.min(LEVEL_MAX, Math.round(brightness * LEVEL_MAX)));
export const brightnessOf = (level: number): number => Math.max(0, Math.min(1, level / LEVEL_MAX));

/** A Matter endpoint id for a lamp (stable across restarts: matter.js keeps the
 * endpoint NUMBER per id, so a controller's automations keep pointing at it). */
export function endpointId(lampId: string): string {
  return `lamp-${lampId.replace(/[^0-9A-Za-z]/g, "").toLowerCase()}`;
}

/** Labels are at most 32 bytes in BridgedDeviceBasicInformation. */
export function label(s: string): string {
  let out = s;
  while (Buffer.byteLength(out, "utf8") > 32) out = out.slice(0, -1);
  return out;
}

export function lampLabel(l: LampInfo): string {
  return label(l.room ? `${l.name} (${l.room})` : l.name);
}

type LightEndpoint = Endpoint<ReturnType<typeof DimmableLightDevice.with<[typeof BridgedDeviceBasicInformationServer]>>>;

interface Bridged {
  ep: LightEndpoint;
  /** Applying the lamp's own state: the attribute events it causes are not commands. */
  applying: number;
  levelTimer: ReturnType<typeof setTimeout> | null;
  label: string;
}

export class MatterBridge {
  private server: ServerNode | null = null;
  private aggregator: Endpoint<typeof AggregatorEndpoint> | null = null;
  private readonly bridged = new Map<string, Bridged>();
  private st: MatterState = "stopped";
  private error: string | null = null;
  private unsubs: (() => void)[] = [];
  private readonly log: (...a: unknown[]) => void;
  private syncing: Promise<void> = Promise.resolve();
  private secrets: PairingSecrets | null = null;

  constructor(private readonly opts: MatterBridgeOptions) {
    this.log = opts.log ?? (() => undefined);
  }

  async start(): Promise<void> {
    this.st = "starting";
    this.changed();
    try {
      const dir = join(this.opts.stateDir, "matter");
      this.secrets = loadPairingSecrets(dir);
      const env = this.opts.environment ?? Environment.default;
      env.vars.set("storage.path", join(dir, "store"));
      // The bridge logs through journald: matter.js's per-message debug lines would drown it.
      env.vars.set("log.level", process.env["SPLANC_MATTER_LOG"] ?? "notice");
      const serial = (this.opts.serial || this.secrets.uniqueId).slice(0, 32);
      this.server = await ServerNode.create({
        id: "splanc-bridge",
        environment: env,
        network: { port: this.opts.port ?? DEFAULT_MATTER_PORT },
        commissioning: { passcode: this.secrets.passcode, discriminator: this.secrets.discriminator },
        productDescription: { name: "Splanc Bridge", deviceType: AggregatorEndpoint.deviceType },
        basicInformation: {
          vendorName: "Splanc",
          vendorId: VendorId(TEST_VENDOR_ID),
          productName: "Splanc Bridge",
          productLabel: "Bridge",
          productId: TEST_PRODUCT_ID,
          nodeLabel: "Splanc Bridge",
          serialNumber: serial,
          uniqueId: this.secrets.uniqueId,
          hardwareVersion: 1,
          hardwareVersionString: "1",
          softwareVersion: 1,
          softwareVersionString: process.env["SPLANC_VERSION"] ?? "dev",
        },
      });
      this.aggregator = new Endpoint(AggregatorEndpoint, { id: "lamps" });
      await this.server.add(this.aggregator);
      const ev = this.server.events.commissioning;
      ev.commissioned.on(() => this.changed());
      ev.decommissioned.on(() => this.changed());
      ev.fabricsChanged.on(() => this.changed());
      this.unsubs.push(this.opts.lamps.onList(() => this.resync()));
      this.unsubs.push(this.opts.lamps.onState((id, st) => void this.applyLamp(id, st)));
      await this.syncLamps();
      await this.server.start();
      this.st = "ready";
      this.log(`matter: bridge up on UDP ${this.opts.port ?? DEFAULT_MATTER_PORT}; ${this.status().commissioned ? "commissioned" : `pairing code ${this.status().manual}`}`);
    } catch (e) {
      this.st = "error";
      this.error = (e as Error).message;
      this.log(`matter: ${this.error}`);
    }
    this.changed();
  }

  async stop(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const b of this.bridged.values()) if (b.levelTimer) clearTimeout(b.levelTimer);
    try {
      await this.server?.close();
    } catch {
      // best effort
    }
    this.server = null;
    this.bridged.clear();
    this.st = "stopped";
    this.changed();
  }

  /** Re-open the commissioning window (15 min) so another controller can add the
   * bridge (multi-admin). A controller that already has it can also share it. */
  async openWindow(): Promise<void> {
    if (!this.server) throw new Error("the Matter bridge isn't running");
    await this.server.act((agent) => agent.commissioning.enterCommissionableMode());
    this.changed();
  }

  /** Forget every controller (factory reset of the Matter side; the lamps are untouched). */
  async reset(): Promise<void> {
    if (!this.server) throw new Error("the Matter bridge isn't running");
    await this.server.erase();
    this.bridged.clear();
    this.aggregator = null;
    this.server = null;
    await this.start();
  }

  status(): MatterStatus {
    const s = this.server;
    let commissioned = false;
    let fabrics: MatterStatus["fabrics"] = [];
    let qr = "";
    let manual = "";
    let commissionable = false;
    if (s) {
      try {
        const c = s.state.commissioning;
        commissioned = c.commissioned;
        fabrics = Object.values(c.fabrics).map((f) => ({ label: f.label, vendor: Number(f.rootVendorId) }));
        qr = c.pairingCodes.qrPairingCode;
        manual = c.pairingCodes.manualPairingCode;
        commissionable = !commissioned || this.windowOpen(s);
      } catch {
        // not initialised yet
      }
    }
    return {
      state: this.st,
      commissioned,
      commissionable: this.st === "ready" && commissionable,
      qr,
      manual,
      fabrics,
      lamps: this.bridged.size,
      port: this.opts.port ?? DEFAULT_MATTER_PORT,
      error: this.error,
    };
  }

  private windowOpen(s: ServerNode): boolean {
    try {
      const w = (s.state as unknown as { administratorCommissioning?: { windowStatus?: number } }).administratorCommissioning;
      return (w?.windowStatus ?? 0) !== 0;
    } catch {
      return false;
    }
  }

  private changed(): void {
    this.opts.onChange?.();
  }

  private resync(): void {
    this.syncing = this.syncing.then(() => this.syncLamps()).catch((e: Error) => this.log(`matter: ${e.message}`));
  }

  /** Add an endpoint per new lamp, rename changed ones, remove gone ones. */
  private async syncLamps(): Promise<void> {
    const agg = this.aggregator;
    if (!agg) return;
    const lamps = this.opts.lamps.list();
    const want = new Set(lamps.map((l) => l.id));
    for (const [id, b] of [...this.bridged]) {
      if (want.has(id)) continue;
      this.bridged.delete(id);
      if (b.levelTimer) clearTimeout(b.levelTimer);
      await b.ep.delete().catch(() => undefined);
    }
    for (const l of lamps) {
      const name = lampLabel(l);
      const have = this.bridged.get(l.id);
      if (have) {
        if (have.label !== name) {
          have.label = name;
          await have.ep.set({ bridgedDeviceBasicInformation: { nodeLabel: name } });
        }
        continue;
      }
      const st = this.opts.lamps.state(l.id) ?? { on: false, brightness: 1, reachable: false, power: false };
      const ep = new Endpoint(DimmableLightDevice.with(BridgedDeviceBasicInformationServer), {
        id: endpointId(l.id),
        bridgedDeviceBasicInformation: {
          nodeLabel: name,
          vendorName: "Splanc",
          productName: "Splanc lamp",
          ...(l.fw ? { softwareVersionString: label(l.fw) } : {}),
          serialNumber: label(l.id),
          uniqueId: label(l.id.replace(/[^0-9A-Za-z]/g, "")),
          reachable: st.reachable,
        },
        onOff: { onOff: st.on },
        levelControl: { currentLevel: levelOf(st.brightness), minLevel: 1, maxLevel: LEVEL_MAX },
      }) as LightEndpoint;
      await agg.add(ep);
      const b: Bridged = { ep, applying: 0, levelTimer: null, label: name };
      this.bridged.set(l.id, b);
      this.wire(l.id, b);
    }
    this.changed();
  }

  /** Controller commands (attribute changes we didn't cause) go to the lamp. */
  private wire(id: string, b: Bridged): void {
    b.ep.events.onOff.onOff$Changed.on((on: boolean) => {
      if (b.applying > 0) return;
      const st = this.opts.lamps.state(id);
      if (st && st.on === on) return;
      this.opts.lamps.setOn(id, on).catch((e: Error) => this.failed(id, b, `turn ${on ? "on" : "off"}`, e));
    });
    b.ep.events.levelControl.currentLevel$Changed.on((level: number | null) => {
      if (b.applying > 0 || level === null) return;
      // Turning off can move the level to its minimum (Lighting feature): an off lamp
      // keeps its brightness, so that is not a request.
      if (!b.ep.state.onOff.onOff) return;
      if (b.levelTimer) clearTimeout(b.levelTimer);
      b.levelTimer = setTimeout(() => {
        b.levelTimer = null;
        const st = this.opts.lamps.state(id);
        if (st && levelOf(st.brightness) === level) return;
        this.opts.lamps.setBrightness(id, brightnessOf(level)).catch((e: Error) => this.failed(id, b, "set the brightness", e));
      }, LEVEL_DEBOUNCE_MS);
      b.levelTimer.unref?.();
    });
  }

  private failed(id: string, b: Bridged, what: string, e: Error): void {
    this.log(`matter: ${b.label}: couldn't ${what}: ${e.message}`);
    // Put the controller back on the lamp's real state.
    const st = this.opts.lamps.state(id);
    if (st) void this.applyLamp(id, st);
  }

  /** The lamp changed (a push, a re-read): mirror it into the endpoint. */
  private async applyLamp(id: string, st: LampState): Promise<void> {
    const b = this.bridged.get(id);
    if (!b) return;
    const cur = b.ep.state;
    const patch: Record<string, unknown> = {};
    if (cur.onOff.onOff !== st.on) patch["onOff"] = { onOff: st.on };
    const level = levelOf(st.brightness);
    if (cur.levelControl.currentLevel !== level) patch["levelControl"] = { currentLevel: level };
    if (cur.bridgedDeviceBasicInformation.reachable !== st.reachable) patch["bridgedDeviceBasicInformation"] = { reachable: st.reachable };
    if (Object.keys(patch).length === 0) return;
    b.applying++;
    try {
      await b.ep.set(patch as never);
    } catch (e) {
      this.log(`matter: couldn't mirror ${b.label}: ${(e as Error).message}`);
    } finally {
      b.applying--;
    }
  }
}
