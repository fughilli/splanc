/**
 * web-llm engine host, run in a Web Worker so GPU compile/inference don't stutter
 * the main-thread UI. Bundled from source by Vite's `?worker` (see webllm.ts) —
 * NOT a blob that imports web-llm from a CDN, so it needs no network to start and
 * works offline.
 *
 * Browser/worker-only (uses `self` + the bundled engine); excluded from any use
 * by the node unit tests (nothing requires it there).
 */

import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (m: MessageEvent): void => handler.onmessage(m);
