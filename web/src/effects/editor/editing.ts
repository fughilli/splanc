/**
 * Pure text-editing operations behind the effect editor's keyboard handling
 * (D-500/D-501): Tab / Shift+Tab indent and outdent, Enter auto-indent, the
 * electric `}`, caret row:col, and the source span a compiler diagnostic
 * points at. DOM-free so the node:test suite covers them; the editor screen
 * (ui/screens/effectEditor.ts) applies the returned edits to its <textarea>.
 *
 * Indentation follows the formatter (format.ts): one tab stop of four spaces
 * per open brace / paren / bracket, comments ignored. Typing a program from
 * scratch therefore lands exactly where "Format code" would put it.
 */

import { INDENT } from "./format";

/** One tab stop. */
export const TAB_WIDTH = INDENT.length;

/** A replacement of `src[from, to)` by `text`, then the selection to set. */
export interface TextEdit {
  from: number;
  to: number;
  text: string;
  selStart: number;
  selEnd: number;
}

const OPENERS = "{([";
const CLOSERS = "})]";

/** Net bracket depth of `src[0, pos)` (comments and strings skipped, never
 * below zero), plus whether `pos` sits inside a block comment. */
export function depthAt(src: string, pos: number): { depth: number; inComment: boolean } {
  let depth = 0;
  let i = 0;
  const end = Math.min(pos, src.length);
  while (i < end) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < end && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0 || close + 2 > end) return { depth, inComment: true };
      i = close + 2;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < end && src[i] !== '"' && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth = Math.max(0, depth - 1);
    i++;
  }
  return { depth, inComment: false };
}

function lineStartOf(src: string, pos: number): number {
  return src.lastIndexOf("\n", pos - 1) + 1;
}

function lineEndOf(src: string, pos: number): number {
  const e = src.indexOf("\n", pos);
  return e < 0 ? src.length : e;
}

