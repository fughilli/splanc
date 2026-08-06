/**
 * Map-library bundle (FUG-77): the pure container codec and the import
 * conflict-resolution planner. IndexedDB is out of scope here — mapStore is a
 * thin wrapper over these functions (see store/mapBundle.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeLibraryBundle,
  encodeLibraryBundle,
  looksLikeLibraryBundle,
  planImport,
  type ExistingRef,
  type LibraryBundleEntry,
} from "../src/store/mapBundle";

function entry(name: string, over: Partial<LibraryBundleEntry> = {}): LibraryBundleEntry {
  return { name, description: "", tags: [], bundle: "AAAA", ...over };
}

test("library bundle round-trips entries incl. metadata", () => {
  const entries: LibraryBundleEntry[] = [
    entry("Ceiling", { description: "top strip", tags: ["ceiling"], folder: "Living", bundle: "Zm9v" }),
    entry("Wall", { deviceMapId: "dev-7", bundle: "YmFy" }),
  ];
  const back = decodeLibraryBundle(encodeLibraryBundle(entries));
  assert.deepEqual(back, entries);
});

test("decodeLibraryBundle drops empty folder/deviceMapId and coerces missing fields", () => {
  const bytes = encodeLibraryBundle([
    { name: "A", description: "", tags: [], folder: "   ", deviceMapId: "", bundle: "AA" },
  ]);
  const [e] = decodeLibraryBundle(bytes);
  assert.equal(e!.folder, undefined);
  assert.equal(e!.deviceMapId, undefined);
});

test("decodeLibraryBundle rejects non-bundles and bad versions", () => {
  assert.throws(() => decodeLibraryBundle(new Uint8Array([0x0a, 0x02, 0x08, 0x01])), /not a map library/);
  assert.throws(() => decodeLibraryBundle(new TextEncoder().encode("{not json")), /invalid JSON/);
  const wrongVer = new TextEncoder().encode(
    JSON.stringify({ format: "ledmapper.map-library", version: 99, maps: [] }),
  );
  assert.throws(() => decodeLibraryBundle(wrongVer), /unsupported bundle version/);
});

test("decodeLibraryBundle rejects an entry with no payload", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ format: "ledmapper.map-library", version: 1, maps: [{ name: "X" }] }),
  );
  assert.throws(() => decodeLibraryBundle(bytes), /no map payload/);
});

test("looksLikeLibraryBundle distinguishes JSON bundle from binpb", () => {
  assert.equal(looksLikeLibraryBundle(encodeLibraryBundle([])), true);
  // A MappingBundle binpb starts with a protobuf field tag (0x0a), not "{".
  assert.equal(looksLikeLibraryBundle(new Uint8Array([0x0a, 0x02, 0x08, 0x01])), false);
  assert.equal(looksLikeLibraryBundle(new Uint8Array([0x20, 0x09, 0x7b])), true); // leading ws
  assert.equal(looksLikeLibraryBundle(new Uint8Array([])), false);
});

const existing: ExistingRef[] = [
  { id: "id-ceiling", name: "Ceiling", folder: "" },
  { id: "id-wall", name: "Wall", folder: "Room A" },
];

test("planImport overwrite: matches (folder,name) in place, else adds", () => {
  const incoming = [entry("Ceiling"), entry("Wall", { folder: "Room A" }), entry("New")];
  const plan = planImport(existing, incoming, { mode: "overwrite" });
  assert.equal(plan[0]!.overwriteId, "id-ceiling");
  assert.equal(plan[1]!.overwriteId, "id-wall");
  assert.equal(plan[2]!.overwriteId, undefined);
  assert.equal(plan[2]!.name, "New");
});

test("planImport overwrite is case-insensitive on name, exact on folder", () => {
  const plan = planImport(existing, [entry("ceiling"), entry("Wall")], { mode: "overwrite" });
  assert.equal(plan[0]!.overwriteId, "id-ceiling"); // name case-insensitive
  assert.equal(plan[1]!.overwriteId, undefined); // "Wall" lives in "Room A", not ""
});

test("planImport rename: never overwrites, de-dupes within the target folder", () => {
  const incoming = [entry("Ceiling"), entry("Ceiling"), entry("Wall", { folder: "Room A" })];
  const plan = planImport(existing, incoming, { mode: "rename" });
  assert.equal(plan[0]!.overwriteId, undefined);
  assert.equal(plan[0]!.name, "Ceiling (2)"); // collides with existing ungrouped Ceiling
  assert.equal(plan[1]!.name, "Ceiling (3)"); // collides with the one just planned
  assert.equal(plan[2]!.name, "Wall (2)"); // collides with existing Wall in Room A
});

test("planImport folder: everything lands in one folder, original names, deduped there", () => {
  const incoming = [
    entry("Ceiling"),
    entry("Ceiling", { folder: "somewhere else" }),
    entry("Wall", { folder: "Room A" }),
  ];
  const plan = planImport(existing, incoming, { mode: "folder", folder: "Imported" });
  assert.deepEqual(
    plan.map((p) => ({ name: p.name, folder: p.folder, over: p.overwriteId })),
    [
      { name: "Ceiling", folder: "Imported", over: undefined },
      { name: "Ceiling (2)", folder: "Imported", over: undefined },
      { name: "Wall", folder: "Imported", over: undefined },
    ],
  );
});
