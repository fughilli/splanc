// Side-effect CSS imports (the kit tokens + app shell styles) — Vite bundles
// these; tsc just needs them declared as modules so the imports type-check.
declare module "*.css";

// Git build info injected by Vite's `define` at bundle time (see vite.config.ts
// and src/buildInfo.ts). Absent in the unit-test compile, where buildInfo.ts
// falls back via `typeof __BUILD_INFO__` — hence declared, not defined.
declare const __BUILD_INFO__: {
  gitCommit: string;
  gitCommitShort: string;
  gitDirty: boolean;
};
