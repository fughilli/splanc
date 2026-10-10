import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMesh, transformMeshVertex, validateMesh } from "../src/geom/mesh";
import { decodeLibraryBundle, encodeLibraryBundle } from "../src/store/mapBundle";
import { SHOWCASE_SAMPLES } from "../src/store/showcaseData";
import { deriveLedTopology } from "../src/fx/preview";

const obj = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4/1 -3/2 -2/3 -1/4";
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
test("OBJ triangulates polygons, supports relative indices and ignores materials", () => {
  const mesh = parseMesh(bytes("mtllib ignored.mtl\n" + obj), "scan.obj");
  assert.deepEqual(mesh.triangles, [[0, 1, 2], [0, 2, 3]]);
  assert.equal(mesh.vertices.length, 4);
  assert.throws(() => parseMesh(bytes(obj + "\nf 1 2 99"), "bad.obj"), /missing vertex/);
  assert.throws(() => parseMesh(bytes("v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"), "bad.obj"), /Invalid mesh/);
});
test("ASCII and binary STL load equivalent triangles even with a solid binary header", () => {
  const ascii = parseMesh(bytes("solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test"), "scan.stl");
  const binary = new Uint8Array(134); binary.set(bytes("solid binary"));
  const view = new DataView(binary.buffer); view.setUint32(80, 1, true);
  view.setFloat32(108, 1, true); view.setFloat32(124, 1, true);
  assert.deepEqual(parseMesh(binary, "scan.stl").vertices, ascii.vertices);
  assert.throws(() => parseMesh(bytes("solid empty"), "empty.stl"), /Invalid mesh/);
});
test("alignment scales, rotates, then translates without changing model geometry", () => {
  const mesh = parseMesh(bytes(obj), "scan.obj");
  mesh.scale = 2; mesh.rotation = [0, 0, 90]; mesh.translation = [3, 4, 5];
  const result = transformMeshVertex(mesh, [1, 0, 0]);
  assert.ok(Math.abs(result[0] - 3) < 1e-10); assert.equal(result[1], 6); assert.equal(result[2], 5);
  assert.deepEqual(mesh.vertices[1], [1, 0, 0]);
});
test("library bundles preserve mesh alignment and visibility; invalid geometry fails import", () => {
  const mesh = parseMesh(bytes(obj), "scan.obj"); mesh.translation = [2, 3, 4]; mesh.visible = false;
  const entry = { name: "Scan", description: "", tags: [], bundle: "AAAA", mesh };
  assert.deepEqual(decodeLibraryBundle(encodeLibraryBundle([entry]))[0], entry);
  assert.throws(() => validateMesh({ ...mesh, triangles: [[0, 1, 999]] }), /Invalid mesh/);
});
test("showcase samples have valid geometry and prebaked per-LED associations; volume stays topology-free", () => {
  assert.equal(SHOWCASE_SAMPLES.length, 3);
  for (const sample of SHOWCASE_SAMPLES) {
    validateMesh(sample.mesh);
    assert.equal(sample.map.ledCount, sample.map.leds.length);
    const topo = sample.topology;
    assert.equal(topo.mapId, sample.map.mapId);
    if (sample.map.mapId.includes("primitive")) {
      assert.equal(sample.map.ledCount, 8000);
      assert.equal(topo.segments.length, 0);
      assert.ok(deriveLedTopology(sample.map, topo).seg.every(s => s === -1));
    } else {
      assert.ok(topo.branchPoints.length > 10);
      assert.equal(topo.associations.length, sample.map.ledCount);
      const segments = new Map(topo.segments.map(s => [s.id, s]));
      const nodes = new Set(topo.branchPoints.map(p => p.id));
      for (const s of topo.segments) {
        assert.ok(s.a === -1 || nodes.has(s.a)); assert.ok(s.b === -1 || nodes.has(s.b));
        assert.ok(s.length > 0);
      }
      for (const a of topo.associations) {
        const s = segments.get(a.segmentId)!; assert.ok(s);
        assert.ok(a.footArclength >= 0 && a.footArclength <= s.length + 1e-8);
      }
    }
  }
});
