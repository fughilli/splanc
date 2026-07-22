/**
 * Lightweight syntax highlighter for the GLSL-ish effect language — no heavy
 * editor dependency (no CodeMirror; it complicates the pnpm/bazel build). The
 * editor screen layers a transparent <textarea> над a <pre><code> backdrop and
 * feeds this tokenizer on every input, keeping the two scroll-synced.
 *
 * The vocabulary (keywords, types, built-ins) is derived from lang-spec.ts so it
 * can never describe a built-in the compiler doesn't have. Everything is escaped
 * before it reaches innerHTML; the token <span> classes map to the app's dark
 * theme via CSS tokens (see .fxhl-* in app.css).
 */

import { BUILTINS, KEYWORDS } from "./lang-spec";

// Keywords vs. types: KEYWORDS from lang-spec mixes control words and type
// names, so split them for distinct colouring. `Led` is the shade() param type.
const TYPE_WORDS = new Set<string>(["float", "int", "fixed", "bool", "vec2", "vec3", "vec4", "void", "Led"]);
const KEYWORD_WORDS = new Set<string>(KEYWORDS.filter((k) => !TYPE_WORDS.has(k)));
// Built-in function names, parsed from the "name(args)" signatures in lang-spec,
// plus the palette variants the compiler actually accepts (palette0/1/2).
const BUILTIN_WORDS = new Set<string>([
  ...BUILTINS.map((b) => b.sig.slice(0, b.sig.indexOf("("))),
  "palette0",
  "palette1",
  "palette2",
  "hash",
]);
// Read-only context globals highlighted as constants.
const CONTEXT_WORDS = new Set(["time", "dt", "frame", "led", "imu", "true", "false"]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function span(cls: string, text: string): string {
  return `<span class="fxhl-${cls}">${escapeHtml(text)}</span>`;
}

/**
 * Tokenize `src` to highlighted HTML. A single left-to-right scan handles line
 * (`//`) and block (`/* *\/`) comments, strings, numbers, identifiers (routed to
 * keyword/type/builtin/context/plain), and passes punctuation/whitespace through
 * escaped. A trailing newline is preserved so the backdrop's last line matches
 * the textarea's height exactly.
 */
export function highlight(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isId = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";

  while (i < n) {
    const c = src[i]!;
    // line comment
    if (c === "/" && src[i + 1] === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      out += span("comment", src.slice(i, j));
      i = j;
      continue;
    }
    // block comment
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out += span("comment", src.slice(i, j));
      i = j;
      continue;
    }
    // string
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      j = Math.min(n, j + 1);
      out += span("str", src.slice(i, j));
      i = j;
      continue;
    }
    // number (incl. leading-dot floats)
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && (isDigit(src[j]!) || src[j] === ".")) {
        // stop at the `..` range operator so `0.0 .. 5.0` splits cleanly
        if (src[j] === "." && src[j + 1] === ".") break;
        j++;
      }
      out += span("num", src.slice(i, j));
      i = j;
      continue;
    }
    // identifier / keyword / type / builtin
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(src[j]!)) j++;
      const word = src.slice(i, j);
      if (KEYWORD_WORDS.has(word)) out += span("kw", word);
      else if (TYPE_WORDS.has(word)) out += span("type", word);
      else if (BUILTIN_WORDS.has(word)) out += span("fn", word);
      else if (CONTEXT_WORDS.has(word)) out += span("ctx", word);
      else out += escapeHtml(word);
      i = j;
      continue;
    }
    // everything else: pass through, escaped
    out += escapeHtml(c);
    i++;
  }
  // Trailing newline keeps the backdrop tall enough to match the textarea.
  if (src.endsWith("\n")) out += "\n";
  return out;
}
