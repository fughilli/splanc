/**
 * Board detection for the USB flasher: which firmware fits the connected board
 * (flash/boardMatch.ts), so a board is never written with another board's image.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardLabel,
  candidatesFor,
  chipLabel,
  espImageChipId,
  fitProblem,
  revisionLabel,
  supportedChips,
  unsupportedMessage,
  type DetectedBoard,
  type ImageSet,
} from "../src/flash/boardMatch";
import { parseFlashManifest, type FirmwareEntry, type FirmwareIndex } from "../src/flash/manifest";

const C6: DetectedBoard = { chipName: "ESP32-C6", chipId: 13 };
const P4 = (revision?: number): DetectedBoard => ({ chipName: "ESP32-P4", chipId: 18, ...(revision !== undefined ? { revision } : {}) });

/** A 24-byte ESP image header for `chipId` (magic 0xE9, chip id at bytes 12..13). */
function image(chipId: number): Uint8Array {
  const b = new Uint8Array(64);
  b[0] = 0xe9;
  b[12] = chipId & 0xff;
  b[13] = chipId >> 8;
  return b;
}
const notAnImage = new Uint8Array(3072).fill(0xaa); // e.g. a partition table

function set(chip: string, chipId: number, chipRev?: { min?: number; max?: number }): ImageSet {
  return {
    manifest: { chip, ...(chipRev ? { chipRev } : {}) },
    images: [
      { offset: 0x2000, data: image(chipId) },
      { offset: 0x8000, data: notAnImage },
      { offset: 0x10000, data: image(chipId) },
    ],
  };
}

const entry = (id: string, chip: string, release = true): FirmwareEntry => ({
  id,
  label: id,
  chip,
  family: "esp",
  manifest: "flash.json",
  version: release ? id.replace(/^firmware-v|::.*$/g, "") : "0.0.0-dev",
  ...(release ? { tarUrl: `https://example.test/${id}.tar` } : {}),
});

const RELEASES: FirmwareIndex = {
  revision: null,
  builtAt: null,
  entries: [
    entry("firmware-v2.0.0::ota", "esp32c6"),
    entry("firmware-v2.0.0::netstack", "esp32c6"),
    entry("firmware-v2.0.0::player", "esp32p4"),
    entry("firmware-v1.9.0::ota", "esp32c6"), // before the P4 shipped
    entry("firmware-v1.9.0::netstack", "esp32c6"),
  ],
};
const BUNDLED: FirmwareIndex = {
  revision: "abc1234",
  builtAt: null,
  entries: [entry("esp32c6_netstack", "esp32c6", false), entry("esp32p4_tracker", "esp32p4", false)],
};

test("the chip id is read from an ESP image header, and only from one", () => {
  assert.equal(espImageChipId(image(18)), 18);
  assert.equal(espImageChipId(image(13)), 13);
  assert.equal(espImageChipId(notAnImage), null);
  assert.equal(espImageChipId(new Uint8Array(4)), null);
});

test("an image set fits its own chip and no other", () => {
  assert.equal(fitProblem(set("esp32c6", 13), C6), null);
  assert.equal(fitProblem(set("esp32p4", 18), P4(302)), null);
  assert.match(fitProblem(set("esp32c6", 13), P4(302))!, /This board is an ESP32-P4, but this firmware is for the ESP32-C6/);
  assert.match(fitProblem(set("esp32p4", 18), C6)!, /This board is an ESP32-C6, but this firmware is for the ESP32-P4/);
});

test("a bundle labelled for the board but holding another chip's image is refused", () => {
  const mislabelled = set("esp32p4", 13); // says P4, the images are C6 builds
  assert.match(fitProblem(mislabelled, P4(302))!, /image at 0x2000 was built for a different chip \(id 13\)/);
  // Without a chip id from the flasher only the label can be checked.
  assert.equal(fitProblem(mislabelled, { chipName: "ESP32-P4" }), null);
});

