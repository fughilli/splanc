/**
 * Cost-model opcode-walk + estimate tests (docs/design/perf-monitoring.md).
 * Builds `.fxb` byte buffers by hand (mirroring the fx_vm header layout) so the
 * abstract interpreter is exercised without the compiler wasm.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateFrameTime,
  parseFxb,
  walkEntry,
  confidenceOf,
  histCycles,
  costFor,
  mathFeature,
  OPCODE_NAMES,
  type CostTable,
} from "../src/effects/costModel";
import { defaultCostTable } from "../src/store/costTableStore";

const CODE: Record<string, number> = Object.fromEntries(
  OPCODE_NAMES.map((n, i) => [n, i]),
);

/** Assemble a minimal `.fxb` with the given code bytes + entry offsets. */
function fxb(code: number[], updateEntry: number, shadeEntry: number): Uint8Array {
  const header = new Uint8Array(18);
  header[0] = 0x46; // F
  header[1] = 0x58; // X
  header[2] = 0x42; // B
  header[3] = 0x31; // 1
  header[4] = 1; // version
  // n_state, n_uniform at 6,7 = 0
  // manifest_len(8,9)=0, n_consts(10,11)=0
  const codeLen = code.length;
  header[12] = codeLen & 0xff;
  header[13] = (codeLen >> 8) & 0xff;
  header[14] = updateEntry & 0xff;
  header[15] = (updateEntry >> 8) & 0xff;
  header[16] = shadeEntry & 0xff;
  header[17] = (shadeEntry >> 8) & 0xff;
  const out = new Uint8Array(18 + codeLen);
  out.set(header, 0);
  out.set(code, 18);
  return out;
}

test("parseFxb slices code + entries", () => {
  const code = [CODE["PushConst"]!, 0, 0, CODE["Ret"]!, 3];
  const buf = fxb(code, 0xffff, 0);
  const p = parseFxb(buf);
  assert.equal(p.updateEntry, 0xffff);
  assert.equal(p.shadeEntry, 0);
  assert.equal(p.code.length, code.length);
});

test("walkEntry counts a straight-line shade with vector lane weights", () => {
  // shade: LoadCtx(led.pos=3) ; Mul n=3 ; Ret n=3
  // Mul lane weight = 3 (the size operand).
  const code = [
    CODE["LoadCtx"]!, 3, // C_LED_POS
    CODE["LoadCtx"]!, 3,
    CODE["Mul"]!, 3,
    CODE["Ret"]!, 3,
  ];
  const buf = fxb(code, 0xffff, 0);
  const p = parseFxb(buf);
  const w = walkEntry(p.code, p.shadeEntry);
  assert.equal(w.branched, false);
  assert.equal(w.max["Mul"], 3, "Mul weighted by 3 lanes");
  assert.equal(w.max["LoadCtx"], 2);
  assert.equal(w.max["Ret"], 1);
  // min == max for straight-line code
  assert.deepEqual(w.min, w.max);
});

test("walkEntry produces a min/max band across a forward BrFalse", () => {
  // BrFalse skips over an expensive UnMath(sin). Layout:
  //   0: BrFalse rel=+4  (operand i16 at 1..2, next=3, target=3+4=7)
  //   3: UnMath fn=0 n=1  (the "true" arm)
  //   5: <padding not reached> actually next after UnMath = 7
  //   7: Ret n=3
  const code = [
    CODE["BrFalse"]!, 4, 0, // rel = +4 -> target 7
    CODE["UnMath"]!, 0, 1, // sin (only when branch not taken)
    CODE["Ret"]!, 3,
  ];
  const buf = fxb(code, 0xffff, 0);
  const p = parseFxb(buf);
  const w = walkEntry(p.code, p.shadeEntry);
  assert.equal(w.branched, true);
  // max arm runs UnMath(sin); min arm skips it. The histogram is sub-keyed by
  // the fn-id operand byte (fn=0 -> sin), not the bare opcode name.
  assert.equal(w.max["UnMath:sin"] ?? 0, 1);
  assert.equal(w.min["UnMath:sin"] ?? 0, 0);
});

test("histCycles sums count*cost with a fallback", () => {
  const c = histCycles({ Mul: 3, Add: 2 }, { Mul: 10 }, 5);
  assert.equal(c, 3 * 10 + 2 * 5);
});

test("walkEntry sub-keys UnMath/BinMath by fn id", () => {
  // shade: UnMath fn=6 (sqrt) n=1 ; BinMath fn=2 (pow) n=1 ; Ret
  const code = [
    CODE["UnMath"]!, 6, 1,
    CODE["BinMath"]!, 2, 1,
    CODE["Ret"]!, 3,
  ];
  const w = walkEntry(parseFxb(fxb(code, 0xffff, 0)).code, 0);
  assert.equal(w.max["UnMath:sqrt"], 1);
  assert.equal(w.max["BinMath:pow"], 1);
  // the bare family names are NOT used as histogram keys.
  assert.equal(w.max["UnMath"], undefined);
  assert.equal(w.max["BinMath"], undefined);
});

