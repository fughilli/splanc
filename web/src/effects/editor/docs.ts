/**
 * The Docs pane's pure core (D-541 PR 6): search over the compiler's language
 * table, the category index, which reference term sits under the caret or a
 * selection ("Go to docs"), and the edit that inserts an example snippet.
 *
 * Everything here reads `LANG` (lang-spec.ts, generated from the compiler's
 * fx_compiler::lang table), so the docs can never describe a word the compiler
 * doesn't have. No DOM: docs-panel.ts renders it, effectEditor.ts wires it.
 */

import { LANG, langEntry, type LangEntry, type LangKind, type LangScope } from "./lang-spec";
import type { TextEdit } from "./editing";

/** Category order for the index (most-used first); unknown categories from a
 * newer table follow in table order, so a new one shows up without a code change. */
const CATEGORY_ORDER: readonly string[] = [
  "program",
  "input",
  "declaration",
  "uniform ui",
  "math",
  "vector",
  "colour",
  "fixed",
  "scalar",
  "matrix",
  "topology",
  "texture",
  "noise",
  "trigger",
  "storage",
  "control",
  "literal",
  "driver",
];

const CATEGORY_LABEL: Record<string, string> = {
  program: "Program",
  input: "Inputs",
  declaration: "Declarations",
  "uniform ui": "Uniform controls",
  math: "Maths",
  vector: "Vectors",
  colour: "Colour",
  fixed: "Fixed point",
  scalar: "Scalars",
  matrix: "Matrices",
  topology: "Topology",
  texture: "Textures",
  noise: "Noise",
  trigger: "Triggers",
  storage: "Storage",
  control: "Control flow",
  literal: "Literals",
  driver: "Sensor drivers",
};

/** Human label for a table category. */
export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

const KIND_LABEL: Record<LangKind, string> = {
  keyword: "keyword",
  type: "type",
  context: "input",
  member: "input field",
  builtin: "function",
  entry: "entry point",
  annotation: "uniform annotation",
  syntax: "syntax",
};

/** Human label for an entry's kind ("function", "input field", ...). */
export function kindLabel(kind: LangKind): string {
  return KIND_LABEL[kind];
}

/** Where an entry may be used, in a sentence; "" for "anywhere". */
export function scopeText(scope: LangScope): string {
  switch (scope) {
    case "update":
      return "Only in update() or init(): it runs once per frame, not per LED.";
    case "driver":
      return "Only in a sensor driver's poll(); it does nothing in an effect.";
    case "reserved":
      return "Reserved: the compiler recognises the name and says what to use instead.";
    default:
      return "";
  }
}

/** The index: categories in display order, each with its entries in table order. */
export function docsByCategory(entries: readonly LangEntry[] = LANG): { category: string; label: string; entries: LangEntry[] }[] {
  const groups = new Map<string, LangEntry[]>();
  for (const e of entries) {
    const g = groups.get(e.category);
    if (g) g.push(e);
    else groups.set(e.category, [e]);
  }
  const known = CATEGORY_ORDER.filter((c) => groups.has(c));
  const extra = [...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c));
  return [...known, ...extra].map((category) => ({
    category,
    label: categoryLabel(category),
    entries: groups.get(category)!,
  }));
}

/**
 * Search the table. Every whitespace-separated word of the query must match
 * somewhere in the entry (name, signatures, summary, doc, category, kind);
 * results rank exact name > name prefix > name substring > signature >
 * summary/category > doc, then by table order. An empty query returns [].
 */
