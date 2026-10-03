/**
 * Effect-runtime inputs to performance estimation (PR-17: "effect execution
 * features needed by the documented effect system, including embedded/runtime
 * type support and calibrated performance estimation inputs"), web side:
 *   - the `.fxb` reader the offline estimator uses (costModel.ts parseFxb /
 *     walkEntry) honours the full container layout and decodes the integer,
 *     fixed-point (FUG-10) and indexed array/struct opcodes with the fx_vm
 *     operand widths, so effects using those types are costed to the end;
 *   - loops and jumps are walked boundedly;
 *   - texture declarations are read from the buffer table (net/fxbTextures.ts);
 *   - a calibrated device profile reaches the estimator unchanged through
 *     export, import and the persisted store record.
 * Two untraced cases ride along (not PR-17 evidence: neither touches the
 * runtime or the estimator): the preview's topology classifier
 * (fx/effectTopology.ts) knows every graph intrinsic, and the synthetic
 * fixtures (effects/fixtures.ts) yield in-range per-LED preview topology inputs.
 * Operand layouts below follow firmware/fx_vm/src/lib.rs `enum Op` (the same
 * widths fx_compiler/src/opt.rs `op_len` encodes).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OPCODE_NAMES, estimateFrameTime, parseFxb, walkEntry } from "../src/effects/costModel";
import { parseFxbTextures } from "../src/net/fxbTextures";
import { isTopologyAware } from "../src/fx/effectTopology";
import { deriveLedTopology } from "../src/fx/preview";
import { generateFixture } from "../src/effects/fixtures";
import { extractTopology } from "../src/topology/extract";
import { buildDeviceProfile, parseDeviceBundle } from "../src/effects/deviceProfile";
import {
  parseProfile,
  profileToCostTable,
  profileToStored,
  serializeProfile,
} from "../src/effects/executionProfile";
import { exportTable, importTable, toCostTable } from "../src/store/costTableStore";
import bundleJson from "./testdata/device-bench-esp32c6.json";

const OP: Record<string, number> = Object.fromEntries(OPCODE_NAMES.map((n, i) => [n, i]));

/** Assemble a `.fxb` (fx_vm Program::parse layout) around `code`. */
function fxb(o: {
  code: number[];
  update?: number;
  shade?: number;
  manifest?: Uint8Array;
  consts?: number[];
}): Uint8Array {
  const manifest = o.manifest ?? new Uint8Array(0);
  const consts = o.consts ?? [];
  const h: number[] = [0x46, 0x58, 0x42, 0x31, 1, 0, 0, 0];
  const p16 = (v: number): void => void h.push(v & 0xff, (v >> 8) & 0xff);
  p16(manifest.length);
  p16(consts.length);
  p16(o.code.length);
  p16(o.update ?? 0xffff);
  p16(o.shade ?? 0);
  const cbytes: number[] = [];
  for (const c of consts) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, c, true);
    for (let i = 0; i < 4; i++) cbytes.push(dv.getUint8(i));
  }
  return new Uint8Array([...h, ...manifest, ...cbytes, ...o.code]);
}

/** The cost table fitted from the real-C6 golden bundle. */
function goldenTable(): ReturnType<typeof profileToCostTable> {
  return profileToCostTable(buildDeviceProfile(parseDeviceBundle(JSON.stringify(bundleJson))).profile);
}

function shadeHist(buf: Uint8Array): Record<string, number> {
  const p = parseFxb(buf);
  return walkEntry(p.code, p.shadeEntry).max;
}

