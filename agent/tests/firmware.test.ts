/** update_firmware's package resolution and canary rollout (src/firmware.ts). The
 * over-the-air protocol itself is web/tests/otaUpdate.test.ts + the HITL OTA gate. */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { canaryRollout, releaseMaxEpochUrl, releaseMaxManifestUrl, releasePackageUrl, resolvePackage } from "../src/firmware";

function otaPackage(version: number, size = 64): Uint8Array {
  const out = new Uint8Array(108 + size);
  new DataView(out.buffer).setUint32(0, version, true);
  new DataView(out.buffer).setUint32(4, size, true);
  return out;
}

function fakeFetch(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const impl = async (url: string) => {
    seen.push(url);
    const body = routes[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: async () => body,
      arrayBuffer: async () => (body as Uint8Array).slice().buffer,
    };
  };
  return { impl, seen };
}

test("latest resolves through the releases API to the release's .ota asset", async () => {
  const pkg = otaPackage(1_009_000);
  const f = fakeFetch({
    "https://api.github.com/repos/fughilli/splanc/releases/latest": { tag_name: "firmware-v1.9.0" },
    [releasePackageUrl("1.9.0")]: pkg,
  });
  const r = await resolvePackage({ version: "latest" }, f.impl);
  assert.equal(r.version, 1_009_000);
  assert.equal(r.label, "firmware 1.9.0");
  assert.equal(releasePackageUrl("v1.9.0"), "https://github.com/fughilli/splanc/releases/download/firmware-v1.9.0/esp32c6-netstack-1.9.0.ota");
});

test("a release without an OTA package says so", async () => {
  const f = fakeFetch({});
  await assert.rejects(resolvePackage({ version: "1.8.2" }, f.impl), /no over-the-air package/);
  await assert.rejects(resolvePackage({ version: "banana" }, f.impl), /isn't a release version/);
});

test("a local package is read and checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ota-"));
  const p = join(dir, "x.ota");
  writeFileSync(p, otaPackage(42));
  assert.equal((await resolvePackage({ packagePath: p })).version, 42);
  writeFileSync(p, otaPackage(42).subarray(0, 120));
  await assert.rejects(resolvePackage({ packagePath: p }), /doesn't match/);
});

test("a Splanc MAX gets its board's release manifest and the MAX key epoch", async () => {
  const man = otaPackage(1_010_000, 0); // 108 bytes: a manifest alone
  const epoch = new Uint8Array(80).fill(7);
  const f = fakeFetch({
    "https://api.github.com/repos/fughilli/splanc/releases/latest": { tag_name: "firmware-v1.10.0" },
    [releaseMaxManifestUrl("pi3", "1.10.0")]: man,
    [releaseMaxEpochUrl("1.10.0")]: epoch,
  });
  const r = await resolvePackage({ version: "latest", board: "pi3" }, f.impl);
  assert.equal(r.version, 1_010_000);
  assert.equal(r.bytes.length, 108);
  assert.deepEqual(r.keyEpoch, epoch);
  assert.match(r.label, /Splanc MAX pi3/);
  assert.equal(
    releaseMaxManifestUrl("pi3", "v1.10.0"),
    "https://github.com/fughilli/splanc/releases/download/firmware-v1.10.0/max-pi3-1.10.0.manifest",
  );
  // The C6 key-epoch.bin is never sent to a MAX (its signers aren't in the MAX ring).
  assert.ok(!f.seen.some((u) => u.endsWith("/key-epoch.bin")));
  await assert.rejects(resolvePackage({ version: "1.9.0", board: "pi5" }, f.impl), /no Splanc MAX image for pi5/);
});

test("canary first: the rest update only if it came back healthy", async () => {
  const players = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const order: string[] = [];
  const good = await canaryRollout(players, async (p) => {
    order.push(p.name);
    return p.name;
  });
  assert.equal(good.canary, "a");
  assert.equal(order[0], "a");
  assert.deepEqual(good.results.map((r) => r.ok), [true, true, true]);

  const bad = await canaryRollout(players, async (p) => {
    if (p.name === "a") throw new Error("rolled back");
    return p.name;
  });
  assert.deepEqual(
    bad.results.map((r) => [r.player, r.ok, r.skipped ?? false]),
    [
      ["a", false, false],
      ["b", false, true],
      ["c", false, true],
    ],
  );
  const single = await canaryRollout([{ name: "solo" }], async () => 1);
  assert.equal(single.canary, null);
  assert.equal(single.results[0]!.ok, true);
});
