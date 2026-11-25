/**
 * The effect language's vocabulary for the editor: keywords, context idents,
 * built-in function signatures, and types. It is DERIVED from the compiler's
 * reference table (fx_compiler/src/lang.rs, embedded here as lang-table.gen.ts
 * and exported live by the compiler wasm as `fx_language()`), so it can never
 * describe a built-in the compiler doesn't have: //fx_compiler:lang_test fails
 * when the compiler accepts a name with no table entry, when an entry names
 * something the compiler doesn't know, and when lang-table.gen.ts is stale.
 *
 * Consumers: the AI system prompt's tables (system-prompt.ts), the syntax
 * highlighter (highlight.ts) and the autocomplete engine (completions.ts). The
 * full entries (docs, examples, cost hints, related terms) are `LANG`.
 */

import { LANG_TABLE } from "./lang-table.gen";
import type { LangEntry, LangScope } from "./lang-types";

export type { LangEntry, LangKind, LangScope } from "./lang-types";

/** Every reference entry, in the compiler table's order. */
export const LANG: readonly LangEntry[] = LANG_TABLE;

const BY_NAME = new Map<string, LangEntry>(LANG.map((e) => [e.name, e]));

/** The entry for a word (`sin`, `led.pos`, `uniform`), if any. */
export function langEntry(name: string): LangEntry | undefined {
  return BY_NAME.get(name);
}

const ofKind = (kind: LangEntry["kind"]): LangEntry[] => LANG.filter((e) => e.kind === kind);

/** Declaration + control keywords (not the true/false literals), then the type
 * names, as one word list (the highlighter splits types back out via TYPES). */
export const KEYWORDS: readonly string[] = [
  ...ofKind("keyword")
    .filter((e) => e.category !== "literal")
    .map((e) => e.name),
  ...ofKind("type").map((e) => e.name),
];

/** One-line docstrings for the control/declaration keywords, for completion
 * detail (plus `void`). Type-name keywords are documented richly in TYPES. */
export const KEYWORD_DOCS: Record<string, string> = Object.fromEntries([
  ...ofKind("keyword").map((e) => [e.name, e.summary] as const),
  ["void", langEntry("void")?.summary ?? ""] as const,
]);

/**
 * Global read-only contexts and their members (member access via `.`), with
 * the member types the compiler gives them. `time`, `dt`, `frame` are leaf
 * globals (zero members).
 */
export const CONTEXTS: {
  name: string;
  doc: string;
  members: { name: string; type: string; doc: string }[];
}[] = ofKind("context").map((c) => ({
  name: c.name,
  doc: c.summary,
  members: ofKind("member")
    .filter((m) => m.name.startsWith(`${c.name}.`))
    .map((m) => ({ name: m.name.slice(c.name.length + 1), type: m.ty, doc: m.summary })),
}));

/**
 * Built-in functions with signatures (verbatim into the AI prompt; several
 * accepted forms are joined with " / ") and a one-line docstring. Covers every
 * function the compiler accepts except reserved names. `scope` is "driver" for
 * the sensor-driver intrinsics (inert outside poll()) and "update" for the
 * once-per-frame ones.
 */
export const BUILTINS: { sig: string; doc: string; scope: LangScope }[] = ofKind("builtin")
  .filter((b) => b.scope !== "reserved")
  .map((b) => ({ sig: b.sigs.join(" / "), doc: b.summary, scope: b.scope }));

/** Value types accepted by the language, with docstrings for completion. */
export const TYPES: { name: string; doc: string }[] = ofKind("type").map((t) => ({ name: t.name, doc: t.summary }));