test("walkEntry prices the R8 fused ops as the plain ops they replace", () => {
  // shade: BinPair mul(local 0, c1) ; BinTop addi(state 2) ; PushConsts c0 c1 c2 ;
  //        LoadCtxLanes led.uv src=2 [0..+1] ; MulAdd 1 ; Ret 3
  const code = [
    CODE["BinPair"]!, 0x02 | (1 << 2), 0, 0, 1, 0,
    CODE["BinTop"]!, 0x40 | (2 << 2), 2, 0,
    CODE["PushConsts"]!, 3, 0, 0, 1, 0, 2, 0,
    CODE["LoadCtxLanes"]!, 13, 2, 0, 1,
    CODE["MulAdd"]!, 1,
    CODE["Ret"]!, 3,
  ];
  const w = walkEntry(parseFxb(fxb(code, 0xffff, 0)).code, 0);
  assert.equal(w.max["LoadLocal"], 1);
  assert.equal(w.max["PushConst"], 1 + 3);
  assert.equal(w.max["Mul"], 1 + 1);
  assert.equal(w.max["LoadState"], 1);
  assert.equal(w.max["AddI"], 1);
  assert.equal(w.max["LoadCtx"], 1);
  assert.equal(w.max["Swizzle"], 1);
  assert.equal(w.max["Add"], 1);
  // the fused names themselves are not features (fitted tables price parts).
  for (const n of ["BinTop", "BinPair", "PushConsts", "LoadCtxLanes", "MulAdd"]) assert.equal(w.max[n], undefined);
});

test("mathFeature maps fn ids to sub-keys and other opcodes to themselves", () => {
  assert.equal(mathFeature("UnMath", 0), "UnMath:sin");
  assert.equal(mathFeature("UnMath", 6), "UnMath:sqrt");
  assert.equal(mathFeature("BinMath", 2), "BinMath:pow");
  assert.equal(mathFeature("Mul", undefined), "Mul");
  // an unknown/out-of-range fn id falls back to the bare family name.
  assert.equal(mathFeature("UnMath", 99), "UnMath");
});

test("costFor resolves sub-key -> family base -> fallback", () => {
  const costs = { "UnMath:sqrt": 60, UnMath: 120, Mul: 14 };
  assert.equal(costFor(costs, "UnMath:sqrt", 8), 60, "exact sub-key wins");
  assert.equal(costFor(costs, "UnMath:exp", 8), 120, "unpriced fn falls to family base");
  assert.equal(costFor(costs, "Mul", 8), 14, "plain opcode");
  assert.equal(costFor(costs, "Normalize", 8), 8, "absent -> fallback");
  // a table with no base tier: sub-key falls straight through to the fallback.
  assert.equal(costFor({ Mul: 14 }, "BinMath:pow", 7), 7);
});

test("histCycles honors the family fallback for math sub-keys", () => {
  // sqrt priced exactly; exp rides the family base; tan hits the global fallback.
  const costs = { "UnMath:sqrt": 60, UnMath: 120 };
  const c = histCycles({ "UnMath:sqrt": 2, "UnMath:exp": 1, "UnMath:tan": 0 }, costs, 5);
  assert.equal(c, 2 * 60 + 1 * 120);
});

test("estimateFrameTime scales shade cost by led_count and reports a budget fraction", () => {
  // shade: one Mul(n=1) then Ret. update: absent.
  const code = [CODE["Mul"]!, 1, CODE["Ret"]!, 3];
  const buf = fxb(code, 0xffff, 0);
  const table = defaultCostTable();
  const small = estimateFrameTime({ bytecode: buf, ledCount: 16, table });
  const big = estimateFrameTime({ bytecode: buf, ledCount: 256, table });
  assert.ok(big.totalMs > small.totalMs, "more LEDs cost more");
  assert.ok(big.phaseSplit.shadeMs > small.phaseSplit.shadeMs);
  assert.ok(big.budgetFraction > 0);
  // hot opcodes sorted by contribution, Mul present
  assert.ok(big.hotOpcodes.some((h) => h.op === "Mul"));
});

test("dynamic shade histogram overrides the static walk", () => {
  const code = [CODE["Mul"]!, 1, CODE["Ret"]!, 3];
  const buf = fxb(code, 0xffff, 0);
  const table = defaultCostTable();
  const est = estimateFrameTime({
    bytecode: buf,
    ledCount: 100,
    table,
    dynamicShadeHist: { Mul: 500 }, // 5 Mul/LED over 100 LEDs
    dynamicLedCount: 100,
  });
  // exact executed path -> no band from shade
  assert.equal(est.errorBand.lowMs <= est.totalMs, true);
  assert.equal(est.opsPerLed, 5);
});

test("confidenceOf colorizes by fit likelihood", () => {
  assert.equal(confidenceOf(5, 10, 33.3), "green"); // high estimate well under budget
  assert.equal(confidenceOf(20, 40, 33.3), "yellow"); // straddles
  assert.equal(confidenceOf(40, 60, 33.3), "red"); // low estimate overruns
});

void ({} as CostTable);

// -- R12 (docs/design/fx-perf-study.md, Q3): user functions, guards, branch odds,
// texture + fixed-context costs ------------------------------------------------

