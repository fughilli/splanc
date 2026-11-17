// The diagnostics app event log's pure core (src/store/appLog.ts): bounded ring
// buffer + redaction of what must not leave the phone.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppLogBuffer,
  connTransition,
  errorText,
  fnv1a,
  logUrl,
  MAX_MSG,
  opaqueDeviceId,
  redactText,
} from "../src/store/appLog";

const NOW = new Date("2026-11-17T03:28:00.000Z");

test("the buffer keeps at most N entries, oldest dropped first", () => {
  const b = new AppLogBuffer(3, 1_000_000);
  for (let i = 0; i < 5; i++) b.add("info", `event ${i}`, undefined, { now: NOW });
  assert.deepEqual(
    b.list().map((e) => e.msg),
    ["event 2", "event 3", "event 4"],
  );
  assert.equal(b.size, 3);
});

test("the buffer is bounded in bytes too", () => {
  const b = new AppLogBuffer(10_000, 2_000);
  for (let i = 0; i < 100; i++) b.add("toast", "network error ".repeat(8) + i, undefined, { now: NOW });
  assert.ok(b.byteSize <= 2_000, `${b.byteSize}`);
  assert.ok(b.size > 1 && b.size < 100);
  assert.match(b.list().at(-1)!.msg, /99$/, "the newest survives");
  assert.ok(JSON.stringify(b.list()).length <= 2_000 + b.size);
});

test("restore puts persisted entries before the live ones, skipping junk, within bounds", () => {
  const b = new AppLogBuffer(4, 1_000_000);
  b.add("info", "app started", undefined, { now: NOW });
  b.restore([
    { t: "2026-11-17T03:00:00.000Z", kind: "toast", msg: "old 1" },
    { nope: true },
    null,
    { t: "2026-11-17T03:01:00.000Z", kind: "fetch", msg: "old 2" },
  ]);
  assert.deepEqual(
    b.list().map((e) => e.msg),
    ["old 1", "old 2", "app started"],
  );
});

test("entries carry redacted messages and data", () => {
  const b = new AppLogBuffer();
  const e = b.add(
    "conn",
    "connecting: Living Room Lamp at 192.168.87.40:443 isn't answering (wss://192.168.87.40/ws)",
    { device: "Living Room Lamp", status: 503, ok: false, skip: undefined },
    { known: { "Living Room Lamp": "dev#1234abcd" }, now: NOW },
  )!;
  assert.equal(e.t, "2026-11-17T03:28:00.000Z");
  assert.doesNotMatch(e.msg, /Living Room|192\.168/);
  assert.match(e.msg, /dev#1234abcd/);
  assert.deepEqual(e.data, { device: "dev#1234abcd", status: 503, ok: false });
});

test("redactText masks addresses, MACs, URL queries, ws URLs and key-shaped tokens", () => {
  assert.equal(redactText("joined 10.0.0.7:8443 ok"), "joined <ip> ok");
  assert.equal(redactText("mac 40:4c:ca:4b:9e:20 seen"), "mac <mac> seen");
  assert.equal(redactText("socket wss://lamp.local:443/ws?t=1 closed"), "socket ws://<device> closed");
  assert.equal(
    redactText("GET https://splanc.io/app/fx-compiler/fx_compiler_wasm_pkg.js?retry=2#x failed"),
    "GET https://splanc.io/app/fx-compiler/fx_compiler_wasm_pkg.js failed",
  );
  assert.equal(redactText("key sk-ant-api03-abcdefghijklmnop rejected"), "key <secret> rejected");
  assert.equal(redactText(`token ${"A1b2".repeat(12)} rejected`), "token <secret> rejected");
  // Ordinary text and paths survive.
  assert.equal(redactText("Failed to fetch dynamically imported module"), "Failed to fetch dynamically imported module");
  // Long messages are cut.
  assert.equal(redactText("y ".repeat(MAX_MSG)).length, MAX_MSG);
});

test("known strings are replaced longest-first and literally (regex chars are safe)", () => {
  const out = redactText("Lamp (2) and Lamp", { Lamp: "dev#a", "Lamp (2)": "dev#b" });
  assert.equal(out, "dev#b and dev#a");
});

test("logUrl keeps origin + path only", () => {
  assert.equal(logUrl("https://api.example.com/v1/x?key=secret#frag"), "https://api.example.com/v1/x");
  assert.equal(logUrl("/firmware/index.json?x=1", "https://splanc.io/app/"), "https://splanc.io/firmware/index.json");
  assert.equal(logUrl("https://user:pw@host.example/p"), "https://host.example/p");
  assert.equal(logUrl("http://192.168.1.20:8093/chatlogs"), "http://<ip>/chatlogs");
});

test("opaque device ids are stable and don't reveal the address", () => {
  const id = "dev-wss-192-168-87-40-443";
  assert.equal(opaqueDeviceId(id), opaqueDeviceId(id));
  assert.match(opaqueDeviceId(id), /^dev#[0-9a-f]{8}$/);
  assert.doesNotMatch(opaqueDeviceId(id), /192/);
  assert.notEqual(opaqueDeviceId(id), opaqueDeviceId("dev-other"));
  assert.equal(opaqueDeviceId(null), "none");
  assert.equal(fnv1a(""), "811c9dc5");
});

test("errorText names DOMException-like errors; never throws", () => {
  assert.equal(errorText(new TypeError("Failed to fetch")), "TypeError: Failed to fetch");
  assert.equal(errorText({ name: "NotAllowedError", message: "Permission denied" }), "NotAllowedError: Permission denied");
  assert.equal(errorText("plain"), "plain");
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(errorText(cyclic), "(unprintable)");
});

test("connTransition fires on any state/text/error change only", () => {
  const a = { state: "connecting", text: "connecting…", error: null };
  assert.equal(connTransition(null, a), true);
  assert.equal(connTransition(a, { ...a }), false);
  assert.equal(connTransition(a, { ...a, state: "ok" }), true);
  assert.equal(connTransition(a, { ...a, error: "refused" }), true);
});

test("add never throws, even on hostile input", () => {
  const b = new AppLogBuffer();
  const hostile = {
    get message(): string {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => b.add("error", hostile));
  assert.doesNotThrow(() => b.add("error", Symbol("s") as unknown as string));
});
