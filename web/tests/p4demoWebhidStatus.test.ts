/**
 * P4 demo page: the status text for a WebHID device picker that came back empty.
 * On Android the text names what to check, and ?hidall=1 lists every HID device.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebHidTracking, describeHidDevice, noDeviceChosenDetail } from "../src/p4demo/lh/webhid";

test("an empty picker on Android names the system setting and the list-everything switch", () => {
  const detail = noDeviceChosenDetail("Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/154.0.0.0 Mobile Safari/537.36");
  assert.match(detail, /^no Vive device chosen/);
  assert.match(detail, /hidall=1/);
  assert.match(detail, /HID access/);
});

test("an empty picker on desktop is just 'no Vive device chosen'", () => {
  assert.equal(noDeviceChosenDetail("Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0 Safari/537.36"), "no Vive device chosen");
});

test("the list-everything switch asks with no filters and names a picked non-Vive device", async () => {
  let asked: unknown = null;
  const mouse = { vendorId: 0x046d, productId: 0xc077, productName: "USB Mouse", opened: false };
  const hid = {
    requestDevice: async (o: { filters: unknown[] }) => {
      asked = o.filters;
      return [mouse];
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const t = createWebHidTracking({ hid: hid as never, storage: null, tickMs: 0, anyDevice: true });
  let detail = "";
  t.onStatus((s) => (detail = s.detail ?? ""));
  await t.connect();
  assert.deepEqual(asked, []);
  assert.equal(detail, "not a Vive device: USB Mouse (046d:c077)");
  assert.equal(describeHidDevice({ vendorId: 0x28de, productId: 0x2101 }), "unnamed (28de:2101)");
});
