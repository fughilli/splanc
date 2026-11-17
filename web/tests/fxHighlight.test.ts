/**
 * The effect editor's highlighter keeps a fixed-point literal suffix (`0.6fx`,
 * `0.6fx16`, `0.6fx8`) inside the number token, so `fx8` isn't drawn as an
 * unknown identifier. Anything else after a number is still its own token.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { highlight } from "../src/effects/editor/highlight";

const num = (t: string): string => `<span class="fxhl-num">${t}</span>`;

test("fixed-point literal suffixes highlight as part of the number", () => {
  for (const lit of ["0.6fx", "0.6fx16", "1.2fx8", "1fx", ".5fx16"]) {
    assert.ok(highlight(`x * ${lit};`).includes(num(lit)), `${lit}: ${highlight(`x * ${lit};`)}`);
  }
});

test("only the fx suffixes are absorbed", () => {
  // `fx12` is not a suffix (the compiler rejects it): the number ends at the digits.
  assert.ok(highlight("0.5fx12").includes(num("0.5")));
  assert.ok(!highlight("0.5fx12").includes(num("0.5fx12")));
  assert.ok(highlight("0.0 .. 5.0").includes(num("0.0")), "the range operator still splits");
});
