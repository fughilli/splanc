/**
 * Association / reconnect hardening against a heap-tight player (5c8d2c1a,
 * #114, #125, #187, FUG-66): the board's TLS server has two slots (one on the
 * netstack build) and a cold handshake takes seconds, so the web side must
 *  - bound every connect attempt (10 s) and retry with per-attempt progress,
 *    without cutting off a slow-but-healthy handshake (~8.3 s measured on HITL);
 *  - stop after one doomed attempt on a never-trusted cert (each burns a slot the
 *    cert page needs), yet retry a remembered device over the backoff on reload,
 *    and ride out an ordinary reboot (same cert) within the warm-retry budget;
 *  - in the cert-trust flow, open the popup blank inside the click and only load
 *    the device page after the slot settles; register one listener pair per
 *    attempt and drop it; reconnect after a settle, over the backoff;
 *  - keep one TLS session per device: the liveness prober reads the app's own
 *    connection instead of opening a parallel one, and reports "unknown" rather
 *    than racing a handshake in flight;
 *  - probe lazily (one device per tick, backing off to 10 min, idle while the tab
 *    is hidden) with a ceiling long enough not to call a warming device offline.
 *    (The hidden-tab idling case is untraced: it is a power/scheduling property,
 *    not readiness or reconnect.)
 *
 * Drives the app connection manager, client, prober and device sheet against
 * simulated players behind a stand-in WebSocket (tests/deviceFakes.ts), under the
 * fake DOM and node:test's mocked timers.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { fire, installFakeDom } from "./fakeDom";

const dom = installFakeDom();
// One mocked-timer session for the whole file (see deviceIdentity.test.ts).
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { LedMapperClient } from "../src/net/client";
import { deviceProber } from "../src/net/deviceProber";
import { deviceStore } from "../src/store/deviceStore";
import { appState } from "../src/ui/app/state";
import { openDeviceSheet } from "../src/ui/screens/deviceSheet";
import {
  FakeLan,
  FakePlayerGatt,
  advance,
  all,
  button,
  buttonTitled,
  clearOverlays,
  installBluetooth,
  outcome,
  settle,
  type FakePlayer,
} from "./deviceFakes";

let lan: FakeLan;
let restoreWs: () => void = () => undefined;

beforeEach(() => {
  dom.document.hidden = true; // background prober parked unless a test wakes it
  localStorage.clear();
  lan = new FakeLan();
  restoreWs = lan.install();
});

afterEach(async () => {
  // Finish any cert-trust flow a test left waiting for the user to come back,
  // so its listeners and delayed reconnect can't leak into the next test.
  fire(dom.document, "visibilitychange");
  await advance(1000);
  clearOverlays();
  appState.disconnect();
  await settle();
  appState.disconnect();
  await settle();
  dom.document.hidden = true;
  delete (dom.window as unknown as { open?: unknown }).open;
  restoreWs();
  localStorage.clear();
});

const mac = (n: number): string => `58:E6:C5:00:00:${n.toString(16).padStart(2, "0").toUpperCase()}`;

/** A known (remembered) device record. */
function remember(host: string, n: number, name: string): string {
  const rec = deviceStore.upsert(`wss://${host}/ws`);
  deviceStore.applyWelcome(rec.id, { mac: mac(n), deviceName: name });
  return rec.id;
}

interface FakePopup {
  written: string;
  closed: boolean;
  location: { href: string };
  document: { write(html: string): void };
  close(): void;
}

/** Stand-in window.open: records calls and returns one controllable popup. */
function stubWindowOpen(): { calls: unknown[][]; popup: FakePopup } {
  const popup: FakePopup = {
    written: "",
    closed: false,
    location: { href: "about:blank" },
    document: {
      write(html: string) {
        popup.written += html;
      },
    },
    close() {
      popup.closed = true;
    },
  };
  const calls: unknown[][] = [];
  (dom.window as unknown as { open: (...a: unknown[]) => FakePopup }).open = (...a: unknown[]) => {
    calls.push(a);
    return popup;
  };
  return { calls, popup };
}