test("the estimator reads code past the manifest and const pool, entries relative to the code [rr:PR-17]", () => {
  // update(): uniform → state.  shade(): state → sin → broadcast to rgb.
  const update = [OP["LoadUniform"]!, 0, 1, OP["StoreState"]!, 0, 1, OP["Ret"]!, 0];
  const shade = [
    OP["LoadState"]!, 0, 1,
    OP["UnMath"]!, 0, 1,
    OP["Swizzle"]!, 1, 3, 0, 0, 0,
    OP["Ret"]!, 3,
  ];
  const code = [...update, ...shade];
  // A real uniform manifest + const pool sit between the header and the code;
  // their bytes (e.g. 9 = Mul, 13 = UnMath) must never be decoded as opcodes.
  const manifest = new TextEncoder().encode(
    JSON.stringify([
      { name: "speed", slot: 0, width: 1, ui: { kind: "slider", min: 0, max: 9 }, default: [13] },
    ]),
  );
  const full = fxb({ code, update: 0, shade: update.length, manifest, consts: [9, 13.5] });
  const bare = fxb({ code, update: 0, shade: update.length });

  const p = parseFxb(full);
  assert.equal(p.code.length, code.length);
  assert.deepEqual(Array.from(p.code), code);
  assert.deepEqual(walkEntry(p.code, p.updateEntry).max, { LoadUniform: 1, StoreState: 1, Ret: 1 });
  assert.deepEqual(walkEntry(p.code, p.shadeEntry).max, {
    LoadState: 1,
    "UnMath:sin": 1,
    Swizzle: 1,
    Ret: 1,
  });

  // The manifest and constants carry no execution cost.
  const table = goldenTable();
  const a = estimateFrameTime({ bytecode: full, ledCount: 128, table });
  const b = estimateFrameTime({ bytecode: bare, ledCount: 128, table });
  assert.deepEqual(a, b);
});

test("the estimator rejects short, foreign and wrong-version containers like the VM [rr:PR-17]", () => {
  const ok = fxb({ code: [OP["Ret"]!, 3] });
  assert.doesNotThrow(() => parseFxb(ok));
  assert.throws(() => parseFxb(ok.subarray(0, 17)), /too short/);
  const magic = ok.slice();
  magic[3] = 0x32; // "FXB2"
  assert.throws(() => parseFxb(magic), /bad fxb magic/);
  const version = ok.slice();
  version[4] = 2;
  assert.throws(() => parseFxb(version), /bad fxb version/);
});

test("integer and fixed-point effects are costed op by op to the end of shade() [rr:PR-17]", () => {
  // Operand bytes deliberately equal real opcode values (14 = BinMath, 6 =
  // LoadCtx, …) so a wrong operand width would desync the walk.
  const code = [
    OP["LoadCtx"]!, 7,
    OP["FixFromF"]!, 14, // float → Q1.14
    OP["SinFix"]!, 14,
    OP["CosFix"]!, 14,
    OP["ExpFix"]!, 6,
    OP["MulFixN"]!, 14,
    OP["DivFixN"]!, 14,
    OP["FixRescale"]!, 0xf8, // i8 shift −8 (fixed16 → fixed8)
    OP["FixToF"]!, 6,
    OP["F2Fix"]!, OP["MulFix"]!, OP["DivFix"]!, OP["Fix2I"]!, OP["I2Fix"]!, OP["Fix2F"]!,
    OP["F2I"]!, OP["AddI"]!, OP["SubI"]!, OP["MulI"]!, OP["DivI"]!, OP["ModI"]!, OP["NegI"]!,
    OP["CmpI"]!, 2,
    OP["I2F"]!,
    OP["Swizzle"]!, 1, 3, 0, 0, 0,
    OP["Ret"]!, 3,
  ];
  const hist = shadeHist(fxb({ code }));
  const expected = [
    "LoadCtx", "FixFromF", "SinFix", "CosFix", "ExpFix", "MulFixN", "DivFixN", "FixRescale", "FixToF",
    "F2Fix", "MulFix", "DivFix", "Fix2I", "I2Fix", "Fix2F", "F2I", "AddI", "SubI", "MulI", "DivI",
    "ModI", "NegI", "CmpI", "I2F", "Swizzle", "Ret",
  ];
  assert.deepEqual(hist, Object.fromEntries(expected.map((op) => [op, 1])));
});

