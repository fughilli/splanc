/** GitHub-releases firmware source — parsing the releases API into a picker index. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { releasesToFirmwareIndex } from "../src/flash/githubReleaseRepo";

function asset(name: string) {
  return { name, browser_download_url: `https://example.test/${name}` };
}

// Two releases (newest first, as the API returns them), each shipping both variants
// plus an unrelated asset that must be ignored.
const RELEASES = [
  {
    tag_name: "firmware-v1.2.0",
    draft: false,
    assets: [
      asset("esp32c6-vendor-1.2.0.tar"),
      asset("esp32c6-netstack-1.2.0.tar"),
      asset("checksums.txt"),
    ],
  },
  {
    tag_name: "firmware-v1.1.0",
    draft: false,
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
  const netstack = idx!.entries.find((e) => e.id === "firmware-v1.2.0::netstack")!;
  assert.match(netstack.label, /netstack/i);
  assert.equal(netstack.tarUrl, "https://example.test/esp32c6-netstack-1.2.0.tar");
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
