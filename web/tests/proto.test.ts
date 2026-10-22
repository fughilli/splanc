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
  flatFpsState,
  flatRampState,
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

test("set_brightness round-trips + welcome carries the brightness echo", () => {
  // The performance-measurement driver sends this to blank the strip (0) and
  // restore the user setpoint; the master-dimmer UI sends fractional values.
  for (const brightness of [0, 0.42, 1]) {
    const req = { type: "set_brightness", brightness };
    // set_brightness isn't in the flat schema-generated union (the client casts
    // the same way it does for set_color_correction), so cast at the boundary.
    assert.deepEqual(decodeClient(encodeClient(req as never)), req);
  }
  // Welcome echoes the applied brightness (optional double), so the app can
  // hydrate its dimmer on connect.
  const w = { type: "welcome", sessionId: "s", brightness: 0.5 };
  const back = decodeServer(encodeServer(w as never)) as { brightness?: number };
  assert.equal(back.brightness, 0.5);
});

test("set_crossfade round-trips + welcome carries the crossfade echo (FUG-110)", () => {
  for (const [position, mode] of [
    [0, 0],
    [0.5, 1],
    [1, 0],
  ]) {
    const req = { type: "set_crossfade", position, mode };
    // set_crossfade isn't in the flat schema union (client casts, like
    // set_brightness), so cast at the boundary.
    assert.deepEqual(decodeClient(encodeClient(req as never)), req);
  }
  // Welcome echoes the applied crossfade (optional double) + mode (uint32).
  const w = { type: "welcome", sessionId: "s", crossfade: 0.75, crossfadeMode: 1 };
  const back = decodeServer(encodeServer(w as never)) as {
    crossfade?: number;
    crossfadeMode?: number;
  };
  assert.equal(back.crossfade, 0.75);
  assert.equal(back.crossfadeMode, 1);
});

test("effect arms carry the deck selector (FUG-110)", () => {
  // submit_effect onto deck B, with its .fxb bytes round-tripping as base64.
  const fxb = Uint8Array.from([1, 2, 3, 250, 0]);
  const submit = { type: "submit_effect", effectId: "e1", fxb, activate: true, deck: 1 };
  const backSubmit = decodeClient(encodeClient(submit as never)) as {
    deck?: number;
    fxb?: Uint8Array;
    effectId?: string;
  };
  assert.equal(backSubmit.deck, 1);
  assert.equal(backSubmit.effectId, "e1");
  assert.deepEqual(Array.from(backSubmit.fxb ?? []), Array.from(fxb));

  // set_effect / set_uniforms / get_effect_uniforms all take a deck too.
  assert.deepEqual(decodeClient(encodeClient({ type: "set_effect", effectId: "e2", deck: 1 } as never)), {
    type: "set_effect",
    effectId: "e2",
    deck: 1,
  });
  const su = {
    type: "set_uniforms",
    values: [{ slot: 0, value: [0.5] }],
    deck: 1,
  };
  assert.deepEqual(decodeClient(encodeClient(su as never)), su);
});

test("set_fps / fps_state round-trip (FUG-82 autoscaler arms)", () => {
  type CMsg = Parameters<typeof encodeClient>[0];
  type SMsg = Parameters<typeof encodeServer>[0];
  // Pin a rate, hold (no abort), and back to autoscale (proto3 zeroes/false are
  // implicit on the wire; flatFpsState fills them back in on the server side).
  const pin = { type: "set_fps", targetFps: 60, noAbort: true } as const;
  assert.deepEqual(decodeClient(encodeClient(pin as unknown as CMsg)), pin);
  const auto = decodeClient(encodeClient({ type: "set_fps", targetFps: 0 } as unknown as CMsg)) as unknown as {
    type: string;
    targetFps?: number;
  };
  assert.equal(auto.type, "set_fps");
  assert.equal(auto.targetFps ?? 0, 0);

  const aborted = {
    type: "fps_state",
    targetFps: 70,
    currentFps: 70,
    minFps: 25,
    maxFps: 80,
    auto: false,
    aborted: true,
    noAbort: false,
  } as const;
  const back = flatFpsState(decodeServer(encodeServer(aborted as unknown as SMsg)) as never);
  assert.deepEqual(back, aborted);
  // An autoscaling state drops target_fps/aborted/no_abort on the wire.
  const live = flatFpsState(
    decodeServer(
      encodeServer({ type: "fps_state", currentFps: 45, minFps: 25, maxFps: 80, auto: true } as unknown as SMsg),
    ) as never,
  );
  assert.deepEqual(live, { ...aborted, targetFps: 0, currentFps: 45, auto: true, aborted: false });
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

test("canned ramp arms round-trip (the ramps feature)", () => {
  const ru = {
    type: "ramp_uniforms",
    deck: 1,
    targets: [{ slot: 3, value: [0.5] }],
    durationMs: 2000,
    ease: 1,
    startAtMs: 123456789,
    id: 7,
    commit: false,
  };
  const back = decodeClient(encodeClient(ru as never)) as unknown as Record<string, unknown>;
  assert.deepEqual({ ...back, startAtMs: Number(back["startAtMs"]) }, ru);
  const rx = { type: "ramp_crossfade", position: 1, mode: 1, durationMs: 500, ease: 4, startAtMs: 0, id: 9 };
  const bx = decodeClient(encodeClient(rx as never)) as unknown as Record<string, unknown>;
  assert.equal(bx["position"], 1);
  assert.equal(bx["ease"], 4);
  assert.equal(bx["id"], 9);
  const bc = decodeClient(encodeClient({ type: "cancel_ramp", id: 3 } as never)) as unknown as Record<string, unknown>;
  assert.equal(bc["id"], 3);
  // blend_keypoints' canned-profile fields.
  const bk = decodeClient(
    encodeClient({ type: "blend_keypoints", deck: 0, weights: [{ name: "a", weight: 1 }], seconds: 2, ease: 2, id: 5 } as never),
  ) as unknown as Record<string, unknown>;
  assert.equal(bk["ease"], 2);
  assert.equal(bk["id"], 5);
  // ramp_state from the device: int64 schedule fields normalize to numbers.
  const st = decodeServer(
    encodeServer({ type: "ramp_state", id: 7, state: 1, kind: 2, startAtMs: 5000, endAtMs: 7000, active: 3 } as never),
  );
  const flat = flatRampState(st as never);
  assert.deepEqual(flat, { type: "ramp_state", id: 7, state: 1, kind: 2, startAtMs: 5000, endAtMs: 7000, active: 3 });
  assert.equal(flatRampState({}).state, 0, "STARTED is the proto3 default");
});
