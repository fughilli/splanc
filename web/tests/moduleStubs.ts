/**
 * Test-only stand-ins for the imports a bundler (Vite) resolves but plain Node
 * can't, so node:test can load — and drive — the modules that use them:
 *
 *   - Vite asset suffixes: `…?url` (wllama's .wasm, bundled as an app-origin
 *     asset) resolves to a URL string and `…?worker` (the web-llm engine host) to
 *     a Worker constructor ({@link FakeWorker});
 *   - lazily `import()`-ed engines / wasm packages that are not in the test
 *     build's node_modules (`@wllama/wllama/esm/index.js`, `@mlc-ai/web-llm`, the
 *     fx_compiler / fx_vm wasm-bindgen packages): a suite registers a fake for the
 *     ones it drives with {@link stubModule}.
 *
 * It wraps the CommonJS loader's `Module.prototype.require` (the test build is
 * CJS — see tsconfig.test.json; a dynamic `import(x)` compiles to `require(x)`),
 * so IMPORT THIS MODULE FIRST, before anything that needs a stub is required.
 * Every test file runs in its own process, so one suite's stubs never leak into
 * another's. Production code is untouched: only what `require` returns changes.
 */

import Module from "node:module";

type Matcher = (id: string) => boolean;

const stubs: { match: Matcher; exports: unknown }[] = [];

/**
 * Serve `exports` for every `require(id)` whose specifier matches (an exact
 * string, a RegExp, or a predicate). The most recent registration wins.
 */
export function stubModule(match: string | RegExp | Matcher, exports: unknown): void {
  const m: Matcher =
    typeof match === "string"
      ? (id) => id === match
      : match instanceof RegExp
        ? (id) => match.test(id)
        : match;
  stubs.unshift({ match: m, exports });
}

/** Worker stand-in for a Vite `?worker` import: records construction/termination. */
export class FakeWorker {
  static readonly created: FakeWorker[] = [];
  terminated = false;
  constructor() {
    FakeWorker.created.push(this);
  }
  terminate(): void {
    this.terminated = true;
  }
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** What a Vite `?url` import resolves to under this shim. */
export const STUB_ASSET_URL = "app-asset://bundled";

stubModule(/\?url$/, STUB_ASSET_URL);
stubModule(/\?worker$/, FakeWorker);

const proto = (Module as unknown as { prototype: { require(this: unknown, id: string): unknown } })
  .prototype;
const originalRequire = proto.require;
proto.require = function (this: unknown, id: string): unknown {
  for (const s of stubs) if (s.match(id)) return s.exports;
  return originalRequire.call(this, id);
};
