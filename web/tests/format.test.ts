import assert from "node:assert/strict";
import { test } from "node:test";

import { formatFx } from "../src/effects/editor/format";

test("re-indents braces to two spaces per level", () => {
  const messy = "void update() {\nif (x) {\nfoo();\n}\n}\n";
  assert.equal(formatFx(messy), "void update() {\n  if (x) {\n    foo();\n  }\n}\n");
});

test("dedents leading closers and handles `} else {`", () => {
  const src = "if (a) {\nx();\n} else {\ny();\n}\n";
  assert.equal(formatFx(src), "if (a) {\n  x();\n} else {\n  y();\n}\n");
});

test("indents multi-line call arguments by paren depth", () => {
  const src = "vec3 d = normalize(vec3(\na,\nb,\nc));\n";
  assert.equal(formatFx(src), "vec3 d = normalize(vec3(\n    a,\n    b,\n    c));\n");
});

test("ignores braces inside line and block comments", () => {
  const src = "void f() {\n// a } brace in a comment {\n/* block } with { braces */\ng();\n}\n";
  assert.equal(
    formatFx(src),
    "void f() {\n  // a } brace in a comment {\n  /* block } with { braces */\n  g();\n}\n",
  );
});

test("collapses blank runs, trims trailing space, single final newline", () => {
  const src = "a();   \n\n\n\nb();\n\n\n";
  assert.equal(formatFx(src), "a();\n\nb();\n");
});

test("is idempotent", () => {
  const src = `uniform float speed : 0.0 .. 2.0 = 0.4;
struct Wave { vec3 dir; float k; };
state Wave w[8];
void update() {
for (int i = 0; i < 8; i = i + 1) {
if (i < 4) {
w[i].k = float(i);
}
}
}
vec3 shade(Led led) {
return vec3(0.0);
}
`;
  const once = formatFx(src);
  assert.equal(formatFx(once), once, "formatting a formatted string is a no-op");
  // update → for → if = three levels deep → six spaces.
  assert.ok(once.includes("\n      w[i].k = float(i);"), "inner statement indented three levels");
});
