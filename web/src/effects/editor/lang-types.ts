/**
 * The shape of one effect-language reference entry, as exported by the
 * compiler's table (fx_compiler/src/lang.rs `language_json`, the wasm
 * `fx_language()`, and the generated lang-table.gen.ts).
 */
export type LangKind = "keyword" | "type" | "context" | "member" | "builtin" | "entry" | "annotation" | "syntax";

/** Where an entry may be used: anywhere; update()/init() only; a sensor
 * driver's poll() only; or recognised but reserved (the compiler says what to
 * use instead). */
export type LangScope = "any" | "update" | "driver" | "reserved";

export interface LangEntry {
  /** The word as written (`sin`, `led.pos`), or a short label for syntax. */
  name: string;
  kind: LangKind;
  /** Docs grouping: "math", "vector", "matrix", "colour", "topology", ... */
  category: string;
  scope: LangScope;
  /** Call/declaration forms; for a built-in every accepted signature. */
  sigs: string[];
  /** Value type of a context/member as the compiler types it; "" otherwise. */
  ty: string;
  /** One line, for completions and the AI system prompt. */
  summary: string;
  /** One paragraph, for the Docs pane. */
  doc: string;
  /** A whole program, or a snippet valid inside shade(); compiles warning-free. */
  example: string;
  /** Names of related entries. */
  related: string[];
  /** Cycle-cost hint on the ESP32-C6 (dispatch included); "" when none. */
  cost: string;
  /** A built-in usable in a constant initialiser (`state float x = sin(0.5);`). */
  constant: boolean;
}