const rel = (v: number): [number, number] => [v & 0xff, (v >> 8) & 0xff];

test("a user-function call is priced at its call site (the callee's body runs per LED)", () => {
  // 0: Call -> 8 ; 3: Ret 1 ... 8: UnMath sin ×3 ; RetFn
  const callee = [CODE["UnMath"]!, 0, 1, CODE["UnMath"]!, 0, 1, CODE["UnMath"]!, 0, 1, CODE["RetFn"]!];
  const code = [CODE["PushConst"]!, 0, 0, CODE["Call"]!, ...rel(8), CODE["Ret"]!, 1, ...callee];
  const w = walkEntry(parseFxb(fxb(code, 0xffff, 0)).code, 0);
  assert.equal(w.max["UnMath:sin"], 3, "the callee's three sines count");
  assert.equal(w.opsMax, 3 + callee.length - 6, "and their dispatch (PushConst, Call, Ret + 4 callee ops)");
});

test("an early-return guard (`if (led.seg < 0) return black`) prices the continuation", () => {
  // LoadCtx seg ; BrFalse -> body (skips the arm) ; arm: 3× PushConst + Ret 3 ; body: sin(led.pos) ; Ret
  const arm = [CODE["PushConst"]!, 0, 0, CODE["PushConst"]!, 0, 0, CODE["PushConst"]!, 0, 0, CODE["Ret"]!, 3];
  const body = [CODE["LoadCtx"]!, 3, CODE["UnMath"]!, 0, 3, CODE["Ret"]!, 3];
  const code = [CODE["LoadCtx"]!, 6, CODE["BrFalse"]!, ...rel(arm.length), ...arm, ...body];
  const e = estimateFrameTime({ bytecode: fxb(code, 0xffff, 0), ledCount: 100, table: defaultCostTable() });
  const plain = estimateFrameTime({
    bytecode: fxb([CODE["LoadCtx"]!, 6, CODE["Pop"]!, 1, ...body], 0xffff, 0),
    ledCount: 100,
    table: defaultCostTable(),
  });
  // The guarded effect costs what the full effect costs (± the compare), not half.
  assert.ok(Math.abs(e.phaseSplit.shadeMs / plain.phaseSplit.shadeMs - 1) < 0.05, `${e.phaseSplit.shadeMs} vs ${plain.phaseSplit.shadeMs}`);
});

test("an equality-guarded arm (`if (i % 16 == slot)`) is weighted as rare in the point estimate", () => {
  // LoadCtx idx ; PushConst ; CmpI eq ; BrFalse -> skip an expensive arm (pow ×4)
  const powArm = Array.from({ length: 4 }, () => [CODE["LoadCtx"]!, 7, CODE["LoadCtx"]!, 7, CODE["BinMath"]!, 2, 1, CODE["Pop"]!, 1]).flat();
  const mk = (kind: number): Uint8Array =>
    fxb(
      [CODE["LoadCtx"]!, 4, CODE["PushConst"]!, 0, 0, CODE["CmpI"]!, kind, CODE["BrFalse"]!, ...rel(powArm.length), ...powArm, CODE["PushConst"]!, 0, 0, CODE["Ret"]!, 1],
      0xffff,
      0,
    );
  const t = defaultCostTable();
  const eq = estimateFrameTime({ bytecode: mk(4), ledCount: 100, table: t });
  const lt = estimateFrameTime({ bytecode: mk(0), ledCount: 100, table: t });
  // Same band (min/max are probability-free), different point estimates.
  assert.equal(eq.errorBand.highMs, lt.errorBand.highMs);
  assert.ok(eq.totalMs < lt.totalMs, `${eq.totalMs} < ${lt.totalMs}`);
  // `<` keeps the 50/50 midpoint of the band (before the residual widening:
  // 15% + 5% for control flow).
  const mid = (lt.errorBand.lowMs / (1 - 0.2) + lt.errorBand.highMs / (1 + 0.2)) / 2;
  assert.ok(Math.abs(lt.totalMs / mid - 1) < 0.01, `${lt.totalMs} vs ${mid}`);
});

test("texture samples and fixed-context reads carry their measured costs", () => {
  const t = defaultCostTable();
  assert.ok(costFor(t.costs, "SampleTex", 0) >= 3000, "a bilinear float sample is ~4k cycles, not a cheap op");
  // FLAG_USES_CTXFIX (0x02): the per-LED Q16 mirrors.
  const code = [CODE["LoadCtxFix"]!, 7, 0, 16, CODE["Ret"]!, 1];
  const a = fxb(code, 0xffff, 0);
  const b = fxb(code, 0xffff, 0);
  b[5] = 0x02;
  const ea = estimateFrameTime({ bytecode: a, ledCount: 100, table: t });
  const eb = estimateFrameTime({ bytecode: b, ledCount: 100, table: t });
  const perLed = ((eb.phaseSplit.shadeMs - ea.phaseSplit.shadeMs) / 1000) * t.cpuHz / 100;
  assert.ok(Math.abs(perLed - costFor(t.costs, "@ctxfix", 0)) < 1, String(perLed));
});