test("array and struct element access is costed at its lane width [rr:PR-17]", () => {
  // Idx ops: base, stride, off, n (lanes), count — n weights the cost.
  const code = [
    OP["PushConst"]!, 0, 0,
    OP["LoadStateIdx"]!, 13, 3, 0, 3, 4, // vec3 element of a 4-array (base 13 = UnMath byte)
    OP["PushConst"]!, 0, 0,
    OP["LoadLocalIdx"]!, 9, 2, 0, 2, 8, // vec2 field
    OP["StoreLocalIdx"]!, 9, 2, 0, 2, 8,
    OP["StoreStateIdx"]!, 13, 3, 0, 3, 4,
    OP["Swizzle"]!, 1, 3, 0, 0, 0,
    OP["Ret"]!, 3,
  ];
  assert.deepEqual(shadeHist(fxb({ code })), {
    PushConst: 2,
    LoadStateIdx: 3,
    LoadLocalIdx: 2,
    StoreLocalIdx: 2,
    StoreStateIdx: 3,
    Swizzle: 1,
    Ret: 1,
  });
});

test("a swizzle's component bytes are stepped over, never decoded as opcodes [rr:PR-17]", () => {
  // led.pos.zyxx — the index bytes 2, 1, 0 are also the LoadState, LoadUniform
  // and PushConst opcodes (each with 2 operand bytes) if mis-decoded.
  const code = [
    OP["LoadCtx"]!, 3,
    OP["Swizzle"]!, 3, 4, 2, 1, 0, 0,
    OP["Mul"]!, 4,
    OP["Swizzle"]!, 4, 3, 0, 1, 2,
    OP["Ret"]!, 3,
  ];
  assert.deepEqual(shadeHist(fxb({ code })), { LoadCtx: 1, Swizzle: 2, Mul: 4, Ret: 1 });
});

test("loops are walked boundedly and flagged; a forward jump skips dead code [rr:PR-17]", () => {
  // 0: Mul n=1 ; 2: Jmp −5 (back to 0) — an unbounded loop the walk must cap.
  const loop = fxb({ code: [OP["Mul"]!, 1, OP["Jmp"]!, 0xfb, 0xff, OP["Ret"]!, 3] });
  const p = parseFxb(loop);
  const w = walkEntry(p.code, p.shadeEntry);
  assert.equal(w.loopCapped, true);
  assert.ok(w.max["Mul"]! >= 1 && w.max["Mul"]! <= 64, `bounded trip count, got ${w.max["Mul"]}`);
  const est = estimateFrameTime({ bytecode: loop, ledCount: 16, table: goldenTable() });
  assert.equal(est.loopCapped, true, "the estimate says its count may be capped");
  assert.ok(Number.isFinite(est.totalMs));

  // 0: Jmp +2 over a dead Mul ; 5: Ret.
  const skip = shadeHist(fxb({ code: [OP["Jmp"]!, 2, 0, OP["Mul"]!, 1, OP["Ret"]!, 3] }));
  assert.deepEqual(skip, { Jmp: 1, Ret: 1 });
});

test("texture sizes come from the buffer table, including dimensions above 255 px [rr:PR-17]", () => {
  const withTable = (table: number[]): Uint8Array => {
    const b = fxb({ code: [OP["Ret"]!, 3] });
    const out = new Uint8Array([...b, ...table]);
    out[5] = 0x01; // flags: buffer table present
    return out;
  };
  // 640×480 RGBA texture (u16 little-endian dims) after a kind-0 LED buffer.
  const big = withTable([2, 0, 3, 0, 0, 0, 0, 0, 1, 4, 0, 0x80, 0x02, 0xe0, 0x01]);
  assert.deepEqual(parseFxbTextures(big), [{ index: 1, width: 640, height: 480, elem: 4 }]);
  // Declared but absent / cut short / no header at all: refuse, never guess.
  assert.throws(() => parseFxbTextures(withTable([])), /missing buffer table/);
  assert.throws(() => parseFxbTextures(withTable([2, 1, 4, 0, 0x80, 0x02, 0xe0, 0x01])), /truncated/);
  assert.throws(() => parseFxbTextures(big.subarray(0, 12)), /too short/);
});

