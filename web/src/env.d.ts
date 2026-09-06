// Side-effect CSS imports (the kit tokens + app shell styles) — Vite bundles
// these; tsc just needs them declared as modules so the imports type-check.
declare module "*.css";

// Vite `?url` asset imports resolve to the emitted asset's URL string (used to
// bundle wllama's .wasm as an app-origin asset — see providers/wllama.ts).
declare module "*?url" {
  const src: string;
  export default src;
}

// Vite `?worker` imports resolve to a Worker constructor for the bundled module
// (used to bundle the web-llm engine host — see providers/webllm.ts).
declare module "*?worker" {
  const WorkerFactory: { new (): Worker };
  export default WorkerFactory;
}

// @wllama/wllama and @mlc-ai/web-llm are imported (dynamically / in a worker) but
// their type maps aren't resolved by tsc here; the providers cast to their own
// minimal interfaces, so untyped ambient modules are enough to let tsc resolve
// the bundled imports (Vite resolves the real packages).
declare module "@wllama/wllama/esm/index.js";
declare module "@mlc-ai/web-llm";

// Git build info injected by Vite's `define` at bundle time (see vite.config.ts
// and src/buildInfo.ts). Absent in the unit-test compile, where buildInfo.ts
// falls back via `typeof __BUILD_INFO__` — hence declared, not defined.
declare const __BUILD_INFO__: {
  gitCommit: string;
  gitCommitShort: string;
  gitDirty: boolean;
};
