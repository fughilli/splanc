/** Firmware manifest parsing (FUG-60). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseFlashManifest,
  parseFirmwareIndex,
  parseOffset,
} from "../src/flash/manifest";

test("parseOffset accepts hex, decimal, and integer forms", () => {
  assert.equal(parseOffset("0x0"), 0);
  assert.equal(parseOffset("0x8000"), 0x8000);
  assert.equal(parseOffset("0xe000"), 0xe000);
  assert.equal(parseOffset("0x10000"), 0x10000);
  assert.equal(parseOffset(" 0X1000 "), 0x1000);
  assert.equal(parseOffset("4096"), 4096);
  assert.equal(parseOffset(4096), 4096);
});

test("parseOffset rejects garbage / negatives", () => {
  assert.throws(() => parseOffset("nope"));
  assert.throws(() => parseOffset("-0x10"));
  assert.throws(() => parseOffset(-1));
  assert.throws(() => parseOffset(null));
});

// Exactly the shape mk_flashbundle.py emits for the esp32c6 image.
const FLASH_JSON = {
  chip: "esp32c6",
  flash_mode: "keep",
  flash_freq: "keep",
  flash_size: "keep",
  images: [
    { offset: "0x0", file: "esp32c6_bootloader.bin" },
    { offset: "0x8000", file: "partitions_huge_app.bin" },
    { offset: "0xe000", file: "boot_app0.bin" },
    { offset: "0x10000", file: "esp32c6.bin" },
  ],
};

test("parseFlashManifest maps offsets to bytes in order", () => {
  const m = parseFlashManifest(FLASH_JSON);
  assert.equal(m.chip, "esp32c6");
  assert.equal(m.flashMode, "keep");
  assert.equal(m.flashFreq, "keep");
  assert.equal(m.flashSize, "keep");
  assert.deepEqual(
    m.images,
    [
      { offset: 0x0, file: "esp32c6_bootloader.bin" },
      { offset: 0x8000, file: "partitions_huge_app.bin" },
      { offset: 0xe000, file: "boot_app0.bin" },
      { offset: 0x10000, file: "esp32c6.bin" },
    ],
  );
});

test("parseFlashManifest defaults flash params to keep when absent", () => {
  const m = parseFlashManifest({ chip: "esp32c6", images: [{ offset: "0x0", file: "a.bin" }] });
  assert.equal(m.flashMode, "keep");
  assert.equal(m.flashFreq, "keep");
  assert.equal(m.flashSize, "keep");
});

test("parseFlashManifest throws on missing/empty images", () => {
  assert.throws(() => parseFlashManifest({ chip: "esp32c6", images: [] }));
  assert.throws(() => parseFlashManifest({ chip: "esp32c6" }));
  assert.throws(() => parseFlashManifest(null));
  assert.throws(() => parseFlashManifest({ chip: "esp32c6", images: [{ offset: "0x0" }] }));
});

const INDEX_JSON = {
  revision: "abc1234",
  builtAt: "2026-08-05T00:00:00Z",
  entries: [
    {
      id: "esp32c6",
      label: "LED Mapper player — ESP32-C6",
      chip: "esp32c6",
      family: "esp",
      manifest: "flash.json",
    },
  ],
};

test("parseFirmwareIndex reads a well-formed index", () => {
  const idx = parseFirmwareIndex(INDEX_JSON);
  assert.ok(idx);
  assert.equal(idx.revision, "abc1234");
  assert.equal(idx.builtAt, "2026-08-05T00:00:00Z");
  assert.equal(idx.entries.length, 1);
  assert.deepEqual(idx.entries[0], {
    id: "esp32c6",
    label: "LED Mapper player — ESP32-C6",
    chip: "esp32c6",
    family: "esp",
    manifest: "flash.json",
  });
});

test("parseFirmwareIndex defaults manifest name and label", () => {
  const idx = parseFirmwareIndex({ entries: [{ id: "esp32c6", chip: "esp32c6", family: "esp" }] });
  assert.ok(idx);
  const only = idx.entries[0]!;
  assert.equal(only.manifest, "flash.json");
  assert.equal(only.label, "esp32c6");
  assert.equal(idx.revision, null);
});

test("parseFirmwareIndex drops entries with an unknown family", () => {
  const idx = parseFirmwareIndex({
    entries: [
      { id: "x", chip: "x", family: "avr" },
      { id: "esp32c6", chip: "esp32c6", family: "esp" },
    ],
  });
  assert.ok(idx);
  assert.equal(idx.entries.length, 1);
  assert.equal(idx.entries[0]!.id, "esp32c6");
});

test("parseFirmwareIndex returns null (not throw) on junk / empty", () => {
  assert.equal(parseFirmwareIndex(null), null);
  assert.equal(parseFirmwareIndex({}), null);
  assert.equal(parseFirmwareIndex({ entries: [] }), null);
  assert.equal(parseFirmwareIndex({ entries: [{ id: "x", chip: "x", family: "avr" }] }), null);
  assert.equal(parseFirmwareIndex("nope"), null);
});
