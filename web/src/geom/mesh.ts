import type { Vec3 } from "@ledmapper/protocol";

/** Web-local digital twin. Geometry stays in its original coordinate frame;
 * alignment is independent of the scanned LEDs and their topology. */
export interface MeshOverlay {
  name: string;
  vertices: Vec3[];
  triangles: [number, number, number][];
  translation: Vec3;
  rotation: Vec3; // XYZ Euler degrees
  scale: number;
  visible: boolean;
}

export const MAX_MESH_TRIANGLES = 30000;
const MAX_VERTICES = 90000;

export function validateMesh(raw: unknown): MeshOverlay {
  const m = raw as MeshOverlay;
  const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!m || typeof m.name !== "string" || typeof m.visible !== "boolean" ||
      !vec(m.translation) || !vec(m.rotation) || !Number.isFinite(m.scale) || m.scale <= 0 ||
      !Array.isArray(m.vertices) || !m.vertices.length || m.vertices.length > MAX_VERTICES ||
      !m.vertices.every(vec) || !Array.isArray(m.triangles) || !m.triangles.length ||
      m.triangles.length > MAX_MESH_TRIANGLES || !m.triangles.every(t =>
        Array.isArray(t) && t.length === 3 && t.every(i => Number.isInteger(i) && i >= 0 && i < m.vertices.length))) {
    throw new Error(`Invalid mesh; use finite geometry with at most ${MAX_MESH_TRIANGLES.toLocaleString()} triangles`);
  }
  return m;
}

export function transformMeshVertex(m: MeshOverlay, p: Vec3): Vec3 {
  let [x, y, z] = p.map(v => v * m.scale) as Vec3;
  const [rx, ry, rz] = m.rotation.map(v => v * Math.PI / 180) as Vec3;
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x + m.translation[0], y + m.translation[1], z + m.translation[2]];
}

/** Geometry only: materials, textures and vertex colors are deliberately ignored.
 * STL can be ASCII or binary; OBJ supports polygon faces and relative indices. */
export function parseMesh(bytes: Uint8Array, name: string): MeshOverlay {
  if (bytes.length > 20 * 1024 * 1024) throw new Error("Mesh file exceeds 20 MB; simplify it before importing");
  const vertices: Vec3[] = [];
  const triangles: [number, number, number][] = [];
  const addTriangle = (a: number, b: number, c: number): void => {
    triangles.push([a, b, c]);
    if (triangles.length > MAX_MESH_TRIANGLES) throw new Error("Mesh exceeds 30,000 triangles; simplify it before importing");
  };
  if (/\.obj$/i.test(name)) {
    for (const line of new TextDecoder().decode(bytes).split(/\r?\n/)) {
      const [op, ...args] = line.split("#")[0]!.trim().split(/\s+/);
      if (op === "v") {
        if (args.length < 3) throw new Error("Invalid OBJ vertex");
        vertices.push(args.slice(0, 3).map(Number) as Vec3);
        if (vertices.length > MAX_VERTICES) throw new Error("Mesh has too many vertices; simplify it before importing");
      } else if (op === "f") {
        const face = args.map(s => {
          const i = Number(s.split("/")[0]);
          if (!Number.isInteger(i) || i === 0) throw new Error("Invalid OBJ face index");
          const index = i < 0 ? vertices.length + i : i - 1;
          if (index < 0 || index >= vertices.length) throw new Error("OBJ face references a missing vertex");
          return index;
        });
        if (face.length < 3) throw new Error("Invalid OBJ face");
        for (let i = 1; i + 1 < face.length; i++) addTriangle(face[0]!, face[i]!, face[i + 1]!);
      }
    }
  } else if (/\.stl$/i.test(name)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = bytes.length >= 84 ? view.getUint32(80, true) : 0;
    if (bytes.length >= 84 && 84 + count * 50 === bytes.length) {
      if (count > MAX_MESH_TRIANGLES) throw new Error("Mesh exceeds 30,000 triangles; simplify it before importing");
      for (let i = 0; i < count; i++) {
        const base = vertices.length;
        for (let j = 0; j < 3; j++) {
          const o = 84 + i * 50 + 12 + j * 12;
          vertices.push([view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)]);
        }
        addTriangle(base, base + 1, base + 2);
      }
    } else {
      for (const match of new TextDecoder().decode(bytes).matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
        vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
        if (vertices.length % 3 === 0) addTriangle(vertices.length - 3, vertices.length - 2, vertices.length - 1);
      }
      if (vertices.length % 3 !== 0) throw new Error("Incomplete STL triangle");
    }
  } else throw new Error("Choose an OBJ or STL mesh");
  return validateMesh({ name, vertices, triangles, translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true });
}
