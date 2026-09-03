/** GitHub-releases firmware source — parsing the releases API into a picker index. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { releasesToFirmwareIndex } from "../src/flash/githubReleaseRepo";

function asset(name: string) {
  return { name, browser_download_url: `https://example.test/${name}` };
}

// Two releases (newest first, as the API returns them), each shipping both variants
// plus an unrelated asset that must be ignored.
const SHA_120 = "0123456789abcdef0123456789abcdef01234567";
const RELEASES = [
  {
    tag_name: "firmware-v1.2.0",
    draft: false,
    target_commitish: SHA_120, // release.yaml pins this to the tagged commit
    assets: [
      asset("esp32c6-vendor-1.2.0.tar"),
      asset("esp32c6-netstack-1.2.0.tar"),
      asset("checksums.txt"),
    ],
  },
  {
    tag_name: "firmware-v1.1.0",
    draft: false,
    target_commitish: "main", // older release without a pinned SHA → commit omitted
    assets: [asset("esp32c6-vendor-1.1.0.tar"), asset("esp32c6-netstack-1.1.0.tar")],
  },
];

test("releasesToFirmwareIndex yields one entry per release × variant, newest first", () => {
  const idx = releasesToFirmwareIndex(RELEASES);
  assert.ok(idx);
  assert.equal(idx!.entries.length, 4);
  // Newest release's entries come first (API order preserved).
  assert.match(idx!.entries[0]!.label, /firmware-v1\.2\.0/);
  const vendor = idx!.entries.find((e) => e.id === "firmware-v1.2.0::vendor")!;
  assert.equal(vendor.chip, "esp32c6");
  assert.equal(vendor.family, "esp");
  assert.equal(vendor.manifest, "flash.json");
  assert.equal(vendor.tarUrl, "https://example.test/esp32c6-vendor-1.2.0.tar");
  assert.match(vendor.label, /Vendor/);
  // Version = tag minus the component prefix; commit = the pinned 40-hex SHA.
  assert.equal(vendor.version, "1.2.0");
  assert.equal(vendor.commit, SHA_120);
  const netstack = idx!.entries.find((e) => e.id === "firmware-v1.2.0::netstack")!;
  assert.match(netstack.label, /netstack/i);
  assert.equal(netstack.tarUrl, "https://example.test/esp32c6-netstack-1.2.0.tar");
  assert.equal(netstack.version, "1.2.0");
  assert.equal(netstack.commit, SHA_120);
});

test("version comes from the tag; a non-SHA target_commitish yields no commit", () => {
  const idx = releasesToFirmwareIndex(RELEASES)!;
  const older = idx.entries.find((e) => e.id === "firmware-v1.1.0::vendor")!;
  assert.equal(older.version, "1.1.0");
  assert.equal(older.commit, undefined); // "main" is not a full SHA → omitted
});

test("entry ids are unique across releases and variants", () => {
  const idx = releasesToFirmwareIndex(RELEASES)!;
  assert.equal(new Set(idx.entries.map((e) => e.id)).size, idx.entries.length);
});

test("releases with no firmware assets, drafts, and non-arrays degrade to null", () => {
  assert.equal(releasesToFirmwareIndex([]), null);
  assert.equal(releasesToFirmwareIndex([{ tag_name: "app-v1.0.0", draft: false, assets: [asset("site.tar.gz")] }]), null);
  assert.equal(
    releasesToFirmwareIndex([{ tag_name: "firmware-v9", draft: true, assets: [asset("esp32c6-vendor-9.tar")] }]),
    null,
  );
  assert.equal(releasesToFirmwareIndex({ not: "an array" }), null);
  assert.equal(releasesToFirmwareIndex(null), null);
});