function leadingWs(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/**
 * Tab / Shift+Tab. A collapsed caret on Tab inserts spaces up to the next tab
 * stop; any selection (or Shift+Tab) re-indents every line the selection
 * touches by one stop, keeping the selection over the same text. A selection
 * ending at column 0 does not touch that last line (as in other editors).
 * Returns null when nothing would change (outdenting unindented lines).
 */
export function indentEdit(src: string, selStart: number, selEnd: number, outdent: boolean): TextEdit | null {
  if (!outdent && selStart === selEnd) {
    const col = selStart - lineStartOf(src, selStart);
    const pad = " ".repeat(TAB_WIDTH - (col % TAB_WIDTH));
    const at = selStart + pad.length;
    return { from: selStart, to: selStart, text: pad, selStart: at, selEnd: at };
  }
  const from = lineStartOf(src, selStart);
  let lastPos = selEnd;
  if (selEnd > selStart && selEnd === lineStartOf(src, selEnd)) lastPos = selEnd - 1;
  const to = lineEndOf(src, Math.max(lastPos, from));
  const lines = src.slice(from, to).split("\n");

  // Per-line change in length, applied to the selection ends by line.
  const deltas: number[] = [];
  const out = lines.map((line) => {
    if (!outdent) {
      // Indenting skips blank lines (no trailing-whitespace litter).
      if (line.trim() === "") {
        deltas.push(0);
        return line;
      }
      deltas.push(TAB_WIDTH);
      return INDENT + line;
    }
    const ws = leadingWs(line);
    let cut = 0;
    if (ws.startsWith("\t")) cut = 1;
    else cut = Math.min(TAB_WIDTH, ws.length - ws.replace(/^ +/, "").length);
    deltas.push(-cut);
    return line.slice(cut);
  });
  const text = out.join("\n");
  if (text === src.slice(from, to)) return null;

  // Map an offset in the old block to the new one: shift by every earlier
  // line's delta plus this line's (clamped so an outdent can't move a caret
  // that sat inside the removed whitespace before the line start).
  const mapPos = (p: number): number => {
    if (p < from) return p;
    let lineIdx = 0;
    let lineStart = from;
    let shift = 0;
    while (lineIdx < lines.length - 1 && p > lineStart + lines[lineIdx]!.length) {
      lineStart += lines[lineIdx]!.length + 1;
      shift += deltas[lineIdx]!;
      lineIdx++;
    }
    const d = deltas[lineIdx]!;
    const col = p - lineStart;
    const newCol = d >= 0 ? (col === 0 && selStart !== selEnd && p === selStart ? 0 : col + d) : Math.max(0, col + d);
    return lineStart + shift + newCol;
  };
  const s = mapPos(selStart);
  const e = selEnd === selStart ? s : mapPos(selEnd);
  return { from, to, text, selStart: s, selEnd: e };
}

/** The indent a new line at `pos` should get, given the parse before it. */
export function indentAt(src: string, pos: number): string {
  const { depth, inComment } = depthAt(src, pos);
  if (inComment) return leadingWs(src.slice(lineStartOf(src, pos), pos));
  return INDENT.repeat(depth);
}

/**
 * Enter: replace the selection with a newline indented for the current parse.
 * Whitespace right after the caret is absorbed; text after the caret that
 * starts with a closer is outdented one level, and Enter between a bracket pair
 * (`{|}`) opens an indented empty line between them.
 */
export function newlineEdit(src: string, selStart: number, selEnd: number): TextEdit {
  const lineEnd = lineEndOf(src, selEnd);
  let to = selEnd;
  while (to < lineEnd && (src[to] === " " || src[to] === "\t")) to++;
  const head = src.slice(0, selStart);
  const indent = indentAt(src, selStart);
  const next = src[to];
  const prev = /(\S)\s*$/.exec(src.slice(lineStartOf(src, selStart), selStart))?.[1];
  if (next !== undefined && CLOSERS.includes(next) && !depthAt(src, selStart).inComment) {
    const outer = INDENT.repeat(Math.max(0, indent.length / TAB_WIDTH - 1));
    if (prev !== undefined && OPENERS.indexOf(prev) === CLOSERS.indexOf(next)) {
      const text = "\n" + indent + "\n" + outer;
      const at = head.length + 1 + indent.length;
      return { from: selStart, to, text, selStart: at, selEnd: at };
    }
    const text = "\n" + outer;
    const at = selStart + text.length;
    return { from: selStart, to, text, selStart: at, selEnd: at };
  }
  const text = "\n" + indent;
  const at = selStart + text.length;
  return { from: selStart, to, text, selStart: at, selEnd: at };
}

/**
 * The electric `}`: typing a closing brace on a line that holds only
 * whitespace re-indents that line to the brace's level. Null when the line has
 * other text before the caret (the brace is then inserted as typed).
 */
export function closeBraceEdit(src: string, selStart: number, selEnd: number): TextEdit | null {
  const ls = lineStartOf(src, selStart);
  if (src.slice(ls, selStart).trim() !== "") return null;
  const { depth, inComment } = depthAt(src, ls);
  if (inComment) return null;
  const indent = INDENT.repeat(Math.max(0, depth - 1));
  const text = indent + "}";
  const at = ls + text.length;
  return { from: ls, to: selEnd, text, selStart: at, selEnd: at };
}

/** 1-based row and column of offset `pos` (the cursor readout). */
export function rowColAt(src: string, pos: number): { row: number; col: number } {
  let row = 1;
  let ls = 0;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src[i] === "\n") {
      row++;
      ls = i + 1;
    }
  }
  return { row, col: pos - ls + 1 };
}

/** Offset of 1-based `line`/`col`, clamped into that line (end of text when
 * the line is past the end). */
export function offsetOf(src: string, line: number, col: number): number {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const nl = src.indexOf("\n", pos);
    if (nl < 0) return src.length;
    pos = nl + 1;
  }
  return Math.min(pos + Math.max(0, col - 1), lineEndOf(src, pos));
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_.]/.test(c);