/** Connect to a device whose self-signed cert the browser does not trust yet,
 * leaving the app at the "trust needed" prompt. */
async function untrusted(host: string, n: number): Promise<FakePlayer> {
  const player = lan.add(host, { mac: mac(n), deviceName: `Board ${n}` });
  player.mode = "refuse";
  appState.connect(`wss://${host}/ws`);
  await settle();
  assert.equal(appState.status.certUrl, `https://${host}/`);
  return player;
}

test("a slow but healthy handshake (welcome after ~8.3 s) is not cut off by the connect bound [rr:PR-29]", async () => {
  const player = lan.add("10.0.0.81", { mac: mac(0x81), deviceName: "Den" });
  player.welcomeDelayMs = 8300; // both TLS slots contended (HITL slot_guard measurement)
  appState.connect("wss://10.0.0.81/ws");
  await advance(9000);

  assert.equal(appState.status.state, "connected");
  assert.equal(lan.socketsTo("10.0.0.81").length, 1, "connected on the first attempt");
});

test("a silent player's connect attempt is cut at the 10 s bound and retried with per-attempt progress [rr:PR-29]", async () => {
  const player = lan.add("10.0.0.82", { mac: mac(0x82), deviceName: "Porch" });
  player.mode = "silent"; // just joined Wi-Fi, not answering yet
  // A transport with nothing to trust (e.g. the native cert-pinning bridge), so
  // only the bound + backoff decide the retries.
  const client = new LedMapperClient("wss://10.0.0.82/ws", { certTrustPossible: false });
  const attempts: number[] = [];
  client.events = { onConnecting: (n) => attempts.push(n) };
  client.connect().catch(() => undefined);
  try {
    await advance(9900);
    const [first] = lan.socketsTo("10.0.0.82");
    assert.equal(first?.readyState, 0, "still waiting inside the bound");
    await advance(200);
    assert.equal(first?.readyState, 3, "the stuck socket was force-closed at 10 s");

    player.mode = "answer";
    await advance(1000); // 1 s backoff, then a fresh attempt
    assert.deepEqual(attempts, [1, 2], "one progress event per attempt");
    assert.ok(client.isConnected);
  } finally {
    client.close();
  }
});

test("a fresh connect to a device whose cert is not trusted stops after one attempt [rr:PR-29]", async () => {
  await untrusted("10.0.0.83", 0x83);
  assert.equal(appState.status.text, "trust needed");
  await advance(60_000);
  assert.equal(lan.socketsTo("10.0.0.83").length, 1, "no doomed handshakes hammering the TLS slots");
});

test("on reload a remembered device is retried over the backoff, not dropped after one slow attempt [rr:PR-29]", async () => {
  const player = lan.add("10.0.0.84", { mac: mac(0x84), deviceName: "Hall" });
  deviceStore.setActive(remember("10.0.0.84", 0x84, "Hall"));
  player.mode = "silent"; // the board is still booting when the page reloads

  appState.restoreActive();
  const client = appState.client!;
  const attempts: number[] = [];
  const shown = client.events.onConnecting;
  client.events.onConnecting = (n, url) => {
    attempts.push(n);
    shown?.(n, url);
  };
  await advance(10_500); // first attempt cut at the bound
  player.mode = "answer";
  await advance(2000);

  assert.ok(attempts.includes(2), "a second attempt was made instead of giving up");
  assert.ok(client.isConnected, "the remembered device reconnected on its own");
  assert.equal(client.welcome?.mac, mac(0x84));
});

