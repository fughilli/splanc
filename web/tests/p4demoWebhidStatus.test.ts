/**
 * P4 demo page: the status text for a WebHID device picker that came back empty.
 * On Android before 17 the picker is always empty, so the text names that cause there.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { noDeviceChosenDetail } from "../src/p4demo/lh/webhid";

test("an empty picker on Android names the Android 17 and system-setting requirements", () => {
  const detail = noDeviceChosenDetail("Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/154.0.0.0 Mobile Safari/537.36");
  assert.match(detail, /^no Vive device chosen/);
  assert.match(detail, /Android 17/);
  assert.match(detail, /HID access/);
});

test("an empty picker on desktop is just 'no Vive device chosen'", () => {
  assert.equal(noDeviceChosenDetail("Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0 Safari/537.36"), "no Vive device chosen");
});