/**
 * The source range `[from, to)` a diagnostic at 1-based `line`/`col` should
 * underline: the token starting there (an identifier or number, a two-char
 * operator, or one punctuation char). A position on whitespace or past the end
 * of its line (an "expected `;`" at end of line) underlines the last token
 * before it instead, so there is always something visible to hover.
 */
export function diagSpan(src: string, line: number, col: number): { from: number; to: number } {
  let p = offsetOf(src, line, col);
  if (p >= src.length || /\s/.test(src[p]!)) {
    let q = p - 1;
    while (q >= 0 && /\s/.test(src[q]!)) q--;
    if (q < 0) return { from: p, to: Math.min(src.length, p + 1) };
    // Step back to the start of that token.
    p = q;
    if (isWord(src[p])) while (p > 0 && isWord(src[p - 1])) p--;
    return { from: p, to: q + 1 };
  }
  if (isWord(src[p])) {
    let e = p;
    while (e < src.length && isWord(src[e])) e++;
    return { from: p, to: e };
  }
  const two = src.slice(p, p + 2);
  if (["==", "!=", "<=", ">=", "&&", "||", "..", "+=", "-=", "*=", "/="].includes(two)) return { from: p, to: p + 2 };
  return { from: p, to: p + 1 };
}

/** A compiler diagnostic with the severity the editor draws it at. */
export interface Mark {
  line: number;
  col: number;
  msg: string;
  severity: "error" | "warning";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * HTML for the diagnostics layer drawn under the highlighted code: the same
 * text (made transparent by CSS) with every line that has a diagnostic wrapped
 * in a full-width band (`fxdiag-line--error|warning`) and each diagnostic's
 * span in a squiggle (`fxdiag-sq--error|warning`, `data-i` = its index into
 * `marks`). Overlapping spans keep the first (errors sort first).
 */
export function diagnosticsHtml(src: string, marks: readonly Mark[]): string {
  if (marks.length === 0) return "";
  const order = marks.map((m, i) => ({ m, i })).sort((a, b) => (a.m.severity === b.m.severity ? 0 : a.m.severity === "error" ? -1 : 1));
  const spans: { from: number; to: number; i: number; sev: Mark["severity"] }[] = [];
  const lineSev = new Map<number, Mark["severity"]>();
  for (const { m, i } of order) {
    const sp = diagSpan(src, m.line, m.col);
    if (spans.some((s) => sp.from < s.to && s.from < sp.to)) continue;
    spans.push({ ...sp, i, sev: m.severity });
    const row = rowColAt(src, sp.from).row;
    if (!lineSev.has(row)) lineSev.set(row, m.severity);
  }
  spans.sort((a, b) => a.from - b.from);
  const lines = src.split("\n");
  let out = "";
  let off = 0;
  let k = 0;
  lines.forEach((line, idx) => {
    const lineEnd = off + line.length;
    let body = "";
    let p = off;
    while (k < spans.length && spans[k]!.from < lineEnd + 1) {
      const s = spans[k]!;
      const from = Math.max(s.from, off);
      const to = Math.min(s.to, lineEnd);
      body += esc(src.slice(p, from));
      // An empty span (at end of text) still gets one cell to hover.
      const inner = to > from ? esc(src.slice(from, to)) : " ";
      body += `<span class="fxdiag-sq fxdiag-sq--${s.sev}" data-i="${s.i}">${inner}</span>`;
      p = Math.max(p, to);
      k++;
    }
    body += esc(src.slice(p, lineEnd));
    const sev = lineSev.get(idx + 1);
    out += sev ? `<span class="fxdiag-line fxdiag-line--${sev}">${body || "​"}</span>` : body;
    if (idx < lines.length - 1) out += "\n";
    off = lineEnd + 1;
  });
  return out;
}