test("the cert-trust popup opens blank in the click and loads the device page only after a settle [rr:PR-29]", async () => {
  await untrusted("10.0.0.85", 0x85);
  const opener = stubWindowOpen();
  openDeviceSheet();

  button("Trust & connect").click();
  assert.deepEqual(
    opener.calls[0],
    ["about:blank", "ledmapper-cert", "width=420,height=560"],
    "opened inside the gesture",
  );
  assert.match(opener.popup.written, /Preparing the device page/);
  assert.equal(appState.client, null, "the app released its own socket first");

  await advance(899);
  assert.equal(opener.popup.location.href, "about:blank", "the device is still re-listening its TLS slot");
  await advance(1);
  assert.equal(opener.popup.location.href, "https://10.0.0.85/");
});

test("a trust confirmed before the settle elapses never re-navigates the popup [rr:PR-29]", async () => {
  await untrusted("10.0.0.86", 0x86);
  const opener = stubWindowOpen();
  openDeviceSheet();
  button("Trust & connect").click();

  await advance(100);
  fire(dom.window, "message", { origin: "https://10.0.0.86", data: "ledmapper-cert-ok" });
  assert.equal(opener.popup.closed, true);
  await advance(2000);
  assert.equal(opener.popup.location.href, "about:blank", "not navigated after trust resolved");
});

test("returning from the cert page reconnects after a settle and drops the trust listeners [rr:PR-29]", async () => {
  const player = await untrusted("10.0.0.87", 0x87);
  const opener = stubWindowOpen();
  openDeviceSheet();
  const msg0 = dom.window.listenerCount("message");
  const vis0 = dom.document.listenerCount("visibilitychange");

  button("Trust & connect").click();
  assert.equal(dom.window.listenerCount("message"), msg0 + 1, "one message listener per attempt");
  assert.equal(dom.document.listenerCount("visibilitychange"), vis0 + 1);
  await advance(1000);

  player.mode = "answer"; // the user accepted the certificate in the popup
  fire(dom.document, "visibilitychange"); // …and came back to the app
  assert.equal(opener.popup.closed, true);
  assert.equal(dom.window.listenerCount("message"), msg0, "trust listeners removed");
  assert.equal(dom.document.listenerCount("visibilitychange"), vis0);

  const before = lan.socketsTo("10.0.0.87").length;
  await advance(799);
  assert.equal(lan.socketsTo("10.0.0.87").length, before, "no handshake while the slot settles");
  await advance(1);
  await settle();
  assert.equal(lan.socketsTo("10.0.0.87").length, before + 1);
  assert.equal(appState.status.state, "connected");
});

test("after trusting, a reconnect that lands on the still-lingering slot is retried over the backoff [rr:PR-29]", async () => {
  const player = await untrusted("10.0.0.88", 0x88);
  stubWindowOpen();
  openDeviceSheet();
  button("Trust & connect").click();
  await advance(1000);

  player.mode = "answer";
  player.refuseNext = 1; // the first handshake hits the slot the old socket still holds
  fire(dom.document, "visibilitychange");
  await advance(3000);

  assert.ok(appState.client?.isConnected, "connected on a retry instead of giving up");
  assert.equal(appState.client?.url, "wss://10.0.0.88/ws");
});

test("a retry that welcomes after the first connect attempt timed out still finishes connecting [rr:PR-29]", async () => {
  // The Android HITL connect journey (and the trust flow) connect with a retry
  // budget. Right after the cert page, the player's single TLS slot can still be
  // held by that page's connection, so the FIRST socket hits the 10 s bound and
  // connect() rejects; the client's own retry then reaches welcome. The app must
  // still run the post-welcome chain (identity, cert check, clock sync) and
  // report "connected" — it used to stick at "syncing clock…" with a live socket.
  const player = lan.add("10.0.0.87", { mac: mac(0x87), deviceName: "Attic" });
  player.mode = "silent"; // slot still held by the cert page's connection
  appState.connect("wss://10.0.0.87/ws", undefined, { coldRetryLimit: 6 });
  await advance(10_100);
  assert.notEqual(appState.status.state, "connected");

  player.mode = "answer";
  await advance(3000); // 1 s backoff, the retry's welcome, then the watch tick
  assert.ok(appState.client?.isConnected, "the retry reached welcome");
  assert.equal(appState.status.state, "connected");
  assert.equal(appState.status.text, "connected");
});

