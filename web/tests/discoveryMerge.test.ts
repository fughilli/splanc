/**
 * Automatic discovery (D-72): fixtures heard on the network — native mDNS adverts
 * (`_splanc._tcp`, TXT id = MAC) or a paired bridge's player list — fold into the
 * known devices by MAC, then by address; the rest are offered as new. Pure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixtureFromBridge,
  fixtureFromMdns,
  mergeDiscovered,
  normalizeMac,
  type FoundFixture,
} from "../src/net/discovery";
import type { KnownDevice } from "../src/store/deviceStore";

function dev(id: string, wssUrl: string, bleMac = "", lanUrl?: string): KnownDevice {
  return {
    id,
    wssUrl,
    label: id,
    bleMac,
    lastSeen: "",
    ...(lanUrl ? { lanUrl } : {}),
  } as KnownDevice;
}

function found(name: string, host: string, id = "", seenAt = 1, source: "mdns" | "bridge" = "mdns"): FoundFixture {
  return { key: id || `name:${name}`, id, name, host, url: `wss://${host}/ws`, source, seenAt };
}

test("MACs normalize to colon-separated uppercase", () => {
  assert.equal(normalizeMac("58:e6:c5:5e:ed:01"), "58:E6:C5:5E:ED:01");
  assert.equal(normalizeMac("58E6C55EED01"), "58:E6:C5:5E:ED:01");
  assert.equal(normalizeMac("58-E6-C5-5E-ED-01"), "58:E6:C5:5E:ED:01");
  assert.equal(normalizeMac("nope"), "");
  assert.equal(normalizeMac(undefined), "");
});

test("an mDNS advert becomes a fixture at its IPv4 address", () => {
  const f = fixtureFromMdns(
    {
      name: "Porch Arch",
      host: "splanc-5eed01.local.",
      port: 443,
      addresses: ["192.168.1.42"],
      txt: { id: "58:e6:c5:5e:ed:01", name: "Porch Arch", fw: "1.21.0", path: "/.well-known/splanc.json" },
    },
    7,
  )!;
  assert.deepEqual(f, {
    key: "58:E6:C5:5E:ED:01",
    id: "58:E6:C5:5E:ED:01",
    name: "Porch Arch",
    host: "192.168.1.42",
    url: "wss://192.168.1.42/ws",
    fw: "1.21.0",
    source: "mdns",
    seenAt: 7,
  });
  assert.equal(fixtureFromMdns({ name: "x", host: "splanc-1.local.", port: 8443 }, 0)!.url, "wss://splanc-1.local:8443/ws");
  assert.equal(fixtureFromMdns({ name: "gone", lost: true }, 0), null);
  assert.equal(fixtureFromMdns({ name: "no address" }, 0), null);
});

test("a bridge-reported player becomes a fixture", () => {
  const f = fixtureFromBridge({ id: "58E6C55EED02", name: "Stair Rail", host: "192.168.1.57", fw: "1.20.0" }, 3)!;
  assert.equal(f.id, "58:E6:C5:5E:ED:02");
  assert.equal(f.url, "wss://192.168.1.57/ws");
  assert.equal(f.source, "bridge");
  assert.equal(fixtureFromBridge({ id: "", name: "p", host: "10.0.0.9:8443" }, 0)!.url, "wss://10.0.0.9:8443/ws");
  assert.equal(fixtureFromBridge({ id: "x", name: "p", host: "" }, 0), null);
});

test("merge: a MAC match marks the known device, even at a new address", () => {
  const known = [dev("kitchen", "wss://10.0.0.41/ws", "58:E6:C5:00:00:41")];
  const v = mergeDiscovered(known, [found("Kitchen", "10.0.0.99", "58:E6:C5:00:00:41")]);
  assert.equal(v.matched.get("kitchen")?.host, "10.0.0.99");
  assert.deepEqual(v.fresh, []);
});

test("merge: without a MAC, the address matches (wss or the remembered Wi-Fi address)", () => {
  const known = [dev("a", "wss://10.0.0.5/ws"), dev("b", "ble:xyz", "", "wss://10.0.0.6/ws")];
  const v = mergeDiscovered(known, [found("A", "10.0.0.5"), found("B", "10.0.0.6"), found("C", "10.0.0.7")]);
  assert.deepEqual([...v.matched.keys()].sort(), ["a", "b"]);
  assert.deepEqual(
    v.fresh.map((f) => f.name),
    ["C"],
  );
});

test("merge: one entry per fixture across sources (newest wins); new ones sorted by name", () => {
  const mac = "58:E6:C5:00:00:77";
  const v = mergeDiscovered(
    [],
    [
      found("Zeta", "10.0.0.20", "58:E6:C5:00:00:20"),
      found("Old name", "10.0.0.77", mac, 1, "bridge"),
      found("Attic", "10.0.0.78", mac, 5, "mdns"),
      found("Beta", "10.0.0.21"),
    ],
  );
  assert.deepEqual(
    v.fresh.map((f) => `${f.name}@${f.host}`),
    ["Attic@10.0.0.78", "Beta@10.0.0.21", "Zeta@10.0.0.20"],
  );
});

test("merge: a different MAC at a known address is still the known device's address only by MAC first", () => {
  // MAC match wins over an address coincidence (a DHCP lease handed to another fixture).
  const known = [dev("old", "wss://10.0.0.5/ws", "58:E6:C5:00:00:01"), dev("other", "wss://10.0.0.9/ws", "58:E6:C5:00:00:02")];
  const v = mergeDiscovered(known, [found("Other", "10.0.0.5", "58:E6:C5:00:00:02")]);
  assert.equal(v.matched.get("other")?.host, "10.0.0.5");
  assert.equal(v.matched.has("old"), false);
});
