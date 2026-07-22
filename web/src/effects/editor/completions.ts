/**
 * Autocomplete engine for the in-app effect editor. Pure, DOM-free: given the
 * source text and the caret offset it returns a ranked list of completion items
 * plus the offset the replacement should start from. The editor screen
 * (effectEditor.ts) renders these in a floating popup with docstrings.
 *
 * The vocabulary is derived entirely from lang-spec.ts (the single source of
 * truth mirrored from the AUTHORITATIVE compiler), plus a light regex scan of
 * the current source for the program's own uniforms, state, params and locals.
 *
 * Three contexts, in priority order:
 *   1. `led.` / `imu.` before the caret  → that context's members.
 *   2. `<expr>.`  (a `.` after something that isn't led/imu) → vector swizzles.
 *   3. an identifier prefix in code position → built-ins, types, keywords,
 *      context roots, true/false, and the program's declared names.
 */

import { BUILTINS, CONTEXTS, KEYWORD_DOCS, TYPES } from "./lang-spec";

export type CompletionKind =
  | "member"
  | "func"
  | "type"
  | "keyword"
  | "context"
  | "uniform"
  | "state"
  | "swizzle";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** Short right-aligned detail: a signature (functions) or a type (values). */
  detail: string;
  doc: string;
  /** Text to splice in when accepted (functions add "(" ; others = label). */
  insertText: string;
}

export interface CompletionResult {
  items: CompletionItem[];
  /** Source offset the replacement starts at (start of the token being typed). */
  from: number;
}

const CONTROL_KEYWORDS = ["if", "else", "for", "return", "uniform", "state"];
const SWIZZLE_COMPONENTS = ["x", "y", "z", "w", "r", "g", "b", "a"];

function funcName(sig: string): string {
  return sig.slice(0, sig.indexOf("("));
}

/** Contexts that expose members via `.` (led/imu). */
const MEMBER_CONTEXTS = new Map(CONTEXTS.filter((c) => c.members.length > 0).map((c) => [c.name, c]));

/**
 * Scan the source for the program's own declared names: `uniform <ty> <name>`,
 * `state <ty> <name>`, `shade(Led <name>)` params and `<ty> <name> =` locals. A
 * light regex pass is intentional — the caret's true scope isn't tracked; we
 * simply offer every name declared anywhere, which is friendly for a small DSL.
 */
