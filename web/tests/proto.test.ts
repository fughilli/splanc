/**
 * Protobuf wire boundary (net/proto.ts) vs the Python-generated golden:
 * both ends must decode the SAME byte frames to the SAME flat §7 objects,
 * and TS-encoded frames must decode back identically (Python re-decode is
 * covered by regenerating the golden — //pi/server:gen_proto_golden).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeClient,
  decodeMappingBundle,
  decodeServer,
  encodeClient,
  encodeMappingBundle,
  encodeServer,
} from "../src/net/proto";
import type { OutputMap, Topology } from "@ledmapper/protocol";
import golden from "./golden_proto_frames.json";

interface GoldenFrame {
  direction: "client" | "server";
  frameB64: string;
  decoded: Record<string, unknown>;
}

const frames = (golden as { frames: GoldenFrame[] }).frames;

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/** TS decode fills explicit nulls for `T | null` fields; Python leaves the
 * keys absent (pydantic defaults them). Strip nulls for comparison. */
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== null) out[k] = stripNulls(x);
    }
    return out;
  }
  return v;
}

test("golden frames decode to the same flat objects Python decoded", () => {
  assert.ok(frames.length >= 20, `${frames.length} golden frames`);
  for (const f of frames) {
    const bytes = b64ToBytes(f.frameB64);
    const flat = f.direction === "client" ? decodeClient(bytes) : decodeServer(bytes);
    assert.deepEqual(
      stripNulls(flat),
      stripNulls(f.decoded),
      `${f.direction}:${(f.decoded as { type?: string }).type}`,
    );
  }
});

test("MappingBundle round-trips map + topology (incl. trajectory/polyline)", () => {
  const map: OutputMap = {
    mapId: "m-42",
    createdAt: "2026-07-18T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: 3,
    leds: [
      { id: 0, xyz: [0, 0, 0], confidence: 1, nViews: 3, rmsReprojPx: 0.4, parallaxDeg: 20 },
      { id: 1, xyz: [1, 0, 0], confidence: 1, nViews: 3, rmsReprojPx: 0.4, parallaxDeg: 20 },
      { id: 2, xyz: [2, 0.5, 0], confidence: 1, nViews: 3, rmsReprojPx: 0.4, parallaxDeg: 20 },
    ],
    unmapped: [],
    trajectory: [
      [0, 0, 1],
      [0.1, 0, 1],
    ],
    stats: { rmsReprojPxGlobal: 0.4, medianParallaxDeg: 20 },
  };
  const topology: Topology = {
    mapId: "m-42",
    branchPoints: [{ id: 0, xyz: [1, 0, 0] }],
    segments: [
      {
        id: 0,
        a: -1,
        b: 0,
        polyline: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        length: 1,
      },
      {
        id: 1,
        a: 0,
        b: -1,
        polyline: [
          [1, 0, 0],
          [2, 0.5, 0],
        ],
        length: 1.118,
      },
    ],
    associations: [
      { ledId: 0, segmentId: 0, footArclength: 0, dPerp: 0 },
      { ledId: 1, segmentId: 0, footArclength: 1, dPerp: 0 },
      { ledId: 2, segmentId: 1, footArclength: 1.118, dPerp: 0 },
    ],
  };
  const again = decodeMappingBundle(encodeMappingBundle({ map, topology }));
  assert.deepEqual(stripNulls(again.map), stripNulls(map));
  assert.deepEqual(stripNulls(again.topology), stripNulls(topology));
});

test("get_stored_map / stored_map_chunk round-trip (incl. bytes as base64)", () => {
  const req = { type: "get_stored_map", offset: 40, maxLen: 1024 } as const;
  assert.deepEqual(decodeClient(encodeClient(req)), req);

  // stored_map_chunk carries a `bytes` field, base64 over the JSON boundary.
  const data = btoa(String.fromCharCode(1, 2, 3, 250, 0, 128));
  const chunk = {
    type: "stored_map_chunk",
    totalLen: 128,
    offset: 40,
    data,
    hasTopology: true,
  } as const;
  const back = decodeServer(encodeServer(chunk)) as typeof chunk;
  assert.equal(back.totalLen, 128);
  assert.equal(back.offset, 40);
  assert.equal(back.data, data);
  assert.equal(back.hasTopology, true);
});

test("TS re-encode of every golden decodes back to the same object", () => {
  for (const f of frames) {
    if (f.direction === "client") {
      const flat = decodeClient(b64ToBytes(f.frameB64));
      const again = decodeClient(encodeClient(flat));
      assert.deepEqual(stripNulls(again), stripNulls(flat));
    } else {
      const flat = decodeServer(b64ToBytes(f.frameB64));
      const again = decodeServer(encodeServer(flat));
      assert.deepEqual(stripNulls(again), stripNulls(flat));
    }
  }
});