test("the liveness prober never opens a second TLS session to the device the app is connected to [rr:PR-29]", async () => {
  lan.add("10.0.0.89", { mac: mac(0x89), deviceName: "Lounge" });
  appState.connect("wss://10.0.0.89/ws");
  await settle();
  const id = deviceStore.activeId()!;
  remember("10.0.0.90", 0x90, "Kitchen");
  lan.add("10.0.0.90", { mac: mac(0x90), deviceName: "Kitchen" });

  await deviceProber.probeNow(id); // e.g. the sheet asking about the active device
  dom.document.hidden = false;
  deviceProber.refresh(); // the background loop runs for a while
  await advance(600_000, 1000);

  assert.equal(deviceProber.isReachable(id), true, "liveness read from the app's own connection");
  assert.equal(lan.socketsTo("10.0.0.89").length, 1, "never a parallel handshake to the connected device");
  assert.equal(lan.peakLiveTo("10.0.0.89"), 1);
  assert.ok(lan.socketsTo("10.0.0.90").length >= 1, "other devices are still probed");
});

test("while the app's own handshake is in flight, a probe reports unknown instead of racing it [rr:PR-29]", async () => {
  const player = lan.add("10.0.0.91", { mac: mac(0x91), deviceName: "Study" });
  player.welcomeDelayMs = 5000;
  appState.connect("wss://10.0.0.91/ws");
  await advance(100);
  const id = deviceStore.activeId()!;

  const probe = deviceProber.probeNow(id);
  assert.equal((await outcome(probe)).state, "fulfilled", "answered at once, without a handshake of its own");

  assert.equal(deviceProber.isReachable(id), false, "unknown while the owner is mid-handshake");
  assert.equal(lan.socketsTo("10.0.0.91").length, 1);
  await advance(5000);
  assert.equal(appState.status.state, "connected", "the app's handshake was not disturbed");
});

test("the background prober probes lazily, backing off toward one probe per ten minutes [rr:PR-29]", async () => {
  remember("10.0.0.92", 0x92, "Garden");
  lan.add("10.0.0.92", { mac: mac(0x92), deviceName: "Garden" });
  dom.document.hidden = false;

  deviceProber.refresh();
  await advance(1_800_000, 1000); // half an hour, nothing changing

  // 0.4 s, then +1, +2, +4, +8, +10 min (capped): six probes in 30 min.
  assert.equal(lan.socketsTo("10.0.0.92").length, 6);
  assert.equal(lan.peakLiveTo("10.0.0.92"), 1, "one probe at a time");
});

test("the background prober stays idle while the tab is hidden", async () => {
  remember("10.0.0.93", 0x93, "Garage");
  lan.add("10.0.0.93", { mac: mac(0x93), deviceName: "Garage" });
  dom.document.hidden = true;

  deviceProber.refresh();
  await advance(1_800_000, 1000);
  assert.equal(lan.socketsTo("10.0.0.93").length, 0, "no probes from a backgrounded tab");

  dom.document.hidden = false;
  deviceProber.refresh(); // the tab comes back
  await advance(1000);
  assert.equal(lan.socketsTo("10.0.0.93").length, 1);
});

test("a liveness probe waits out a warming device's slow handshake before calling it offline [rr:PR-29]", async () => {
  const id = remember("10.0.0.94", 0x94, "Shed");
  const player = lan.add("10.0.0.94", { mac: mac(0x94), deviceName: "Shed" });
  player.welcomeDelayMs = 8000; // freshly booted: a slow cold TLS session

  const probe = deviceProber.probeNow(id);
  await advance(9000);
  await probe;

  assert.equal(deviceProber.isReachable(id), true);
});

