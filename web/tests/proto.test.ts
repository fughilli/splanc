/**
 * Protobuf wire boundary (net/proto.ts) vs the Python-generated golden:
 * both ends must decode the SAME byte frames to the SAME flat §7 objects,
 * and TS-encoded frames must decode back identically (Python re-decode is
 * covered by regenerating the golden — //pi/server:gen_proto_golden).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeClient, decodeServer, encodeClient, encodeServer } from "../src/net/proto";
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
