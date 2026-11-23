/**
 * The effect editor's keyboard edits (D-500/D-501): Tab / Shift+Tab indent and
 * outdent, Enter auto-indent, the electric `}`, the row:col readout and the
 * diagnostic underline spans (effects/editor/editing.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeBraceEdit,
  diagSpan,
  diagnosticsHtml,
  indentEdit,
  newlineEdit,
  rowColAt,
  type TextEdit,
} from "../src/effects/editor/editing";
import { formatFx } from "../src/effects/editor/format";

const apply = (src: string, e: TextEdit): string => src.slice(0, e.from) + e.text + src.slice(e.to);

/** `|` marks the caret (or `[` `]` the selection) in a test string. */
function parse(s: string): { src: string; a: number; b: number } {
  if (s.includes("[")) {
    const a = s.indexOf("[");
    const b = s.indexOf("]") - 1;
    return { src: s.replace("[", "").replace("]", ""), a, b };
  }
  const a = s.indexOf("|");
  return { src: s.replace("|", ""), a, b: a };
}
function show(src: string, e: TextEdit): string {
  const t = apply(src, e);
  if (e.selStart === e.selEnd) return t.slice(0, e.selStart) + "|" + t.slice(e.selStart);
  return t.slice(0, e.selStart) + "[" + t.slice(e.selStart, e.selEnd) + "]" + t.slice(e.selEnd);
}

test("Tab with a caret inserts spaces to the next four-column stop", () => {
  const { src, a } = parse("ab|c");
  assert.equal(show(src, indentEdit(src, a, a, false)!), "ab  |c");
  const p = parse("abcd|");
  assert.equal(show(p.src, indentEdit(p.src, p.a, p.a, false)!), "abcd    |");
});

test("Tab with a selection indents every touched line, keeping the selection", () => {
  const { src, a, b } = parse("x\n[a;\nb;\n]c;");
  assert.equal(show(src, indentEdit(src, a, b, false)!), "x\n[    a;\n    b;\n]c;");
  const p = parse("f(\n  a[b;\n  c]d;\n)");
  assert.equal(show(p.src, indentEdit(p.src, p.a, p.b, false)!), "f(\n      a[b;\n      c]d;\n)");
});

test("indent skips blank lines; Shift+Tab outdents one stop and never past column 0", () => {
  const { src, a, b } = parse("[a;\n\nb;]");
  assert.equal(apply(src, indentEdit(src, a, b, false)!), "    a;\n\n    b;");
  const p = parse("        [a;\n  b;\nc;]");
  assert.equal(show(p.src, indentEdit(p.src, p.a, p.b, true)!), "    [a;\nb;\nc;]");
  const q = parse("  |  x;");
  assert.equal(show(q.src, indentEdit(q.src, q.a, q.a, true)!), "|x;");
  assert.equal(indentEdit("x;", 1, 1, true), null, "nothing to outdent");
});

test("Enter indents to the current parse depth", () => {
  const { src, a } = parse("void update() {|");
  assert.equal(show(src, newlineEdit(src, a, a)), "void update() {\n    |");
  const p = parse("void f() {\n    if (x) {|\n    }\n}");
  assert.equal(show(p.src, newlineEdit(p.src, p.a, p.a)), "void f() {\n    if (x) {\n        |\n    }\n}");
  const q = parse("float y = mix(a,|");
  assert.equal(show(q.src, newlineEdit(q.src, q.a, q.a)), "float y = mix(a,\n    |");
});

test("Enter between braces opens an indented line; before a closer it outdents", () => {
  const { src, a } = parse("void f() {|}");
  assert.equal(show(src, newlineEdit(src, a, a)), "void f() {\n    |\n}");
  const p = parse("void f() {\n    x;|}");
  assert.equal(show(p.src, newlineEdit(p.src, p.a, p.a)), "void f() {\n    x;\n|}");
});

test("Enter ignores braces in comments and strings", () => {
  const { src, a } = parse('// {\nuniform int m : {"a{", "b"} = 0; /* { */|');
  assert.equal(show(src, newlineEdit(src, a, a)), '// {\nuniform int m : {"a{", "b"} = 0; /* { */\n|');
});

test("typing `}` on a blank line snaps it to the matching level", () => {
  const { src, a } = parse("void f() {\n    x;\n        |");
  assert.equal(show(src, closeBraceEdit(src, a, a)!), "void f() {\n    x;\n}|");
  const p = parse("void f() { x; |");
  assert.equal(closeBraceEdit(p.src, p.a, p.a), null, "mid-line `}` is typed as-is");
});

test("typing a program with Enter lands where the formatter puts it", () => {
  // Simulate typing line by line, pressing Enter (and `}` on its own line).
  const lines = ["void update() {", "if (x) {", "y = 1.0;", "}", "}"];
  let src = "";
  let caret = 0;
  lines.forEach((line, i) => {
    if (line === "}") {
      const e = closeBraceEdit(src, caret, caret)!;
      src = apply(src, e);
      caret = e.selStart;
    } else {
      src = src.slice(0, caret) + line + src.slice(caret);
      caret += line.length;
    }
    if (i < lines.length - 1) {
      const e = newlineEdit(src, caret, caret);
      src = apply(src, e);
      caret = e.selStart;
    }
  });
  assert.equal(src + "\n", formatFx(src));
});

test("row:col is 1-based", () => {
  assert.deepEqual(rowColAt("ab\ncd", 0), { row: 1, col: 1 });
  assert.deepEqual(rowColAt("ab\ncd", 4), { row: 2, col: 2 });
  assert.deepEqual(rowColAt("ab\n", 3), { row: 2, col: 1 });
});

test("diagnostic spans cover the token, or the last token before a gap", () => {
  const src = "float x = foo(1.25);\nreturn y\n";
  assert.deepEqual(diagSpan(src, 1, 11), { from: 10, to: 13 }, "identifier");
  assert.deepEqual(diagSpan(src, 1, 15), { from: 14, to: 18 }, "number");
  assert.deepEqual(diagSpan(src, 1, 19), { from: 18, to: 19 }, "punctuation");
  // "expected `;`" reported at the next line / end of line: underline `y`.
  assert.deepEqual(diagSpan(src, 2, 9), { from: 28, to: 29 });
  assert.deepEqual(diagSpan(src, 3, 1), { from: 28, to: 29 });
});

test("the diagnostics layer keeps the text and marks the line + span", () => {
  const src = "a < b;\nok;\nwarn;";
  const html = diagnosticsHtml(src, [
    { line: 1, col: 3, msg: "bad", severity: "error" },
    { line: 3, col: 1, msg: "warning: meh", severity: "warning" },
  ]);
  assert.equal(
    html,
    '<span class="fxdiag-line fxdiag-line--error">a <span class="fxdiag-sq fxdiag-sq--error" data-i="0">&lt;</span> b;</span>\n' +
      "ok;\n" +
      '<span class="fxdiag-line fxdiag-line--warning"><span class="fxdiag-sq fxdiag-sq--warning" data-i="1">warn</span>;</span>',
  );
  assert.equal(diagnosticsHtml(src, []), "");
});
