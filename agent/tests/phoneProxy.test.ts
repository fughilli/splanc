/**
 * The stage's phone proxy (src/stage/phoneProxy.ts) against a fake ScreenStream:
 * an HTTPS server with the test certificate that frames itself SAMEORIGIN-only and
 * checks Origin == Host like the fork does. Through the proxy the page loads with
 * no certificate prompt, can be framed, keeps its WebSocket, and a different
 * certificate at the same address is refused.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { PhoneProxy, responseHeaders } from "../src/stage/phoneProxy";
import { FIXTURES, TEST_CERT2_SHA256, TEST_CERT_SHA256 } from "./fakePlayer";

/** A fake ScreenStream page server (the fork's headers and same-origin checks). */
async function fakePhone(certName: "cert" | "cert2", port = 0) {
  const seen: { host: string | undefined; origin: string | undefined; referer: string | undefined }[] = [];
  const server = https.createServer(
    {
      cert: readFileSync(join(FIXTURES, `${certName}.pem`)),
      key: readFileSync(join(FIXTURES, certName === "cert" ? "key.pem" : "key2.pem")),
    },
    (req, res) => {
      seen.push({ host: req.headers.host, origin: req.headers.origin, referer: req.headers.referer });
      const sameOrigin = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
      if (req.url === "/start-stop" && !sameOrigin) return void res.writeHead(403).end();
      if (req.url === "/moved") return void res.writeHead(302, { location: `https://127.0.0.1:${addr().port}/` }).end();
      res.writeHead(200, {
        "content-type": "text/html",
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
        "strict-transport-security": "max-age=1",
      });
      res.end(`<p>phone ${certName}</p>`);
    },
  );
  const wss = new WebSocketServer({ server, path: "/socket" });
  wss.on("connection", (ws, req) => {
    const ok = new URL(String(req.headers.origin)).host === req.headers.host;
    ws.send(ok ? "hello" : "origin rejected");
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const addr = () => server.address() as AddressInfo;
  return { server, seen, port: addr().port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const logs: string[] = [];
const pins: string[] = [];
const proxy = new PhoneProxy((m) => logs.push(m), (fp) => pins.push(fp));
after(() => proxy.close());

test("the phone's page through the proxy: no certificate prompt, framable, its own origin", async () => {
  const port = await proxy.listen(0, "127.0.0.1");
  const local = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${local}/`)).status, 503, "nothing paired yet");

  const phone = await fakePhone("cert");
  try {
    proxy.setTarget(`https://127.0.0.1:${phone.port}/`);
    const r = await fetch(`${local}/?splanc=1`, { headers: { origin: "http://localhost:7420", referer: "http://localhost:7420/" } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "<p>phone cert</p>");
    assert.equal(r.headers.get("x-frame-options"), null, "framable");
    assert.equal(r.headers.get("content-security-policy"), "default-src 'self'", "frame-ancestors dropped, the rest kept");
    assert.equal(r.headers.get("strict-transport-security"), null);
    assert.deepEqual(phone.seen.at(-1), { host: `127.0.0.1:${phone.port}`, origin: `https://127.0.0.1:${phone.port}`, referer: undefined });
    assert.equal(proxy.fingerprint, TEST_CERT_SHA256, "the certificate is pinned");
    assert.deepEqual(pins, [TEST_CERT_SHA256]);

    // Same-origin endpoints pass (the proxy speaks as the phone's own origin).
    assert.equal((await fetch(`${local}/start-stop`, { headers: { origin: local } })).status, 200);
    // A redirect to the phone comes back pointed at the proxy.
    const moved = await fetch(`${local}/moved`, { redirect: "manual" });
    assert.equal(moved.headers.get("location"), `${local}/`);

    // The viewer's WebSocket.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket?clientId=x`, { origin: local });
    const msg = await new Promise<string>((resolve, reject) => {
      ws.once("message", (d) => resolve(String(d)));
      ws.once("error", reject);
    });
    ws.close();
    assert.equal(msg, "hello");
  } finally {
    await phone.close();
  }
});

test("a different certificate at the paired address is refused until pairing again", async () => {
  const first = await fakePhone("cert");
  const port = first.port;
  proxy.setTarget(`https://127.0.0.1:${port}/`);
  const local = `http://127.0.0.1:${proxy.port}`;
  assert.equal((await fetch(`${local}/`)).status, 200);
  await first.close();

  const impostor = await fakePhone("cert2", port);
  try {
    const r = await fetch(`${local}/`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /certificate changed/);
    assert.equal(impostor.seen.length, 0, "nothing was sent to it");

    proxy.setTarget(`https://127.0.0.1:${port}/`); // paired again
    assert.equal((await fetch(`${local}/`)).status, 200);
    assert.equal(proxy.fingerprint, TEST_CERT2_SHA256);
  } finally {
    await impostor.close();
  }
});

test("redirects elsewhere and other headers pass through", () => {
  const t = new URL("https://192.168.1.50:8081/");
  assert.deepEqual(
    responseHeaders(["Location", "https://example.com/x", "Content-Type", "text/html", "Content-Security-Policy", "frame-ancestors 'self'"], t, "http://localhost:7422"),
    [
      ["Location", "https://example.com/x"],
      ["Content-Type", "text/html"],
    ],
  );
  assert.deepEqual(responseHeaders(["location", "http://192.168.1.50:8080/stream"], t, "http://localhost:7422"), [["location", "http://localhost:7422/stream"]]);
});
