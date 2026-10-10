/** Vite serves the source worker under src/effects/editor in development,
 * and emits it under assets in production. Both load runtime WASM bundles
 * from the deployment root, including deployments under a URL subpath. */
export function compilerAssetBase(workerUrl: string): string {
  const url = new URL(workerUrl);
  const sourceWorker = url.pathname.endsWith("/src/effects/editor/compile-worker.ts");
  return new URL(sourceWorker ? "../../../fx-compiler" : "../fx-compiler", url).href.replace(/\/+$/, "");
}
