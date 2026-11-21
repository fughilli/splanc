/**
 * The Matter bridge (src/bridge/matter.ts) end to end: a real Matter controller
 * (matter.js's CommissioningController, its own Matter stack) commissions the bridge
 * over UDP on loopback with the bridge's pairing code, finds one bridged light per
 * lamp, and drives them; the lamps' own changes (a lid tap) come back to the
 * controller as attribute reports. The lamps are a fake LampDriver, so this tests
 * the Matter mapping, not the hub (lamps.test.ts covers HubLamps).
 *
 * Interop with the CHIP SDK's own controller (python chip-core) is run by hand:
 * agent/tools/matter_interop/README.md.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { Environment } from "@matter/main";
import { BridgedDeviceBasicInformation, Descriptor, LevelControl, OnOff } from "@matter/main/clusters";
import { GeneralCommissioning } from "@matter/main/clusters";
import { ManualPairingCodeCodec, NodeId } from "@matter/main/types";
import { CommissioningController } from "@project-chip/matter.js";
import type { PairedNode } from "@project-chip/matter.js/device";

import type { LampDriver, LampInfo, LampState } from "../src/bridge/lamps";
import { brightnessOf, endpointId, lampLabel, levelOf, loadPairingSecrets, MatterBridge, validPasscode } from "../src/bridge/matter";

const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-matter-"));

/** A scripted LampDriver: records commands, and can push changes like a lamp would. */
class FakeLamps implements LampDriver {
  readonly calls: string[] = [];
  readonly lamps = new Map<string, { info: LampInfo; st: LampState }>();
  private readonly listSubs = new Set<() => void>();
  private readonly stateSubs = new Set<(id: string, st: LampState) => void>();
  fail = false;

  add(info: LampInfo, st: Partial<LampState> = {}): void {
    this.lamps.set(info.id, { info, st: { on: false, brightness: 0.5, reachable: true, power: true, ...st } });
    for (const fn of this.listSubs) fn();
  }
  remove(id: string): void {
    this.lamps.delete(id);
    for (const fn of this.listSubs) fn();
  }
  list(): LampInfo[] {
    return [...this.lamps.values()].map((l) => l.info);
  }
  state(id: string): LampState | undefined {
    const l = this.lamps.get(id);
    return l ? { ...l.st } : undefined;
  }
  async setOn(id: string, on: boolean): Promise<void> {
    this.calls.push(`${id} on=${on}`);
    if (this.fail) throw new Error("lamp busy");
    this.push(id, { on });
  }
  async setBrightness(id: string, level: number): Promise<void> {
    this.calls.push(`${id} brightness=${level.toFixed(3)}`);
    if (this.fail) throw new Error("lamp busy");
    this.push(id, { brightness: level });
  }
  /** The lamp changed by itself (a lid tap, the app). */
  push(id: string, patch: Partial<LampState>): void {
    const l = this.lamps.get(id)!;
    l.st = { ...l.st, ...patch };
    for (const fn of this.stateSubs) fn(id, { ...l.st });
  }
  onList(fn: () => void): () => void {
    this.listSubs.add(fn);
    return () => this.listSubs.delete(fn);
  }
  onState(fn: (id: string, st: LampState) => void): () => void {
    this.stateSubs.add(fn);
    return () => this.stateSubs.delete(fn);
  }
  start(): void {}
  stop(): void {}
}

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("pairing secrets and mapping", () => {
  test("a random valid passcode + discriminator, kept across restarts", () => {
    const dir = join(SCRATCH, "secrets");
    const a = loadPairingSecrets(dir);
    assert.ok(validPasscode(a.passcode));
    assert.notEqual(a.passcode, 20202021);
    assert.ok(a.discriminator >= 0 && a.discriminator <= 0xfff);
    assert.deepEqual(loadPairingSecrets(dir), a);
  });
  test("forbidden passcodes are never issued", () => {
    for (const bad of [0, 11111111, 12345678, 87654321, 99999999, 100000000]) assert.equal(validPasscode(bad), false);
    // A generator that first returns forbidden values is retried.
    const seq = [11111110, 12345677, 41];
    const p = loadPairingSecrets(join(SCRATCH, "secrets2"), () => seq.shift() ?? 7);
    assert.equal(p.passcode, 42);
  });
  test("levels, labels and endpoint ids", () => {
    assert.equal(levelOf(1), 254);
    assert.equal(levelOf(0), 1);
    assert.equal(levelOf(0.5), 127);
    assert.equal(brightnessOf(254), 1);
    assert.equal(endpointId("AA:BB:CC:00:11:22"), "lamp-aabbcc001122");
    assert.equal(lampLabel({ id: "x", name: "Coil", room: "Bedroom" }), "Coil (Bedroom)");
    assert.ok(Buffer.byteLength(lampLabel({ id: "x", name: "ä".repeat(40) })) <= 32);
  });
});

