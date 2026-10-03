/**
 * Readiness-aware, flake-hardened Improv provisioning (8a207852, e181e4ee,
 * #175, FUG-92): Android's GATT stack fails "GATT operation failed for unknown
 * reason" at connect, discovery, subscribe AND write, and some stacks resolve
 * connect() before the link is usable — yet one button press must succeed. So
 * the first GATT operation waits for a post-connect settle; the WHOLE handshake
 * (connect → settle → discover → subscribe → send credentials) is retried after
 * a clean disconnect, bounded to five attempts; and the network-join wait sits
 * outside that retry — a slow join is not a flake, so credentials are not re-sent
 * — with its own bound. A write the board received although the phone saw it
 * fail is re-sent byte-identically, which the firmware treats as an idempotent
 * duplicate (#175). In the native app the Bluetooth picker names boards by their
 * advertisement (iOS hides it from the plugin's chooser) and lists each once.
 *
 * Drives the production provisioning path against simulated Improv boards with
 * per-operation flake injection (tests/deviceFakes.ts), under node:test's mocked
 * timers — every settle, retry delay and join wait is virtual time.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { installFakeDom } from "./fakeDom";

installFakeDom();
// One mocked-timer session for the whole file (see deviceIdentity.test.ts).
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { provisionViaBle } from "../src/net/improv";
import { pickImprovDeviceNative } from "../src/ui/screens/blePicker";
import {
  FakeCapacitorBle,
  FakeImprovDevice,
  advance,
  all,
  button,
  buttonTitled,
  clearOverlays,
  clock,
  outcome,
  parseWifiSettings,
  settle,
} from "./deviceFakes";

let undoPlugin: () => void = () => undefined;

beforeEach(() => {
  clock.now = 0;
});

afterEach(async () => {
  clearOverlays();
  await settle();
  undoPlugin();
  undoPlugin = () => undefined;
});

const BOARD_URL = ["http://192.168.1.50/"];

test("the first GATT operation waits for the link to settle after connect [rr:PR-29]", async () => {
  const dev = new FakeImprovDevice();
  const result = provisionViaBle(dev, "HomeNet", "hunter22");

  await advance(299);
  assert.ok(dev.ops().includes("connect"), "connected");
  assert.ok(!dev.ops().includes("discover"), "no GATT operation within the 300 ms settle");
  await advance(1);
  assert.ok(dev.ops().includes("discover"), "service discovery right after the settle");
  assert.ok(dev.at("discover")! - dev.at("connect")! >= 300);

  await advance(500);
  assert.deepEqual(await outcome(result), { state: "fulfilled", value: BOARD_URL });
});

test("a flake while subscribing retries the whole handshake after a clean disconnect [rr:PR-29]", async () => {
  const dev = new FakeImprovDevice({ flakes: { subscribe: 1 } });
  const statuses: string[] = [];
  const result = provisionViaBle(dev, "HomeNet", "hunter22", (s) => statuses.push(s));
  await advance(5000);

  assert.deepEqual(await outcome(result), { state: "fulfilled", value: BOARD_URL });
  assert.equal(dev.connects, 2, "reconnected for the second attempt");
  const ops = dev.ops();
  const failedAt = ops.indexOf("subscribe?");
  const dropAt = ops.indexOf("disconnect");
  const reconnectAt = ops.indexOf("connect?", failedAt);
  assert.ok(failedAt < dropAt && dropAt < reconnectAt, `clean disconnect between attempts: ${ops.join(" ")}`);
  assert.equal(dev.delivered.length, 1, "credentials sent once, by the attempt that got through");
  assert.ok(statuses.includes("Connecting (retry 1)…"), statuses.join(" | "));
});

test("a flake on the credential write is retried until the board has the credentials [rr:PR-29]", async () => {
  const dev = new FakeImprovDevice({ flakes: { write: 2 } });
  const result = provisionViaBle(dev, "HomeNet", "hunter22");
  await advance(8000);

  assert.deepEqual(await outcome(result), { state: "fulfilled", value: BOARD_URL });
  assert.equal(dev.connects, 3);
  assert.equal(dev.delivered.length, 1);
  assert.deepEqual(parseWifiSettings(dev.delivered[0]!), { ssid: "HomeNet", password: "hunter22" });
});

test("provisioning gives up with the GATT error after five attempts [rr:PR-29]", async () => {
  const dev = new FakeImprovDevice({ flakes: { connect: 1000 } });
  const result = provisionViaBle(dev, "HomeNet", "hunter22");
  result.catch(() => undefined);

  await advance(4100); // retry delays 400 + 800 + 1200 + 1600 ms
  const o = await outcome(result);
  assert.equal(o.state, "rejected");
  assert.match(String(o.state === "rejected" ? o.reason : ""), /GATT operation failed/);
  assert.equal(dev.connects, 5);
  await advance(30_000);
  assert.equal(dev.connects, 5, "no further attempts after giving up");
});

test("a slow network join is waited out without re-sending the credentials [rr:PR-29]", async () => {
  const dev = new FakeImprovDevice({ joinDelayMs: 30_000 });
  const result = provisionViaBle(dev, "HomeNet", "hunter22");

  await advance(20_000);
  assert.equal((await outcome(result)).state, "pending", "still joining");
  await advance(11_000);

  assert.deepEqual(await outcome(result), { state: "fulfilled", value: BOARD_URL });
  assert.equal(dev.connects, 1, "a slow join is not treated as a GATT flake");
  assert.equal(dev.delivered.length, 1, "credentials were sent exactly once");
});

test("a join that never completes fails after a bounded wait instead of hanging [rr:PR-29]", async () => {
  const dev = new FakeImprovDevice({ silent: true });
  const result = provisionViaBle(dev, "HomeNet", "hunter22");
  result.catch(() => undefined);

  await advance(44_000);
  assert.equal((await outcome(result)).state, "pending");
  await advance(2_000);
  const o = await outcome(result);
  assert.equal(o.state, "rejected");
  assert.match(String(o.state === "rejected" ? o.reason : ""), /timed out waiting for the device to join/);
  assert.equal(dev.delivered.length, 1);
});

test("credentials the board got although the phone saw the write fail are re-sent byte-identically [rr:PR-29]", async () => {
  const dev = new FakeImprovDevice({ flakes: { writeAfterDelivery: 1 } });
  const result = provisionViaBle(dev, "HomeNet", "hunter22");
  await advance(5000);

  assert.deepEqual(await outcome(result), { state: "fulfilled", value: BOARD_URL });
  assert.equal(dev.delivered.length, 2, "the retry re-sent the credentials");
  assert.deepEqual(
    Array.from(dev.delivered[1]!),
    Array.from(dev.delivered[0]!),
    "a duplicate SendWifi for the same network, which the firmware handles idempotently",
  );
});

test("the native picker names boards by their advertisement and lists each board once [rr:PR-29]", async () => {
  const plugin = new FakeCapacitorBle();
  undoPlugin = plugin.install();
  const picked = pickImprovDeviceNative();
  await settle();
  assert.ok(plugin.scanning, "scanning for Improv boards");

  // iOS: the GAP name is empty during a service-filtered scan; the scan-response
  // local name carries it. Boards re-advertise continuously.
  plugin.advertise({ device: { deviceId: "A", name: "" }, localName: "splanc-kitchen", rssi: -50 });
  plugin.advertise({ device: { deviceId: "A", name: "splanc-kitchen" }, localName: "splanc-kitchen", rssi: -47 });
  plugin.advertise({ device: { deviceId: "B", name: "splanc-porch" } });
  plugin.advertise({ device: { deviceId: "C" } });
  plugin.advertise({ device: { deviceId: "B", name: "splanc-porch" } });

  assert.deepEqual(
    all(".k-btn--block").map((b) => b.textContent),
    ["splanc-kitchen", "splanc-porch", "Splanc device"],
  );

  button("splanc-porch").click();
  await settle();
  const o = await outcome(picked);
  assert.equal(o.state, "fulfilled");
  const dev = o.state === "fulfilled" ? o.value : null;
  assert.equal(dev?.id, "B");
  assert.equal(dev?.name, "splanc-porch");
  assert.equal(plugin.scanning, false, "the scan stops once a board is picked");
});

test("dismissing the native picker stops the scan and cancels quietly [rr:PR-29]", async () => {
  const plugin = new FakeCapacitorBle();
  undoPlugin = plugin.install();
  const picked = pickImprovDeviceNative();
  picked.catch(() => undefined);
  await settle();
  plugin.advertise({ device: { deviceId: "A" }, localName: "splanc-kitchen" });

  buttonTitled("Close").click();
  await settle();

  const o = await outcome(picked);
  assert.equal(o.state, "rejected");
  assert.equal(o.state === "rejected" ? (o.reason as DOMException).name : "", "AbortError");
  assert.equal(plugin.scanning, false, "no Bluetooth scan left running");
});