test("an ordinary reboot (same cert) reconnects within the warm budget without asking to re-trust [rr:PR-29]", async () => {
  const player = lan.add("10.0.0.95", { mac: mac(0x95), deviceName: "Office" });
  appState.connect("wss://10.0.0.95/ws");
  await settle();
  const client = appState.client!;
  assert.ok(client.isConnected);

  player.refuseNext = 2; // TLS not up for the first two attempts while it boots
  lan.dropAll("10.0.0.95");
  await advance(10_000);

  assert.equal(appState.client, client, "the same session object reconnects");
  assert.ok(client.isConnected, "reconnected after the reboot");
  assert.equal(appState.status.certUrl, null, "no re-trust prompt for an unchanged cert");
});

// -- #444: the demo-night "certificate grief" (Wi-Fi refused, BLE fallback) ----------
// A browser WebSocket cannot tell an untrusted cert from a device refusing a second
// client (the netstack player serves ONE Wi-Fi session and RST-refuses others while it
// is live — e.g. the Splanc agent holding it) or from a device that is not answering.
// The app must not send a once-trusted device, or a silent one, to the trust page, and
// must reconnect by itself when the cause clears.

/** Connect once successfully (the cert is trusted in this browser), then disconnect. */
async function trustedOnce(host: string, n: number, name: string): Promise<FakePlayer> {
  const player = lan.add(host, { mac: mac(n), deviceName: name });
  appState.connect(`wss://${host}/ws`);
  await settle();
  assert.equal(appState.status.state, "connected");
  appState.disconnect();
  await settle();
  return player;
}

test("a once-trusted device that refuses (busy with another client) is not sent to the trust page and reconnects when freed (#444)", async () => {
  const player = await trustedOnce("10.0.0.60", 0x60, "Big Lamp");
  player.mode = "refuse"; // e.g. the agent holds the device's one Wi-Fi session
  appState.connect("wss://10.0.0.60/ws");
  await settle();

  assert.equal(appState.status.certUrl, null, "no trust card after one refusal");
  assert.match(appState.status.error ?? "", /refused the connection.*one Wi-Fi connection at a time/);
  assert.match(appState.status.error ?? "", /Splanc agent/, "names the likely holder");

  await advance(5_000);
  player.mode = "answer"; // the other client let go
  await advance(20_000);
  assert.equal(appState.status.state, "connected", "reconnected by itself");
  assert.equal(appState.status.error, null);
});

