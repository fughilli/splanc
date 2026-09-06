// Side-effect CSS imports (the kit tokens + app shell styles) — Vite bundles
// these; tsc just needs them declared as modules so the imports type-check.
declare module "*.css";

// Vite `?url` asset imports resolve to the emitted asset's URL string (used to
// bundle wllama's .wasm as an app-origin asset — see providers/wllama.ts).
declare module "*?url" {
  const src: string;
  export default src;
}

// @wllama/wllama ships no type declarations map; the provider casts the dynamic
// import to its own minimal interface, so an untyped ambient module is enough to
// let tsc resolve the bundled import (Vite resolves the real package).
declare module "@wllama/wllama/esm/index.js";

// Git build info injected by Vite's `define` at bundle time (see vite.config.ts
// and src/buildInfo.ts). Absent in the unit-test compile, where buildInfo.ts
// falls back via `typeof __BUILD_INFO__` — hence declared, not defined.
declare const __BUILD_INFO__: {
  gitCommit: string;
  gitCommitShort: string;
  gitDirty: boolean;
};