test("the P4 bundle's silicon revision range: v3.1 to v3.99", () => {
  const p4 = set("esp32p4", 18, { min: 301, max: 399 });
  assert.equal(fitProblem(p4, P4(301)), null);
  assert.equal(fitProblem(p4, P4(302)), null);
  assert.match(fitProblem(p4, P4(100))!, /silicon revision v1\.0; this firmware runs on v3\.1 to v3\.99 only/);
  assert.match(fitProblem(p4, P4(300))!, /silicon revision v3\.0/);
  assert.match(fitProblem(set("esp32p4", 18, { min: 301 }), P4(103))!, /v3\.1 or newer/);
  // A revision the flasher couldn't read doesn't block: the chip checks still apply.
  assert.equal(fitProblem(p4, P4()), null);
  assert.equal(revisionLabel(301), "v3.1");
  assert.equal(boardLabel(P4(302)), "ESP32-P4 (revision v3.2)");
  assert.equal(boardLabel(C6), "ESP32-C6");
  assert.equal(chipLabel("esp32p4"), "ESP32-P4");
});

test("flash.json chip_rev is parsed (and ignored when malformed)", () => {
  const base = { chip: "esp32p4", images: [{ offset: "0x10000", file: "app.bin" }] };
  assert.deepEqual(parseFlashManifest({ ...base, chip_rev: { min: 301, max: 399 } }).chipRev, { min: 301, max: 399 });
  assert.deepEqual(parseFlashManifest({ ...base, chip_rev: { min: 301 } }).chipRev, { min: 301 });
  assert.equal(parseFlashManifest({ ...base, chip_rev: { min: "3.1" } }).chipRev, undefined);
  assert.equal(parseFlashManifest(base).chipRev, undefined);
});

test("the selected image is kept when it's for the detected chip", () => {
  const sel = RELEASES.entries[1]!; // v2.0.0 netstack
  assert.deepEqual(
    candidatesFor(RELEASES, sel, C6).map((e) => e.id),
    ["firmware-v2.0.0::netstack", "firmware-v2.0.0::ota"],
  );
});

test("a P4 on the cable with a C6 image selected: the same release's P4 image", () => {
  assert.deepEqual(
    candidatesFor(RELEASES, RELEASES.entries[0]!, P4(302)).map((e) => e.id),
    ["firmware-v2.0.0::player"],
  );
  // And the other way round: a C6 with the P4 image selected gets that release's C6 images.
  assert.deepEqual(
    candidatesFor(RELEASES, RELEASES.entries[2]!, C6).map((e) => e.id),
    ["firmware-v2.0.0::ota", "firmware-v2.0.0::netstack"],
  );
});

test("never another version: a release without an image for the board has no candidates", () => {
  const sel = RELEASES.entries[3]!; // v1.9.0
  assert.deepEqual(candidatesFor(RELEASES, sel, P4(302)), []);
  assert.match(unsupportedMessage(RELEASES, sel, P4(302), null), /firmware 1\.9\.0 has no image for it\. Pick a version that lists an ESP32-P4 image\. Nothing was written/);
});

test("this build's bundled images are one group", () => {
  assert.deepEqual(
    candidatesFor(BUNDLED, BUNDLED.entries[0]!, P4(302)).map((e) => e.id),
    ["esp32p4_tracker"],
  );
  assert.deepEqual(
    candidatesFor(BUNDLED, BUNDLED.entries[1]!, C6).map((e) => e.id),
    ["esp32c6_netstack"],
  );
});

test("an unsupported board is named, with what is supported", () => {
  const s3: DetectedBoard = { chipName: "ESP32-S3", chipId: 9 };
  assert.deepEqual(candidatesFor(RELEASES, RELEASES.entries[0]!, s3), []);
  assert.deepEqual(supportedChips(RELEASES), ["ESP32-C6", "ESP32-P4"]);
  assert.equal(
    unsupportedMessage(RELEASES, RELEASES.entries[0]!, s3, null),
    "This board is an ESP32-S3, which Splanc has no firmware for (supported: ESP32-C6, ESP32-P4). Nothing was written to the board.",
  );
  // The right chip at the wrong revision reports the revision, not "no firmware".
  const why = fitProblem(set("esp32p4", 18, { min: 301, max: 399 }), P4(100));
  assert.match(unsupportedMessage(RELEASES, RELEASES.entries[2]!, P4(100), why), /silicon revision v1\.0.*Nothing was written/);
});