test("a once-trusted device that keeps refusing offers trust-again and Bluetooth, and still reconnects on its own (#444)", async () => {
  const player = await trustedOnce("10.0.0.61", 0x61, "Big Lamp");
  player.mode = "refuse";
  appState.connect("wss://10.0.0.61/ws");
  await advance(20_000); // past the warm budget

  assert.equal(appState.status.text, "trust needed");
  assert.equal(appState.status.trustKind, "again");
  openDeviceSheet();
  const text = all(".device-trust-text")[0]?.textContent ?? "";
  assert.match(text, /Couldn't connect to Big Lamp over Wi-Fi/);
  assert.match(text, /one Wi-Fi connection at a time/);
  assert.ok(button("Trust again & connect"));
  assert.ok(button("Connect over Bluetooth"), "the fallback that needs neither");

  player.mode = "answer";
  await advance(20_000); // one slow retry (GAVE_UP_RETRY_MS)
  assert.equal(appState.status.state, "connected", "not wedged at the trust card");
  assert.equal(appState.status.certUrl, null);
});

test("a device nothing answers is reported as not answering, never as a cert to trust, and is retried (#444)", async () => {
  const player = lan.add("10.0.0.62", { mac: mac(0x62), deviceName: "Porch" });
  player.mode = "silent"; // rebooting / off this network / new address
  appState.connect("wss://10.0.0.62/ws");
  await advance(10_500);

  assert.equal(appState.status.certUrl, null, "a timeout is not a certificate problem");
  assert.match(appState.status.error ?? "", /isn't answering at 10\.0\.0\.62/);
  player.mode = "answer";
  await advance(15_000);
  assert.equal(appState.status.state, "connected");
});

test("closing the cert popup without a confirmation (its page refused to load) still reconnects (#444)", async () => {
  const player = await untrusted("10.0.0.63", 0x63);
  const opener = stubWindowOpen();
  openDeviceSheet();
  button("Trust & connect").click();
  await advance(1000);
  assert.equal(appState.client, null);

  // Desktop: the popup is its own window, so this page's visibility never changes
  // and the device page (which says "refused") never posts its message.
  player.mode = "answer";
  opener.popup.closed = true; // the user closes it
  await advance(500 + 800 + 100);
  await settle();
  assert.ok(appState.client, "a reconnect started");
  await advance(1000);
  assert.equal(appState.status.state, "connected");
});

test("after the cert page confirms trust, a busy device is reported as busy and retried, not looped back to trust (#444)", async () => {
  const player = await untrusted("10.0.0.64", 0x64);
  stubWindowOpen();
  openDeviceSheet();
  button("Trust & connect").click();
  await advance(1000);

  // The device page loaded and posted its confirmation, but by the time the app
  // reconnects another client has taken the device's one session.
  fire(dom.window, "message", { origin: "https://10.0.0.64", data: "ledmapper-cert-ok" });
  await advance(900);
  await settle();
  assert.equal(appState.status.certUrl, null, "not straight back to the trust card");
  assert.match(appState.status.error ?? "", /refused the connection/);

  await advance(60_000);
  if (appState.status.certUrl) assert.equal(appState.status.trustKind, "again", "worded as busy / trust again");
  const n = lan.socketsTo("10.0.0.64").length;
  player.mode = "answer";
  await advance(20_000);
  assert.ok(lan.socketsTo("10.0.0.64").length > n);
  assert.equal(appState.status.state, "connected");
});

test("a network drop that outlasts the warm budget (device still holding the dead session) reconnects without the user (#444)", async () => {
  const player = lan.add("10.0.0.65", { mac: mac(0x65), deviceName: "Office" });
  appState.connect("wss://10.0.0.65/ws");
  await settle();
  const client = appState.client!;

  // The phone roamed: the device keeps the dead session ~21 s (15 s idle ping +
  // 6 s peer-gone reclaim) and RST-refuses every reconnect meanwhile.
  player.mode = "refuse";
  lan.dropAll("10.0.0.65");
  await advance(21_000);
  player.mode = "answer";
  await advance(20_000);

  assert.equal(appState.client, client);
  assert.ok(client.isConnected, "reconnected by itself");
  assert.equal(appState.status.state, "connected");
});

test("falling back to Bluetooth keeps the device's Wi-Fi address, and switching back is one tap (#444)", async () => {
  await trustedOnce("10.0.0.66", 0x66, "Big Lamp");
  const board = new FakePlayerGatt({ mac: mac(0x66), deviceName: "Big Lamp" }, { id: "bt-lamp" });
  const bt = installBluetooth(() => board);
  try {
    openDeviceSheet();
    buttonTitled("Connect over Bluetooth (offline)").click();
    await advance(1000);
    assert.equal(appState.status.state, "connected");
    const rec = deviceStore.active()!;
    assert.ok(rec.wssUrl.startsWith("ble:"));
    assert.equal(rec.lanUrl, "wss://10.0.0.66/ws", "the merged Wi-Fi record's address is kept");
    assert.ok(rec.wssOkAt, "…with its trust");
    assert.equal(deviceStore.list().length, 1, "still one record for the one device");

    appState.disconnect();
    await settle();
    clearOverlays();
    openDeviceSheet();
    buttonTitled("Connect over Wi-Fi (10.0.0.66)").click();
    await settle();
    assert.equal(appState.status.state, "connected");
    assert.equal(appState.client?.url, "wss://10.0.0.66/ws");
  } finally {
    bt.restore();
  }
});
