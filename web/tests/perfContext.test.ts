import test from "node:test";
import assert from "node:assert/strict";

import { builtinCostsToPrompt } from "../src/effects/perfContext";
import type { CostTable } from "../src/effects/costModel";

function table(costs: Record<string, number>): CostTable {
  return {
    soc: "esp32c6",
    cpuHz: 160_000_000,
    budgetMs: 33,
    costs,
    fixed: { update_fixed: 0, shade_fixed: 0, show_fixed: 0, show_per_led: 0 },
    residualError: 0,
    fallbackCost: 8,
  };
}

test("builtinCostsToPrompt ranks builtins by device cost, relative to multiply", () => {
  const t = table({
    Mul: 14,
    Add: 12,
    Div: 45,
    "UnMath:sin": 65, // LUT-accelerated
    "BinMath:pow": 180, // costliest
    Hash1: 30, // integer hash
    Length: 90,
  });
  const out = builtinCostsToPrompt(t, /*calibrated*/ true);

  assert.match(out, /BUILTIN COSTS on this device \(esp32c6 @ 160 MHz, measured on your board\)/);
  assert.match(out, /mul 1\.0x/); // the anchor
  assert.match(out, /pow /); // present
  // Cheap-to-expensive ordering: mul before sin before pow.
  assert.ok(out.indexOf(" mul ") < out.indexOf(" sin "), "mul should rank before sin");
  assert.ok(out.indexOf(" sin ") < out.indexOf(" pow "), "sin should rank before pow");
  // A missing cost key falls back through costFor (no crash, still listed).
  assert.match(out, /cos /);
});

test("builtinCostsToPrompt labels an uncalibrated table as the default model", () => {
  const out = builtinCostsToPrompt(table({ Mul: 14 }), false);
  assert.match(out, /default model/);
});
