/**
 * Bundles the bridge for Node, every npm dependency inlined (so the release
 * bundle needs no `npm install`). Two modes:
 *
 *   vite build --mode mcp    dist-mcp/splanc-agent.mjs — ONE self-contained file
 *   vite build --mode test   dist-test/tests/*.test.mjs — one runnable bundle per
 *                            tests/*.test.ts, for node:test
 *
 * The web app's protocol/effects modules are pulled in by relative import.
 *
 * `virtual:stage-view` is the demo stage's browser code (src/stage/view.ts: the
 * app's 3D map view), built here as one minified script and imported as text,
 * so the stage server can serve it with no extra file in the bundle.
 */

import { readdirSync } from "node:fs";

import { build, defineConfig, type Plugin } from "vite";

const STAGE_VIEW = "virtual:stage-view";

function stageView(): Plugin {
  return {
    name: "stage-view",
    resolveId: (id) => (id === STAGE_VIEW ? `\0${STAGE_VIEW}` : null),
    async load(id) {
      if (id !== `\0${STAGE_VIEW}`) return null;
      const out = await build({
        configFile: false,
        logLevel: "warn",
        build: {
          write: false,
          minify: true,
          target: "es2020",
          lib: { entry: "src/stage/view.ts", formats: ["iife"], name: "SplancStageView", fileName: () => "view.js" },
        },
      });
      const outputs = (Array.isArray(out) ? out : [out]) as { output: { type: string; code?: string }[] }[];
      const code = outputs.flatMap((o) => o.output).find((c) => c.type === "chunk")?.code;
      if (!code) throw new Error("stage view: no output");
      return `export default ${JSON.stringify(code)};`;
    },
  };
}

export default defineConfig(({ mode }) => {
  const test = mode === "test";
  // AGENT_TEST_ENTRY=<name>.test.ts builds just that test, as one file in
  // dist-test/<name>/ (Bazel: one action per test, each with a known output).
  const one = process.env["AGENT_TEST_ENTRY"];
  const input = !test
    ? { "splanc-agent": "src/cli.ts" }
    : one
      ? { [one.replace(/\.ts$/, "")]: `tests/${one}` }
      : Object.fromEntries(
          readdirSync("tests")
            .filter((f) => f.endsWith(".test.ts"))
            .map((f) => [`tests/${f.replace(/\.ts$/, "")}`, `tests/${f}`]),
        );
  const single = !test || one !== undefined;
  return {
    plugins: [stageView()],
    build: {
      ssr: true,
      target: "node20",
      outDir: !test ? "dist-mcp" : one ? `dist-test/${one.replace(/\.test\.ts$/, "")}` : "dist-test",
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        input,
        output: {
          format: "es",
          entryFileNames: "[name].mjs",
          chunkFileNames: "chunks/[name]-[hash].mjs",
          ...(single ? { inlineDynamicImports: true } : {}),
          // The bundle's npm bin (`npx -y <tgz>` runs it directly).
          ...(!test ? { banner: "#!/usr/bin/env node" } : {}),
        },
      },
    },
    ssr: { noExternal: true, target: "node" },
  };
});
