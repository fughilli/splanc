import assert from "node:assert/strict";
import { test } from "node:test";
import { compilerAssetBase } from "../src/effects/editor/workerAssets";

test("effect compiler worker resolves deployment-root assets in Vite dev and production", () => {
  const origin = "https://mac-mini.tail6b8ad3.ts.net:8897";
  assert.equal(compilerAssetBase(`${origin}/src/effects/editor/compile-worker.ts?worker_file&type=module`), `${origin}/fx-compiler`);
  assert.equal(compilerAssetBase(`${origin}/assets/compile-worker-123.js`), `${origin}/fx-compiler`);
  assert.equal(compilerAssetBase(`${origin}/preview/42/src/effects/editor/compile-worker.ts?type=module`), `${origin}/preview/42/fx-compiler`);
  assert.equal(compilerAssetBase(`${origin}/preview/42/assets/compile-worker-123.js`), `${origin}/preview/42/fx-compiler`);
});
