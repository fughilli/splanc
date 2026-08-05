/** USB VID/PID → chip-family identification (FUG-60). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { identifyUsb, formatUsbId } from "../src/flash/usb";

test("Espressif native USB-Serial-JTAG resolves to the esp family (ambiguous chip)", () => {
  const m = identifyUsb({ vid: 0x303a, pid: 0x1001 });
  assert.ok(m);
  assert.equal(m.family, "esp");
  assert.equal(m.ambiguous, true, "exact chip comes from the bootloader self-report");
});

test("any Espressif VID falls through to the vendor rule", () => {
  const m = identifyUsb({ vid: 0x303a, pid: 0x4001 });
  assert.ok(m);
  assert.equal(m.family, "esp");
});

test("third-party UART bridges map to the esp family", () => {
  for (const vid of [0x10c4, 0x1a86, 0x0403]) {
    const m = identifyUsb({ vid, pid: 0xea60 });
    assert.ok(m, `vid ${vid.toString(16)}`);
    assert.equal(m.family, "esp");
    assert.equal(m.ambiguous, true);
  }
});

test("RP2 bootloader maps to the rp2 family", () => {
  const m = identifyUsb({ vid: 0x2e8a, pid: 0x0003 });
  assert.ok(m);
  assert.equal(m.family, "rp2");
});

test("unknown vendor is null (caller may still let the user try)", () => {
  assert.equal(identifyUsb({ vid: 0x1234, pid: 0x5678 }), null);
});

test("formatUsbId zero-pads to the conventional vid:pid form", () => {
  assert.equal(formatUsbId({ vid: 0x303a, pid: 0x1001 }), "303a:1001");
  assert.equal(formatUsbId({ vid: 0x0403, pid: 0x6001 }), "0403:6001");
});
