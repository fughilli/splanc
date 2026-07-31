/**
 * Vite config — two entry pages:
 *   /            the phone capture app (M5–M8)
 *   /wall.html   the virtual LED wall (laptop test fixture)
 *
 * Dev mode (`pnpm --dir web dev`) proxies the control plane + map routes to a
 * locally running M2 server so the whole flow works against `vite dev`:
 *     bazelisk run //pi/server:serve -- --port 8080 ...
 * Production serving is the M2 server with --web-root pointed at dist/
 * (`bazelisk run //web:serve`).
 */

import { defineConfig } from "vite";

const backend = process.env["LEDMAPPER_BACKEND"] ?? "http://localhost:8080";

export default defineConfig({
  // Relative base so ONE built bundle works whether it's served from an origin
  // root (the Pi M2 server, Cloudflare ledmapper.pages.dev) OR from a subpath
  // (GitHub Pages project site https://fughilli.github.io/splanc/ and its
  // per-PR previews under /pr-preview/pr-N/). Vite rewrites its own injected
  // entry/asset URLs relative to each HTML file; the hand-written public-asset
  // and wasm-bundle references are resolved against the document at runtime
  // (see index.html, src/assetBase.ts, public/sw.js, public/manifest.webmanifest).
  base: "./",
  build: {
    rollupOptions: {
      // Relative to the vite root (this directory). MUST stay relative:
      // absolute paths get realpath'd through the Bazel sandbox symlinks and
      // break the emitted-asset naming (paths escaping the root).
      input: {
        index: "index.html",
        wall: "wall.html",
        effects: "effects.html",
      },
    },
  },
  server: {
    host: true,
    proxy: {
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
      "/maps": backend,
      "/healthz": backend,
      "/solver": backend, // wasm solver bundle (served from server runfiles)
      "/pulse": backend, // wasm effects Sim (effects.html workspace)
      "/fx-compiler": backend, // wasm effects compiler (in-shell effect editor)
      "/fx-vm": backend, // wasm effects preview VM (in-shell effect editor)
    },
  },
});