export function searchDocs(query: string, entries: readonly LangEntry[] = LANG): LangEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { e: LangEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const name = e.name.toLowerCase();
    const sigs = e.sigs.join("\n").toLowerCase();
    const summary = e.summary.toLowerCase();
    const doc = e.doc.toLowerCase();
    const meta = `${e.category} ${categoryLabel(e.category)} ${kindLabel(e.kind)}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      let s = 0;
      if (name === w) s = 100;
      else if (name.startsWith(w)) s = 60;
      else if (name.includes(w)) s = 40;
      else if (sigs.includes(w)) s = 20;
      else if (summary.includes(w) || meta.includes(w)) s = 12;
      else if (doc.includes(w)) s = 5;
      if (s === 0) return; // every word must match
      score += s;
    }
    scored.push({ e, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.e);
}

/** True when an example is a whole program (declarations or function bodies at
 * the top level) rather than a snippet that drops into shade() or update(). */
export function exampleIsProgram(example: string): boolean {
  return example.split("\n").some((line) =>
    /^(uniform|state|shared|export|buffer|texture|struct)\b/.test(line) ||
    /^[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*\{/.test(line),
  );
}

const IDENT = /[A-Za-z0-9_]/;
const SWIZZLE = /^(?:[xyzw]{1,4}|[rgba]{1,4})$/;
const FX_LITERAL = /^\d[\d.]*(?:fx|fx8|fx16)$/;
const PATH = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;

/** A dotted path (`led.pos.xz`) to the entry it names: itself, its longest
 * documented prefix, or `swizzle` for a trailing component pick. When
 * `swizzleFirst`, a trailing swizzle wins over the prefix (the caret is on it). */
function resolvePath(path: string, swizzleFirst: boolean): string | null {
  if (langEntry(path)) return path;
  const segs = path.split(".").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  const isSwizzle = segs.length > 1 && SWIZZLE.test(last);
  if (isSwizzle && swizzleFirst) return "swizzle";
  for (let k = segs.length - 1; k >= 1; k--) {
    const p = segs.slice(0, k).join(".");
    if (langEntry(p)) return p;
  }
  return isSwizzle ? "swizzle" : null;
}

/** `step` inside a uniform's range annotation (`: 0 .. 1 step 0.1`) is the
 * range annotation's keyword, not the step() built-in. */
function isRangeStep(src: string, wordStart: number, wordEnd: number): boolean {
  const lineStart = src.lastIndexOf("\n", wordStart - 1) + 1;
  const before = src.slice(lineStart, wordStart);
  const after = src.slice(wordEnd);
  return /^\s*uniform\b[^;]*:[^;]*\.\.[^;]*$/.test(before) && !/^\s*\(/.test(after);
}

/**
 * The reference entry to open for the caret (`start === end`) or a selection in
 * `src`, or null when nothing there is documented (a user-named variable, a
 * number, punctuation). A caret on `pos` in `led.pos.xz` gives `led.pos`, on
 * `xz` gives `swizzle`; a selection of `sin(x * 2.0)` gives `sin` (the first
 * documented word in it).
 */
export function termAt(src: string, start: number, end: number): string | null {
  if (start !== end) {
    const a = Math.min(start, end);
    const b = Math.max(start, end);
    const sel = src.slice(a, b).trim();
    if (!sel) return null;
    if (langEntry(sel)) {
      if (sel === "step") {
        const at = src.indexOf("step", a);
        if (at >= 0 && isRangeStep(src, at, at + 4)) return "range";
      }
      return sel;
    }
    if (FX_LITERAL.test(sel)) return "fx";
    for (const m of sel.matchAll(PATH)) {
      // Skip identifier tails of numbers (`0.5fx` → `fx` is handled below).
      const before = sel[(m.index ?? 0) - 1];
      if (before !== undefined && /[\d.]/.test(before)) continue;
      const hit = resolvePath(m[0], false);
      if (hit) return hit;
    }
    return /\d(?:fx|fx8|fx16)\b/.test(sel) ? "fx" : null;
  }
  // Caret: the dotted path up to the end of the segment the caret is in.
  let a = start;
  while (a > 0 && (IDENT.test(src[a - 1]!) || src[a - 1] === ".")) a--;
  let b = start;
  while (b < src.length && IDENT.test(src[b]!)) b++;
  const token = src.slice(a, b).replace(/^\.+/, "");
  if (!token) return null;
  if (FX_LITERAL.test(token)) return "fx";
  if (/^\d/.test(token)) return null;
  if (token === "step" && isRangeStep(src, b - 4, b)) return "range";
  return resolvePath(token, true);
}

/**
 * The edit that inserts an example snippet on its own line(s) above the
 * caret's line, re-indented to that line's indentation (replacing the line
 * when it is blank), with the caret left after the snippet. Inserting at the
 * caret mid-expression would break the program, so the snippet never splits a line.
 */
export function insertSnippetEdit(src: string, caret: number, snippet: string): TextEdit {
  const lineStart = src.lastIndexOf("\n", caret - 1) + 1;
  let lineEnd = src.indexOf("\n", caret);
  if (lineEnd < 0) lineEnd = src.length;
  const line = src.slice(lineStart, lineEnd);
  const indent = /^[ \t]*/.exec(line)![0];
  const body = snippet
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => (l ? indent + l : l))
    .join("\n");
  if (line.trim() === "") {
    // A blank line: the snippet takes its place.
    const end = lineStart + body.length;
    return { from: lineStart, to: lineEnd, text: body, selStart: end, selEnd: end };
  }
  const text = `${body}\n`;
  const end = lineStart + body.length;
  return { from: lineStart, to: lineStart, text, selStart: end, selEnd: end };
}