test("every graph-query and geodesic intrinsic marks an effect topology-aware (preview render-path classifier)", () => {
  // The fx_vm GraphQuery kinds (seg_count … term) plus FloodFrom.
  for (const call of [
    "seg_count()",
    "seg_len(0)",
    "seg_node(0, 1)",
    "node_deg(0)",
    "node_seg(0, 0)",
    "node_side(0, 0)",
    "term_count()",
    "term(0)",
    "flood_from(0)",
  ]) {
    assert.equal(isTopologyAware(`void update() { float x = float(${call}); }`), true, call);
  }
  const spaced = "vec3 shade(Led led) { return vec3(led . dist); }";
  assert.equal(isTopologyAware(spaced), true, "spaced accessor");
  // A user helper that merely contains an intrinsic's name is not a graph query.
  const helper = "float my_seg_len(float x) { return x; } vec3 shade(Led led) { return led.pos; }";
  assert.equal(isTopologyAware(helper), false);
});

test("synthetic fixtures give every LED in-range preview topology inputs", async () => {
  const opts = { seed: 3, jitterFrac: 0.05 };
  // A star: five arms meeting at one junction.
  const star = generateFixture("star", { count: 60, ...opts });
  const t = deriveLedTopology(star, await extractTopology(star));
  assert.equal(t.seg.length, star.leds.length);
  for (let i = 0; i < star.leds.length; i++) {
    assert.ok(t.seg[i]! >= 0, `LED ${i} has no segment`);
    assert.ok(t.s[i]! >= 0 && t.s[i]! <= 1 && t.dist[i]! >= 0 && t.dist[i]! <= 1);
  }
  assert.ok(t.branch.some((b) => b === 1), "LEDs at the shared centre are flagged as a junction");
  assert.ok(t.branch.some((b) => b === 0), "arm LEDs away from the centre are not");
  assert.equal(Math.max(...t.dist), 1, "the geodesic field spans the whole structure");

  // A strip at the ~5 cm pitch of real strips: no junctions, one segment, and a
  // geodesic coordinate that sweeps monotonically end to end.
  const strip = generateFixture("strip", { count: 30, seed: 3, jitterFrac: 0 });
  const [a, b] = [strip.leds[0]!.xyz, strip.leds[1]!.xyz];
  assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) - 0.05) < 1e-9);
  const st = deriveLedTopology(strip, await extractTopology(strip));
  assert.ok(st.branch.every((x) => x === 0));
  assert.ok(st.seg.every((x) => x === 0));
  const d = Array.from(st.dist);
  const rising = d.every((v, i) => i === 0 || v >= d[i - 1]! - 1e-6);
  const falling = d.every((v, i) => i === 0 || v <= d[i - 1]! + 1e-6);
  assert.ok(rising || falling, "led.dist runs monotonically along the strip");
  assert.ok(Math.min(...d) < 0.05 && Math.max(...d) === 1);
});

test("a calibrated device profile reaches the estimator unchanged through export, import and storage [rr:PR-17]", () => {
  const bundle = { ...parseDeviceBundle(JSON.stringify(bundleJson)), deviceKey: "AA:BB:CC:DD:EE:01" };
  const { profile, table } = buildDeviceProfile(bundle);

  // Profile file round trip (what the HITL harness emits / the app imports).
  const viaProfile = profileToCostTable(parseProfile(serializeProfile(profile)));
  // Store record round trip (what the profile manager saves and resolveTable loads).
  const stored = importTable(exportTable(profileToStored(profile, 1)));
  assert.equal(stored.id, "esp32c6@160000000#1@AA:BB:CC:DD:EE:01", "keyed to this device");
  assert.equal(stored.origin, "calibrated");
  assert.equal(stored.measuredError, profile.measuredError);
  const viaStore = toCostTable(stored);

  for (const h of bundle.heldout) {
    const want = estimateFrameTime({ bytecode: h.fxb, ledCount: h.ledCount, table });
    const est = (t: typeof table): ReturnType<typeof estimateFrameTime> =>
      estimateFrameTime({ bytecode: h.fxb, ledCount: h.ledCount, table: t });
    assert.deepEqual(est(viaProfile), want, `${h.label} via the profile file`);
    assert.deepEqual(est(viaStore), want, `${h.label} via the store record`);
  }
});
