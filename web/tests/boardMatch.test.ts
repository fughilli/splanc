// Firmware bundles only for the connected device's board (src/flash/boardMatch.ts,
// src/net/otaUpdate.ts): a P4 player is never offered the C6 bundle.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WelcomeMessage } from "@ledmapper/protocol";
import { entriesForBoard, newestForBoard, otaEntryFor, updateState } from "../src/flash/boardMatch";
import { releasesToFirmwareIndex } from "../src/flash/githubReleaseRepo";
import { deviceBoard, manifestBoard, packageBoardMismatch } from "../src/net/otaUpdate";

function asset(name: string) {
  return { name, browser_download_url: `https://example.test/${name}` };
}

// Today's releases ship C6 assets only; #490 adds the P4 player from some release on.
const index = releasesToFirmwareIndex([
  { tag_name: "firmware-v1.15.0", draft: false, assets: [asset("esp32c6-ota-1.15.0.tar"), asset("esp32c6-netstack-1.15.0.tar")] },
  {
    tag_name: "firmware-v1.14.0",
    draft: false,
    assets: [asset("esp32c6-ota-1.14.0.tar"), asset("esp32p4-player-1.14.0.tar"), asset("esp32p4-player-1.14.0.ota")],
  },
  { tag_name: "firmware-v1.13.0", draft: false, assets: [asset("esp32c6-ota-1.13.0.tar"), asset("esp32p4-player-1.13.0.tar")] },
])!;

const welcome = (features: string[], fwVersion = ""): WelcomeMessage => ({ features, fwVersion }) as unknown as WelcomeMessage;

test("the device's board comes from its welcome features", () => {
  assert.equal(deviceBoard(welcome(["effects", "ota"])), "esp32c6");
  assert.equal(deviceBoard(welcome(["effects", "ota", "ota_inapp"])), "esp32p4");
  assert.equal(deviceBoard(welcome(["ota", "ota_pull"])), "max");
  assert.equal(deviceBoard(null), "esp32c6");
});

test("only the connected board's bundles are listed", () => {
  assert.deepEqual(
    entriesForBoard(index.entries, "esp32p4").map((e) => e.id),
    ["firmware-v1.14.0::player", "firmware-v1.13.0::player"],
  );
  assert.ok(entriesForBoard(index.entries, "esp32c6").every((e) => e.chip === "esp32c6"));
  assert.equal(newestForBoard(index.entries, "esp32c6")!.version, "1.15.0");
});

test("update available is judged against the newest release that HAS an asset for the board", () => {
  // 1.15.0 ships no P4 image: a P4 on 1.14.0 is up to date, not "update to 1.15.0".
  const p4 = updateState(index.entries, "esp32p4", "1.14.0");
  assert.equal(p4.kind, "current");
  const old = updateState(index.entries, "esp32p4", "1.13.0");
  assert.equal(old.kind, "available");
  assert.equal(old.kind === "available" && old.entry.id, "firmware-v1.14.0::player");
  assert.equal(updateState(index.entries, "esp32c6", "1.14.0").kind, "available");
  assert.equal(updateState(index.entries, "esp32p4", "").kind, "unknown");
  const c6Only = releasesToFirmwareIndex([{ tag_name: "firmware-v1.15.0", draft: false, assets: [asset("esp32c6-ota-1.15.0.tar")] }])!;
  assert.equal(updateState(c6Only.entries, "esp32p4", "1.14.0").kind, "none");
});

test("the Wi-Fi update never uses a cross-board bundle", () => {
  const c6Newest = index.entries[0]!;
  assert.equal(c6Newest.chip, "esp32c6");
  // The sheet's selection was the C6 bundle: a P4 gets its own newest instead.
  assert.equal(otaEntryFor(index.entries, c6Newest, "esp32p4")!.id, "firmware-v1.14.0::player");
  const p4Old = entriesForBoard(index.entries, "esp32p4")[1]!;
  assert.equal(otaEntryFor(index.entries, p4Old, "esp32p4"), p4Old, "a fitting pick is kept");
  assert.equal(otaEntryFor(index.entries, p4Old, "esp32c6")!.chip, "esp32c6");
  const c6Only = releasesToFirmwareIndex([{ tag_name: "firmware-v1.15.0", draft: false, assets: [asset("esp32c6-ota-1.15.0.tar")] }])!;
  assert.equal(otaEntryFor(c6Only.entries, c6Only.entries[0]!, "esp32p4"), null);
});

test("a package's signed board must match the device", () => {
  assert.equal(manifestBoard(16 << 24), 16);
  assert.equal(packageBoardMismatch(0, "esp32c6"), null);
  assert.equal(packageBoardMismatch(16 << 24, "esp32p4"), null);
  assert.equal(packageBoardMismatch(1 << 24, "max"), null);
  assert.match(packageBoardMismatch(0, "esp32p4")!, /for the ESP32-C6, but the connected device is the ESP32-P4/);
  assert.match(packageBoardMismatch(16 << 24, "esp32c6")!, /for the ESP32-P4/);
  assert.ok(packageBoardMismatch(16 << 24, "max"));
  // Key id / security version in bits 8..23 don't confuse it.
  assert.equal(packageBoardMismatch((16 << 24) | (3 << 8) | (2 << 16), "esp32p4"), null);
});
