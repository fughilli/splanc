/**
 * Ethernet + network outputs, app side (src/net/ethernet.ts): IPv4 helpers, the
 * wire <-> app conversion through the real proto boundary, and the wording.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeClient, decodeServer, encodeClient, encodeServer } from "../src/net/proto";
import {
  busyPins,
  capsFromWire,
  configFromWire,
  configToWire,
  controllersFromWire,
  ipToString,
  isHostAddress,
  maskFromPrefix,
  parseIp,
  prefixLength,
  stateFromWire,
  statusText,
  type EthernetConfig,
} from "../src/net/ethernet";

const CFG: EthernetConfig = {
  enabled: true,
  phy: "lan8720",
  phyAddr: -1,
  mdcGpio: 23,
  mdioGpio: 0,
  phyResetGpio: -1,
  clock: "out",
  clockGpio: 32,
  ipMode: "dhcp_server",
  ip: 0xc0a83201,
  netmask: 0xffffff00,
  gateway: 0,
};

test("IPv4 helpers", () => {
  assert.equal(ipToString(0xc0a83201), "192.168.50.1");
  assert.equal(parseIp("192.168.50.107"), 0xc0a8326b);
  assert.equal(parseIp(" 10.0.0.1 "), 0x0a000001);
  assert.equal(parseIp("256.1.1.1"), null);
  assert.equal(parseIp("1.2.3"), null);
  assert.equal(prefixLength(0xffffff00), 24);
  assert.equal(prefixLength(0xff00ff00), null);
  assert.equal(prefixLength(0), null);
  assert.equal(maskFromPrefix(24), 0xffffff00);
  assert.equal(maskFromPrefix(30), 0xfffffffc);
  assert.ok(isHostAddress(0xc0a83201, 0xffffff00));
  assert.ok(!isHostAddress(0xc0a83200, 0xffffff00), "network address");
  assert.ok(!isHostAddress(0xc0a832ff, 0xffffff00), "broadcast");
  assert.ok(!isHostAddress(0x7f000001, 0xff000000), "loopback");
});

test("set_ethernet_config survives the proto boundary", () => {
  const frame = encodeClient({ type: "set_ethernet_config", config: configToWire(CFG), commit: true } as never);
  const back = decodeClient(frame) as unknown as Record<string, unknown>;
  assert.equal(back.type, "set_ethernet_config");
  // Zeros (MDIO 0, gateway 0) and negatives (-1) come back the same.
  assert.deepEqual(configFromWire(back.config), CFG);
});

test("ethernet_state decodes into the app shape", () => {
  const frame = encodeServer({
    type: "ethernet_state",
    config: configToWire(CFG),
    outputs: [{ channel: 2, ip: 0xc0a8326b, port: 0, name: "DISTIRA" }],
    linkUp: true,
    speedMbps: 100,
    fullDuplex: true,
    ip: 0xc0a83201,
    netmask: 0xffffff00,
    mac: "AQIDBAUG", // 01:02:03:04:05:06
    txFrames: 42,
  } as never);
  const st = stateFromWire(decodeServer(frame));
  assert.deepEqual(st.config, CFG);
  assert.deepEqual(st.outputs, [{ channel: 2, ip: 0xc0a8326b, port: 0, name: "DISTIRA" }]);
  assert.equal(st.mac, "01:02:03:04:05:06");
  assert.equal(st.txFrames, 42);
  assert.equal(statusText(st), "Link up, 100 Mbps, 192.168.50.1/24");
});

test("controller_list decodes", () => {
  const frame = encodeServer({
    type: "controller_list",
    controllers: [{ name: "DISTIRA", ip: 0xc0a8326b, ledCount: 1680, version: "16.0.1", kind: "wled" }],
  } as never);
  const r = controllersFromWire(decodeServer(frame));
  assert.equal(r.error, "");
  assert.equal(r.controllers.length, 1);
  assert.equal(r.controllers[0]!.name, "DISTIRA");
  assert.equal(r.controllers[0]!.ledCount, 1680);
  assert.equal(r.controllers[0]!.mac, "");
});

test("status wording", () => {
  const base = stateFromWire({ config: { ...configToWire(CFG), enabled: false } });
  assert.equal(statusText(base), "Off");
  const on = stateFromWire({ config: configToWire(CFG), error: "phy_not_found" });
  assert.match(statusText(on), /No PHY answered/);
  const down = stateFromWire({ config: configToWire(CFG) });
  assert.match(statusText(down), /No link/);
});

test("busy pins and caps", () => {
  const caps = capsFromWire({ phys: ["ip101"], defaults: { phy: "ip101" }, rmiiGpios: [49, 34, 35, 28, 29, 30, 50] });
  assert.ok(caps);
  assert.deepEqual(busyPins({ ...CFG, enabled: false }, caps), []);
  assert.deepEqual(
    busyPins(CFG, caps).sort((a, b) => a - b),
    [0, 23, 28, 29, 30, 32, 34, 35, 49, 50],
  );
  assert.equal(capsFromWire(undefined), null);
});
