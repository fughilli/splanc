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

const cls = (c: string, t: string): string => `<span class="fxhl-${c}">${t}</span>`;

test("matrix and trigger types highlight as types", () => {
  for (const t of ["mat3", "mat4", "vec4", "fixed16", "trigger"]) {
    assert.ok(highlight(`${t} m;`).includes(cls("type", t)), `${t}: ${highlight(`${t} m;`)}`);
  }
});

test("declaration keywords the compiler takes highlight as keywords", () => {
  for (const k of ["uniform", "state", "shared", "export", "buffer", "texture", "struct"]) {
    assert.ok(highlight(`${k} x`).includes(cls("kw", k)), k);
  }
});

test("every built-in the compiler has highlights as a function, driver ones too", () => {
  for (const f of ["atan", "atan2", "rgb", "rgb8", "transpose", "transform", "fired", "sample", "paint", "fire", "gpio_read", "gpio_mode", "i2c_write", "i2c_read8", "i2c_read16", "i2c_read16s"]) {
    assert.ok(highlight(`${f}(x)`).includes(cls("fn", f)), f);
  }
});

test("the room context highlights like led and imu", () => {
  const h = highlight("vec3 p = (led.room - room.min) / (room.max - room.min);");
  assert.ok(h.includes(cls("ctx", "room")) && h.includes(cls("ctx", "led")), h);
});

test("only // comments: /* */ is not drawn as a comment (the compiler has none)", () => {
  assert.ok(!highlight("/* x */ float y;").includes("fxhl-comment"));
  assert.ok(highlight("float y; // note").includes(cls("comment", "// note")));
});

test("a string runs to the next quote, as in the compiler (no escapes)", () => {
  assert.ok(highlight('uniform float t "a\\" + b;').includes(cls("str", '"a\\"')));
});