describe("Matter bridge with a real controller", () => {
  const lamps = new FakeLamps();
  const COIL = "AA:BB:CC:00:00:01";
  const HALL = "AA:BB:CC:00:00:02";
  let bridge: MatterBridge;
  let controller: CommissioningController;
  let node: PairedNode;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const changes = { status: 0 };

  before(async () => {
    lamps.add({ id: COIL, name: "Coil", room: "Bedroom", fw: "1.9.0" }, { on: true, brightness: 0.8 });
    lamps.add({ id: HALL, name: "Hall" });
    // Both nodes share the process's matter.js environment (as in production: one Node
    // process); each keeps its own storage under it.
    bridge = new MatterBridge({ lamps, stateDir: join(SCRATCH, "bridge"), port, onChange: () => changes.status++, log: (...a) => console.error(...a) });
    await bridge.start();
    const st = bridge.status();
    assert.equal(st.state, "ready", st.error ?? "");
    assert.equal(st.commissioned, false);
    assert.ok(st.qr.startsWith("MT:"));
    assert.equal(st.lamps, 2);

    const ctrlEnv = Environment.default;
    controller = new CommissioningController({ environment: { environment: ctrlEnv, id: "test-controller" }, autoConnect: false, adminFabricLabel: "test" });
    await controller.start();
    const passcode = ManualPairingCodeCodec.decode(st.manual).passcode;
    const nodeId = await controller.commissionNode({
      commissioning: { regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor, regulatoryCountryCode: "XX" },
      discovery: { identifierData: {}, knownAddress: { ip: "::1", port, type: "udp" } },
      passcode,
    });
    node = await controller.getNode(NodeId(nodeId));
    node.connect();
    await until(() => node.initialized, "the controller to read the bridge");
  });

  after(async () => {
    await controller?.close().catch(() => undefined);
    await bridge?.stop();
  });

  const light = async (name: string) => {
    const all = node.getDevices().flatMap((d) => [d, ...d.getChildEndpoints()]);
    for (const ep of all) {
      const info = ep.getClusterClient(BridgedDeviceBasicInformation.Cluster);
      if (info && (await info.getNodeLabelAttribute(false)) === name) return ep;
    }
    return undefined;
  };

  test("commissioned: one bridged light per lamp, named, with the lamps' state", async () => {
    await until(() => bridge.status().commissioned, "status: commissioned");
    assert.equal(bridge.status().fabrics.length, 1);
    const root = node.getDevices();
    assert.ok(root.length > 0);
    const desc = await root[0]!.getClusterClient(Descriptor.Cluster)!.getPartsListAttribute();
    assert.ok(desc.length >= 2);
    const coil = await light("Coil (Bedroom)");
    const hall = await light("Hall");
    assert.ok(coil && hall, "both lamps are bridged lights");
    assert.equal(await coil.getClusterClient(OnOff.Cluster)!.getOnOffAttribute(), true);
    assert.equal(await coil.getClusterClient(LevelControl.Cluster)!.getCurrentLevelAttribute(), levelOf(0.8));
    assert.equal(await hall.getClusterClient(OnOff.Cluster)!.getOnOffAttribute(), false);
    assert.ok(changes.status > 0);
  });

  test("on/off and level commands reach the lamp", async () => {
    const hall = (await light("Hall"))!;
    lamps.calls.length = 0;
    await hall.getClusterClient(OnOff.Cluster)!.on();
    await until(() => lamps.calls.includes(`${HALL} on=true`), "Hall on");
    await hall.getClusterClient(LevelControl.Cluster)!.moveToLevel({ level: 200, transitionTime: null, optionsMask: {}, optionsOverride: {} });
    await until(() => lamps.calls.some((c) => c === `${HALL} brightness=0.787`), `Hall brightness 0.787 (calls: ${JSON.stringify(lamps.calls)})`);
    await hall.getClusterClient(OnOff.Cluster)!.off();
    await until(() => lamps.calls.includes(`${HALL} on=false`), "Hall off");
    // No echo: the lamp's confirmations didn't bounce back as more commands.
    assert.deepEqual(
      lamps.calls.filter((c) => c.startsWith(HALL)),
      [`${HALL} on=true`, `${HALL} brightness=0.787`, `${HALL} on=false`],
    );
  });

  test("a lamp's own change (a lid tap) is reported to the controller", async () => {
    const coil = (await light("Coil (Bedroom)"))!;
    lamps.calls.length = 0;
    lamps.push(COIL, { on: false });
    await until(async () => (await coil.getClusterClient(OnOff.Cluster)!.getOnOffAttribute(false)) === false, "Coil off at the controller");
    lamps.push(COIL, { brightness: 0.25, on: true });
    await until(async () => (await coil.getClusterClient(LevelControl.Cluster)!.getCurrentLevelAttribute(false)) === levelOf(0.25), "Coil level");
    lamps.push(COIL, { reachable: false });
    await until(
      async () => (await coil.getClusterClient(BridgedDeviceBasicInformation.Cluster)!.getReachableAttribute(false)) === false,
      "Coil unreachable",
    );
    assert.deepEqual(lamps.calls, [], "mirroring a lamp's state sends it nothing");
  });

  test("a failed command puts the controller back on the lamp's real state", async () => {
    const hall = (await light("Hall"))!;
    lamps.fail = true;
    await hall.getClusterClient(OnOff.Cluster)!.on();
    await until(async () => (await hall.getClusterClient(OnOff.Cluster)!.getOnOffAttribute(false)) === false, "Hall back off");
    lamps.fail = false;
  });

  test("a new lamp appears, a gone one disappears", async () => {
    lamps.add({ id: "AA:BB:CC:00:00:03", name: "Desk" });
    await until(() => bridge.status().lamps === 3, "3 lamps");
    lamps.remove(HALL);
    await until(() => bridge.status().lamps === 2, "2 lamps");
  });
});
