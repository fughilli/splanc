/** In-browser flashbundle tar reader (release firmware source). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { untar } from "../src/flash/tar";

const enc = new TextEncoder();

/** Build a minimal ustar archive (regular files, correct header checksum). */
function makeTar(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    const h = new Uint8Array(512);
    h.set(enc.encode(f.name), 0);
    h.set(enc.encode(f.data.length.toString(8).padStart(11, "0") + "\0"), 124); // size (octal)
    h[156] = 0x30; // typeflag '0' = regular file
    h.set(enc.encode("ustar\0"), 257);
    // Checksum: treat the field as spaces, sum every byte, write back as octal.
    for (let i = 148; i < 156; i++) h[i] = 0x20;
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(h);
    const data = new Uint8Array(Math.ceil(f.data.length / 512) * 512);
    data.set(f.data, 0);
    blocks.push(data);
  }
  blocks.push(new Uint8Array(512), new Uint8Array(512)); // two trailing zero blocks
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

test("untar round-trips a multi-file flashbundle", () => {
  const flashJson = enc.encode('{"chip":"esp32c6","images":[{"offset":"0x0","file":"boot.bin"}]}');
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
  const members = untar(makeTar([
    { name: "flash.json", data: flashJson },
    { name: "boot.bin", data: bin },
  ]));
  assert.deepEqual(members.get("flash.json"), flashJson);
  assert.deepEqual(members.get("boot.bin"), bin);
  assert.equal(members.size, 2);
});

test("untar handles a file whose size is not a multiple of 512", () => {
  const data = enc.encode("x".repeat(1000)); // spans two data blocks, partial second
  const members = untar(makeTar([{ name: "a", data }]));
  assert.equal(members.get("a")!.length, 1000);
  assert.deepEqual(members.get("a"), data);
});

test("untar stores files under their basename", () => {
  const data = enc.encode("hi");
  const members = untar(makeTar([{ name: "some/dir/esp32c6.bin", data }]));
  assert.deepEqual(members.get("esp32c6.bin"), data);
});

test("untar throws on a truncated member rather than returning partial bytes", () => {
  const full = makeTar([{ name: "big", data: new Uint8Array(600) }]);
  assert.throws(() => untar(full.subarray(0, 512 + 300))); // header claims 600B, only 300 present
});

test("untar returns empty for an all-zero (empty) archive", () => {
  assert.equal(untar(new Uint8Array(1024)).size, 0);
});