function scanDeclarations(source: string): CompletionItem[] {
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: CompletionKind, detail: string, doc: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ label: name, kind, detail, doc, insertText: name });
  };

  const TYPE = "(?:float|int|fixed|bool|vec2|vec3|vec4)";
  for (const m of source.matchAll(new RegExp(`\\buniform\\s+(${TYPE})\\s+([A-Za-z_]\\w*)`, "g"))) {
    add(m[2]!, "uniform", m[1]!, "declared uniform");
  }
  for (const m of source.matchAll(new RegExp(`\\bstate\\s+(${TYPE})\\s+([A-Za-z_]\\w*)`, "g"))) {
    add(m[2]!, "state", m[1]!, "declared state");
  }
  // Function params, e.g. `shade(Led led)` — capture `<Type> <name>` pairs.
  for (const m of source.matchAll(/\(\s*(Led|[A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\)/g)) {
    add(m[2]!, "uniform", m[1]!, "parameter");
  }
  // Locals: `<ty> <name> =` (not preceded by uniform/state, which are handled).
  for (const m of source.matchAll(new RegExp(`\\b(${TYPE})\\s+([A-Za-z_]\\w*)\\s*=`, "g"))) {
    add(m[2]!, "uniform", m[1]!, "local variable");
  }
  return out;
}

/** Built-in vocabulary offered in code position (before local names). */
function vocabulary(): CompletionItem[] {
  const out: CompletionItem[] = [];
  for (const b of BUILTINS) {
    out.push({ label: funcName(b.sig), kind: "func", detail: b.sig, doc: b.doc, insertText: funcName(b.sig) });
  }
  for (const t of TYPES) {
    out.push({ label: t.name, kind: "type", detail: "type", doc: t.doc, insertText: t.name });
  }
  for (const k of CONTROL_KEYWORDS) {
    out.push({ label: k, kind: "keyword", detail: "keyword", doc: KEYWORD_DOCS[k] ?? "", insertText: k });
  }
  for (const c of CONTEXTS) {
    out.push({ label: c.name, kind: "context", detail: "global", doc: c.doc, insertText: c.name });
  }
  out.push({ label: "true", kind: "keyword", detail: "bool", doc: "boolean true", insertText: "true" });
  out.push({ label: "false", kind: "keyword", detail: "bool", doc: "boolean false", insertText: "false" });
  return out;
}

/** Rank: exact match first, then prefix, then substring; ties keep list order
 * (built-ins/members precede locals because they're concatenated first). */
function rankAndFilter(items: CompletionItem[], prefix: string): CompletionItem[] {
  if (prefix === "") return items.slice(0, 60);
  const p = prefix.toLowerCase();
  const scored: { it: CompletionItem; score: number; idx: number }[] = [];
  items.forEach((it, idx) => {
    const l = it.label.toLowerCase();
    let score: number;
    if (l === p) score = 0;
    else if (l.startsWith(p)) score = 1;
    else if (l.includes(p)) score = 2;
    else return;
    scored.push({ it, score, idx });
  });
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.slice(0, 60).map((s) => s.it);
}

/**
 * Compute completions for `source` at `caret` (a character offset). Returns an
 * empty item list when nothing applies (the caller hides the popup).
 */
export function complete(source: string, caret: number): CompletionResult {
  const before = source.slice(0, caret);

  // (1) `led.` / `imu.` member access.
  const memberMatch = /(\b\w+)\.(\w*)$/.exec(before);
  if (memberMatch) {
    const root = memberMatch[1]!;
    const partial = memberMatch[2]!;
    const ctx = MEMBER_CONTEXTS.get(root);
    if (ctx) {
      const items: CompletionItem[] = ctx.members.map((m) => ({
        label: m.name,
        kind: "member" as const,
        detail: m.type,
        doc: m.doc,
        insertText: m.name,
      }));
      return { items: rankAndFilter(items, partial), from: caret - partial.length };
    }
    // (2) `.` after any other identifier/expression → swizzles.
    const items: CompletionItem[] = SWIZZLE_COMPONENTS.map((c) => ({
      label: c,
      kind: "swizzle" as const,
      detail: "swizzle",
      doc: "vector swizzle",
      insertText: c,
    }));
    return { items: rankAndFilter(items, partial), from: caret - partial.length };
  }

  // A `.` right after a `)` or `]` (an expression, not a bare identifier) also
  // yields swizzles.
  const exprSwizzle = /[)\]]\.(\w*)$/.exec(before);
  if (exprSwizzle) {
    const partial = exprSwizzle[1]!;
    const items: CompletionItem[] = SWIZZLE_COMPONENTS.map((c) => ({
      label: c,
      kind: "swizzle" as const,
      detail: "swizzle",
      doc: "vector swizzle",
      insertText: c,
    }));
    return { items: rankAndFilter(items, partial), from: caret - partial.length };
  }

  // (3) identifier prefix in code position.
  const idMatch = /(\w+)$/.exec(before);
  if (!idMatch) return { items: [], from: caret };
  const prefix = idMatch[1]!;
  // Don't complete numeric literals.
  if (/^\d/.test(prefix)) return { items: [], from: caret };

  const items = [...vocabulary(), ...scanDeclarations(source)];
  // De-dupe by label, keeping the first (built-ins win over rescanned names).
  const seen = new Set<string>();
  const deduped = items.filter((it) => (seen.has(it.label) ? false : (seen.add(it.label), true)));
  return { items: rankAndFilter(deduped, prefix), from: caret - prefix.length };
}
