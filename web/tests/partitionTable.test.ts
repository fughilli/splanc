/** Partition-table parsing for the OTA migration (flash/partitionTable.ts), the
 * flash.json `ota` block (flash/manifest.ts) and the `ota` release variant
 * (flash/githubReleaseRepo.ts). Tables are encoded here the way ESP-IDF's
 * gen_esp32part.py (and firmware/loader/gen_partitions.py) lay them out. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasLittlefsSuperblock,
  hasOtaLayout,
  littlefsPartition,
  parsePartitionTable,
} from "../src/flash/partitionTable";
import { parseFlashManifest } from "../src/flash/manifest";
import { releasesToFirmwareIndex } from "../src/flash/githubReleaseRepo";

type Row = [string, number, number, number, number];

function table(rows: Row[]): Uint8Array {
  const out = new Uint8Array(0xc00).fill(0xff);
  const dv = new DataView(out.buffer);
  rows.forEach(([label, type, subtype, offset, size], i) => {
    const o = i * 32;
    out[o] = 0xaa;
    out[o + 1] = 0x50;
    out[o + 2] = type;
    out[o + 3] = subtype;
    dv.setUint32(o + 4, offset, true);
    dv.setUint32(o + 8, size, true);
    out.fill(0, o + 12, o + 28);
    out.set(new TextEncoder().encode(label), o + 12);
    dv.setUint32(o + 28, 0, true);
  });
  const md5 = rows.length * 32;
  out[md5] = 0xeb;
  out[md5 + 1] = 0xeb;
  return out;
}

const LEGACY: Row[] = [
  ["nvs", 1, 0x02, 0x9000, 0x5000],
  ["otadata", 1, 0x00, 0xe000, 0x2000],
  ["app0", 0, 0x10, 0x10000, 0x300000],
  ["spiffs", 1, 0x82, 0x310000, 0xe0000],
  ["coredump", 1, 0x03, 0x3f0000, 0x10000],
];

const OTA: Row[] = [
  ["nvs", 1, 0x02, 0x9000, 0x5000],
  ["otadata", 1, 0x00, 0xe000, 0x2000],
  ["loader", 0, 0x00, 0x10000, 0x150000],
  ["spiffs", 1, 0x82, 0x160000, 0x60000],
  ["app", 0, 0x10, 0x1c0000, 0x240000],
];

test("the legacy huge_app table is told apart from the OTA layout", () => {
  const legacy = parsePartitionTable(table(LEGACY));
  assert.equal(legacy.length, 5);
  assert.equal(hasOtaLayout(legacy), false);
  assert.equal(littlefsPartition(legacy)?.offset, 0x310000);
  const ota = parsePartitionTable(table(OTA));
  assert.equal(hasOtaLayout(ota), true);
  assert.deepEqual(littlefsPartition(ota), { label: "spiffs", type: 1, subtype: 0x82, offset: 0x160000, size: 0x60000 });
  // A blank (erased) table has no partitions at all.
  assert.deepEqual(parsePartitionTable(new Uint8Array(0xc00).fill(0xff)), []);
});

test("a formatted littlefs is recognised by its superblock name", () => {
  const head = new Uint8Array(8192).fill(0xff);
  assert.equal(hasLittlefsSuperblock(head), false);
  head.set(new TextEncoder().encode("littlefs"), 4096 + 20);
  assert.equal(hasLittlefsSuperblock(head), true);
});

test("flash.json's ota block parses into the migration plan", () => {
  const m = parseFlashManifest({
    chip: "esp32c6",
    images: [
      { offset: "0x0", file: "b.bin" },
      { offset: "0x1c0000", file: "app.bin" },
    ],
    ota: {
      layout: "loader-app-v1",
      app_offset: "0x1c0000",
      app_slot_size: "0x240000",
      legacy_migration: { phase1_below: "0x1c0000", wait_seconds: 25, wait_serial: "[loader] migrate: done" },
      package: "esp32c6-netstack.ota",
    },
  });
  assert.deepEqual(m.ota, {
    layout: "loader-app-v1",
    appOffset: 0x1c0000,
    phase1Below: 0x1c0000,
    waitSeconds: 25,
    package: "esp32c6-netstack.ota",
  });
  assert.equal(parseFlashManifest({ chip: "esp32c6", images: [{ offset: "0x0", file: "a" }] }).ota, undefined);
});

test("releases list the OTA bundle first within a release", () => {
  const index = releasesToFirmwareIndex([
    {
      tag_name: "firmware-v1.9.0",
      assets: [
        { name: "esp32c6-netstack-1.9.0.tar", browser_download_url: "https://x/n.tar" },
        { name: "esp32c6-ota-1.9.0.tar", browser_download_url: "https://x/o.tar" },
        { name: "esp32c6-netstack-1.9.0.ota", browser_download_url: "https://x/n.ota" },
      ],
    },
  ]);
  assert.deepEqual(
    index?.entries.map((e) => e.id),
    ["firmware-v1.9.0::ota", "firmware-v1.9.0::netstack"],
  );
  assert.match(index!.entries[0]!.label, /OTA loader/);
});
