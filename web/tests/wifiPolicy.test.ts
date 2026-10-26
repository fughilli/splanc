/**
 * Wi-Fi rejoin policy, app side (src/net/wifiPolicy.ts): the device card's
 * status wording, the wire <-> app conversion (through the real proto boundary),
 * and which mode changes must ask first.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeClient, decodeServer, encodeClient, encodeServer } from "../src/net/proto";
import {
  formatDuration,
  formatWifiStatus,
  normalizeWifiPolicy,
  parseWholeNumber,
  wifiModeConfirmation,
  wifiModeNeedsConfirmedUpdate,
  wifiPolicyMessage,
  type WifiPolicy,
} from "../src/net/wifiPolicy";

const BASE: WifiPolicy = {
  mode: "auto",
  scanCapS: 60,
  intervalS: 300,
  decayAfterH: 0,
  sparseIntervalS: 900,
  state: "joined",
  nextScanS: 0,
  scans: 0,
  ssid: "Venue1",
  unseenS: 0,
  decayed: false,
  otaPending: false,
  refused: "",
  radioOn: true,
};
const at = (p: Partial<WifiPolicy>): WifiPolicy => ({ ...BASE, ...p });

test("formatDuration: s / min / h / d", () => {
  assert.equal(formatDuration(40), "40 s");
  assert.equal(formatDuration(59.6), "1 min");
  assert.equal(formatDuration(300), "5 min");
  assert.equal(formatDuration(3 * 3600), "3 h");
  assert.equal(formatDuration(2 * 86400 + 100), "2 d");
  assert.equal(formatDuration(-5), "0 s");
});

test("formatWifiStatus covers every mode / link state", () => {
  assert.equal(formatWifiStatus(at({})), "Wi-Fi: joined (Venue1)");
  assert.equal(formatWifiStatus(at({ ssid: "" })), "Wi-Fi: joined");
  // Offline wins whatever the link reports (radio may still be winding down).
  assert.equal(formatWifiStatus(at({ mode: "offline", state: "offline", radioOn: false })), "Wi-Fi: offline mode");
  assert.equal(formatWifiStatus(at({ mode: "offline", state: "joined" })), "Wi-Fi: offline mode");
  assert.equal(
    formatWifiStatus(at({ state: "searching", nextScanS: 40, unseenS: 30, scans: 2 })),
    "Wi-Fi: rejoining, next scan in 40 s",
  );
  assert.equal(formatWifiStatus(at({ mode: "fixed", state: "searching", nextScanS: 0 })), "Wi-Fi: rejoining, scanning");
  assert.equal(
    formatWifiStatus(at({ state: "searching", decayed: true, unseenS: 2 * 86400, nextScanS: 600 })),
    "Wi-Fi: searching (slowed: unseen 2 d)",
  );
  assert.equal(formatWifiStatus(at({ mode: "manual", state: "idle" })), "Wi-Fi: manual — not joining");
  assert.equal(formatWifiStatus(at({ mode: "manual", state: "searching" })), "Wi-Fi: manual — trying to join now");
  assert.equal(formatWifiStatus(at({ state: "joining" })), "Wi-Fi: joining (Venue1)");
  assert.equal(formatWifiStatus(at({ state: "unprovisioned", ssid: "" })), "Wi-Fi: not set up");
  assert.equal(formatWifiStatus(at({ state: "unknown" })), "Wi-Fi: unknown");
});

test("request -> wire: unset fields stay unset; force/rejoin only when true", () => {
  assert.deepEqual(wifiPolicyMessage({ rejoinNow: true }), { type: "set_wifi_policy", rejoinNow: true });
  assert.deepEqual(wifiPolicyMessage({ mode: "offline", force: false }), {
    type: "set_wifi_policy",
    mode: "WIFI_MODE_OFFLINE",
  });
  const msg = wifiPolicyMessage({ mode: "auto", scanCapS: 120, decayAfterH: 0, force: true });
  assert.deepEqual(msg, { type: "set_wifi_policy", mode: "WIFI_MODE_AUTO", scanCapS: 120, decayAfterH: 0, force: true });
  // Through the real proto boundary: AUTO (= 0) and decay 0 keep their presence.
  const back = decodeClient(encodeClient(msg as never)) as unknown as Record<string, unknown>;
  assert.equal(back["mode"], "WIFI_MODE_AUTO");
  assert.equal(back["decayAfterH"], 0);
  assert.equal("intervalS" in back, false);
});

test("wire -> app: a sparse wifi_policy_state normalizes (proto3 drops defaults)", () => {
  const wire = decodeServer(
    encodeServer({
      type: "wifi_policy_state",
      mode: "WIFI_MODE_MANUAL",
      state: "WIFI_LINK_IDLE",
      ssid: "Venue1",
      otaPending: true,
      refused: "ota_pending",
    } as never),
  );
  const p = normalizeWifiPolicy(wire as unknown as Record<string, unknown>);
  assert.deepEqual(p, {
    ...BASE,
    mode: "manual",
    scanCapS: 0,
    intervalS: 0,
    decayAfterH: 0,
    sparseIntervalS: 0,
    state: "idle",
    otaPending: true,
    refused: "ota_pending",
    radioOn: false,
  });
  // Numeric enums (another decoder) and an empty object are tolerated.
  assert.equal(normalizeWifiPolicy({ mode: 3, state: 6 }).mode, "offline");
  assert.equal(normalizeWifiPolicy({ mode: 3, state: 6 }).state, "joined");
  assert.equal(normalizeWifiPolicy({}).mode, "auto");
  assert.equal(normalizeWifiPolicy({}).state, "unknown");
});

test("leaving the network asks first; only manual/offline need a confirmed update", () => {
  assert.equal(wifiModeConfirmation("auto", "fixed"), null);
  assert.equal(wifiModeConfirmation("offline", "offline"), null);
  assert.equal(wifiModeConfirmation("offline", "auto"), null);
  const off = wifiModeConfirmation("auto", "offline");
  assert.ok(off && /credentials are kept/.test(off.message) && /Bluetooth/.test(off.message));
  assert.ok(wifiModeConfirmation("fixed", "manual"));
  assert.equal(wifiModeNeedsConfirmedUpdate("offline"), true);
  assert.equal(wifiModeNeedsConfirmedUpdate("manual"), true);
  assert.equal(wifiModeNeedsConfirmedUpdate("auto"), false);
  assert.equal(wifiModeNeedsConfirmedUpdate("fixed"), false);
});

test("parseWholeNumber", () => {
  assert.equal(parseWholeNumber(" 300 "), 300);
  assert.equal(parseWholeNumber("0"), 0);
  assert.equal(parseWholeNumber(""), null);
  assert.equal(parseWholeNumber("1.5"), null);
  assert.equal(parseWholeNumber("-3"), null);
});
