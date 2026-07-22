/**
 * Improv BLE codec vectors — shared with the firmware's C++ leg
 * (firmware/player_app/improv_codec_test.cc pins the SAME bytes), so the
 * app and the device cannot drift apart on the wire.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWifiSettings, parseRpcResult, wsUrlFromRedirect } from "../src/net/improv";

test("wifi settings packet: layout + checksum", () => {
  const pkt = buildWifiSettings("net", "pw");
  // cmd=1, len=2+3+2=7, ssid(3) "net", pass(2) "pw", checksum
  assert.deepEqual(
    Array.from(pkt),
    [
      0x01,
      0x07,
      0x03,
      0x6e,
      0x65,
      0x74, // "net"
      0x02,
      0x70,
      0x77, // "pw"
      (0x01 + 0x07 + 0x03 + 0x6e + 0x65 + 0x74 + 0x02 + 0x70 + 0x77) & 0xff,
    ],
  );
});

test("wifi settings: open network (empty password) is allowed", () => {
  const pkt = buildWifiSettings("open", "");
  assert.equal(pkt[1], 2 + 4 + 0);
  assert.equal(pkt[2 + 1 + 4], 0); // pass_len = 0
});

test("rpc result parses the redirect URL strings", () => {
  const url = "http://192.168.1.50/";
  const enc = new TextEncoder().encode(url);
  const body = [0x01, enc.length + 1, enc.length, ...enc];
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  const strings = parseRpcResult(new Uint8Array([...body, sum]));
  assert.deepEqual(strings, [url]);
});

test("rpc result rejects bad checksum / wrong command / truncation", () => {
  const url = new TextEncoder().encode("http://x/");
  const body = [0x01, url.length + 1, url.length, ...url];
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  assert.equal(parseRpcResult(new Uint8Array([...body, (sum + 1) & 0xff])), null);
  assert.equal(parseRpcResult(new Uint8Array([0x02, ...body.slice(1), sum])), null);
  assert.equal(parseRpcResult(new Uint8Array(body)), null); // no checksum byte
});

test("player WS endpoint from the redirect URL (wss on 443)", () => {
  // The device reports http://<ip>/ over BLE but speaks wss on 443 → target it.
  assert.equal(wsUrlFromRedirect("http://192.168.1.50/"), "wss://192.168.1.50/ws");
  assert.equal(wsUrlFromRedirect("https://player.local/"), "wss://player.local/ws");
  assert.equal(wsUrlFromRedirect("not a url"), null);
  assert.equal(wsUrlFromRedirect("ftp://x/"), null);
});

test("retryGatt returns after transient failures without sleeping for real", async () => {
  const { retryGatt } = await import("../src/net/improv");
  let calls = 0;
  const retries: number[] = [];
  const result = await retryGatt(
    async () => {
      calls++;
      if (calls < 3) throw new Error("GATT operation failed for unknown reason");
      return "ok";
    },
    { onRetry: (n) => retries.push(n), sleepFn: async () => undefined },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3, "succeeded on the 3rd try");
  assert.deepEqual(retries, [1, 2], "retried after attempts 1 and 2");
});

test("retryGatt rethrows the last error after exhausting attempts", async () => {
  const { retryGatt } = await import("../src/net/improv");
  let calls = 0;
  await assert.rejects(
    () =>
      retryGatt(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { attempts: 3, sleepFn: async () => undefined },
      ),
    /fail 3/,
  );
  assert.equal(calls, 3);
});
