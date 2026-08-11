/**
 * Auto-generate the human-readable FX-VM performance doc (FUG-95) from the
 * golden HITL benchmark bundles, and gate it in CI so the doc can't silently
 * drift from measured hardware performance.
 *
 * This reads every `web/tests/testdata/device-bench-*.json` golden and emits
 * `docs/fx-vm-performance.md`. It reuses the SAME cost model the app and the
 * hardware-validation test use as the single source of truth:
 *   - `parseDeviceBundle` + `buildDeviceProfile` (deviceProfile.ts) fit the
 *     per-opcode cost table from the measured micro-programs, then validate it
 *     against the held-out programs (profileValidation.ts);
 *   - `builtinCostsToPrompt` (perfContext.ts) renders the per-builtin cost
 *     ranking the effects-AI is fed.
 * So the doc is a rendering of the exact numbers CI already enforces — it is
 * never hand-maintained, and a VM/cost-model/golden change that moves the
 * numbers forces a re-pin (see the `--check` mode + the Bazel freshness test).
 *
 * Modeled on the `//web:fit_device_profile` node CLI target. Designed for N
 * platforms; only `esp32c6` exists today.
 *
 *   # regenerate the checked-in doc in place:
 *   bazel run //web:gen_fx_vm_perf_doc
 *
 *   # CI freshness gate (fails if the checked-in doc is stale):
 *   <gen> --check --out docs/fx-vm-performance.md <bundle.json>...
 *
 * Determinism is the top requirement: no timestamps, no absolute paths, stable
 * sort, fixed float formatting, and prettier-canonical table layout with prose
 * wrapped to <=100 columns, so regeneration is byte-stable and the output is a
 * fixed point of prettier + markdownlint (it is NOT formatter-ignored).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseDeviceBundle, buildDeviceProfile } from "../../src/effects/deviceProfile";
import { profileToCostTable } from "../../src/effects/executionProfile";
import { builtinCostsToPrompt } from "../../src/effects/perfContext";
import { DEFAULT_COSTS } from "../../src/store/costTableStore";

/** The tightest tolerance the current linear model meets on the golden held-out
 * spread — the same bar deviceProfileHardware.test.ts gates at. */
const TOLERANCE = 0.13;

/** Programs whose held-out |error| exceeds this fraction are called out as
 * outliers in the accuracy section. */
const OUTLIER_BAND = 0.1;

const DOC_REL_PATH = "docs/fx-vm-performance.md";
const BUNDLE_GLOB_DIR = "web/tests/testdata";
const BUNDLE_PREFIX = "device-bench-";
const REGEN_CMD = "bazel run //web:gen_fx_vm_perf_doc";

// -- formatting helpers ------------------------------------------------------

/** Fixed-precision percent from a fraction (e.g. 0.099 -> "9.9%"). */
function pct(frac: number, digits = 1): string {
  return `${(frac * 100).toFixed(digits)}%`;
}

/** Signed fixed-precision percent (e.g. -0.031 -> "-3.1%"). */
function signedPct(frac: number, digits = 1): string {
  const v = frac * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Cycles -> nanoseconds at a given clock. */
function cyclesToNs(cycles: number, cpuHz: number): number {
  return cpuHz > 0 ? (cycles / cpuHz) * 1e9 : 0;
}

/** Compact millions form for large cycle counts (e.g. 974524 -> "0.97M"). */
function millions(cycles: number): string {
  return `${(cycles / 1e6).toFixed(2)}M`;
}

/**
 * Render a GitHub-flavored Markdown table in prettier's canonical layout
 * (left-aligned, columns padded to the widest cell, `---` separators) so the
 * emitted doc is already a fixed point of prettier — no post-format reflow.
 * All cells are ASCII / single-column BMP characters, so `.length` is the
 * display width prettier uses.
 */
/** Greedy word-wrap a prose paragraph to <=`width` columns (default 100), so
 * every non-table/non-code line satisfies markdownlint MD013. A single newline
 * renders as a space in GFM, so this reads as one paragraph, and prettier's
 * default `proseWrap: preserve` leaves the wrap untouched (byte-stable). */
function wrapProse(s: string, width = 100): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    if (cur === "") cur = word;
    else if (`${cur} ${word}`.length <= width) cur = `${cur} ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

function mdTable(headers: string[], rows: string[][]): string {
  const cols = headers.length;
  const width: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = Math.max(3, headers[c]!.length);
    for (const row of rows) w = Math.max(w, (row[c] ?? "").length);
    width.push(w);
  }
  const line = (cells: string[]): string =>
    "| " + cells.map((cell, c) => (cell ?? "").padEnd(width[c]!)).join(" | ") + " |";
  const sep = "| " + width.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [line(headers), sep, ...rows.map((r) => line(r))].join("\n");
}

// -- one platform section ----------------------------------------------------

interface PlatformDoc {
  soc: string;
  deviceKey: string;
  section: string;
  /** Summary-table row for the top-level platform index. */
  summaryRow: string[];
}

/** Regression margins the HITL fx_bench check reads (parseDeviceBundle drops
 * them; we read the raw JSON so the doc records the enforced gate). */
interface FxBenchMargins {
  default: number;
  perLabel: Record<string, number>;
}

function renderPlatform(rawJson: string): PlatformDoc {
  const bundle = parseDeviceBundle(rawJson);
  const { profile, validation, table } = buildDeviceProfile(bundle, TOLERANCE);
  const cpuHz = profile.cpuHz;
  const mhz = (cpuHz / 1e6).toFixed(0);
  const label = profile.deviceLabel || profile.soc;
  const deviceKey = profile.deviceKey ?? profile.soc;

  const raw = JSON.parse(rawJson) as { fxBenchMargins?: FxBenchMargins };
  const margins = raw.fxBenchMargins;

  const verdict = validation.passed ? "PASS" : "FAIL";

  const out: string[] = [];
  out.push(`## ${profile.soc} — ${label}`);
  out.push("");

  // --- summary ---
  const marginText = margins
    ? [
        `default ${pct(margins.default, 0)}`,
        ...Object.entries(margins.perLabel)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${k} ${pct(v, 0)}`),
      ].join(", ")
    : "n/a";
  out.push(
    mdTable(
      ["Field", "Value"],
      [
        ["SoC", profile.soc],
        ["Device", label],
        ["deviceKey", deviceKey],
        ["CPU clock", `${mhz} MHz (${cpuHz.toLocaleString("en-US")} Hz)`],
        ["Programs", `${bundle.fit.length} fit + ${bundle.heldout.length} held-out`],
        ["Regression margins", marginText],
        ["Fit residual", `±${pct(profile.residualError)}`],
        [
          "Held-out accuracy",
          `RMS ${pct(validation.rmsError)} · mean ${pct(validation.meanAbsError)} · max ${pct(
            validation.maxAbsError,
          )} · R² ${validation.r2.toFixed(3)}`,
        ],
        ["Verdict", `${verdict} (RMS ${pct(validation.rmsError)} vs ${pct(TOLERANCE, 0)} tolerance)`],
      ],
    ),
  );
  out.push("");

  // --- fixed overheads ---
  out.push("### Fixed overheads");
  out.push("");
  out.push("Per-phase framing costs the fit isolates from the per-opcode slopes.");
  out.push("");
  const fixedRows: [string, number][] = [
    ["update_fixed", table.fixed.update_fixed],
    ["shade_fixed", table.fixed.shade_fixed],
    ["show_fixed", table.fixed.show_fixed],
    ["show_per_led", table.fixed.show_per_led],
  ];
  out.push(
    mdTable(
      ["Overhead", "Cycles", "ns"],
      fixedRows.map(([name, cyc]) => [
        name,
        cyc.toFixed(1),
        cyclesToNs(cyc, cpuHz).toFixed(1),
      ]),
    ),
  );
  out.push("");

  // --- fitted per-opcode cost ---
  out.push("### Fitted per-opcode cost");
  out.push("");
  out.push(
    "Per-lane opcode cost from the least-squares fit. **Fitted** rows were measured on this",
  );
  out.push(
    "device; the rest keep the shipped default seed (the fit only overrides opcodes a",
  );
  out.push("benchmark actually exercised). Sorted by cost.");
  out.push("");
  const opRows = Object.keys(DEFAULT_COSTS)
    .map((op) => {
      const cost = table.costs[op] ?? DEFAULT_COSTS[op]!;
      const fitted = table.costs[op] !== undefined && table.costs[op] !== DEFAULT_COSTS[op];
      return { op, cost, fitted };
    })
    .sort((a, b) => b.cost - a.cost || (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));
  out.push(
    mdTable(
      ["Opcode", "Cycles", "ns", "Fitted"],
      opRows.map((r) => [
        r.op,
        r.cost.toFixed(2),
        cyclesToNs(r.cost, cpuHz).toFixed(2),
        r.fitted ? "yes" : "",
      ]),
    ),
  );
  out.push("");

  // --- builtin ranking (reuses the effects-AI prompt renderer) ---
  out.push("### Builtin costs (effects-AI ranking)");
  out.push("");
  out.push("Rendered verbatim from `builtinCostsToPrompt` — the per-builtin ranking the");
  out.push("in-editor AI is fed, relative to a float multiply (each runs once per LED in");
  out.push("`shade()`):");
  out.push("");
  out.push("```text");
  out.push(builtinCostsToPrompt(table, true));
  out.push("```");
  out.push("");

  // --- estimator accuracy (held-out predicted vs measured) ---
  out.push("### Estimator accuracy (held-out)");
  out.push("");
  out.push(
    "Predicted-vs-measured total frame time (FX-VM frame + LED transmit) for the held-out",
  );
  out.push(
    "programs the fit never saw. Cycles are the wall-time re-expressed at the device clock.",
  );
  out.push("");
  out.push(
    mdTable(
      ["Program", "LEDs", "Measured (ms)", "Predicted (ms)", "Error", "Measured cyc", "Predicted cyc"],
      validation.samples.map((s) => [
        s.label,
        String(s.ledCount),
        s.measuredMs.toFixed(2),
        s.predictedMs.toFixed(2),
        signedPct(s.relError),
        millions((s.measuredMs / 1000) * cpuHz),
        millions((s.predictedMs / 1000) * cpuHz),
      ]),
    ),
  );
  out.push("");
  out.push(
    ...wrapProse(
      `Held-out **RMS ${pct(validation.rmsError)}**, mean ${pct(validation.meanAbsError)}, max ${pct(
        validation.maxAbsError,
      )} against the **${pct(TOLERANCE, 0)}** tolerance — **${verdict}**.`,
    ),
  );
  const outliers = validation.samples
    .filter((s) => s.absRelError > OUTLIER_BAND)
    .sort((a, b) => b.absRelError - a.absRelError);
  out.push("");
  if (outliers.length > 0) {
    out.push(
      ...wrapProse(
        `Outliers (|error| > ${pct(OUTLIER_BAND, 0)}): ` +
          outliers.map((s) => `\`${s.label}\` ${signedPct(s.relError)}`).join(", ") +
          ". The linear sum-of-op-costs model over-predicts the cheapest real effects.",
      ),
    );
  } else {
    out.push(`No held-out program exceeds ${pct(OUTLIER_BAND, 0)} error.`);
  }
  out.push("");

  // --- raw measured costs ---
  out.push("### Raw measured costs");
  out.push("");
  out.push(
    "Every measured micro-program from the golden bundle: cycle-accurate frame cycles",
  );
  out.push(
    "(the FX-VM execution cost, which the regression gate compares) and show cycles (the",
  );
  out.push("LED transmit path, excluded from the gate as transmit-bound noise).");
  out.push("");
  const rawRows = [
    ...bundle.fit.map((s) => ({ s, set: "fit" })),
    ...bundle.heldout.map((s) => ({ s, set: "held-out" })),
  ];
  out.push(
    mdTable(
      ["Program", "Set", "LEDs", "Frame cycles", "Show cycles"],
      rawRows.map(({ s, set }) => [
        s.label,
        set,
        String(s.ledCount),
        s.measuredFrameCycles.toLocaleString("en-US"),
        s.measuredShowCycles.toLocaleString("en-US"),
      ]),
    ),
  );

  return {
    soc: profile.soc,
    deviceKey,
    section: out.join("\n"),
    summaryRow: [
      profile.soc,
      label,
      mhz,
      String(bundle.fit.length),
      String(bundle.heldout.length),
      pct(validation.rmsError),
      pct(validation.maxAbsError),
      pct(TOLERANCE, 0),
      verdict,
    ],
  };
}

// -- whole document ----------------------------------------------------------

function renderDoc(bundlePaths: string[]): string {
  const platforms = bundlePaths
    .map((p) => renderPlatform(fs.readFileSync(p, "utf8")))
    .sort((a, b) =>
      a.soc < b.soc ? -1 : a.soc > b.soc ? 1 : a.deviceKey < b.deviceKey ? -1 : a.deviceKey > b.deviceKey ? 1 : 0,
    );

  const doc: string[] = [];
  doc.push("<!-- Generated by web/tests/tools/genFxVmPerfDoc.ts. DO NOT EDIT BY HAND. -->");
  doc.push("");
  doc.push("# FX-VM performance");
  doc.push("");
  doc.push(
    "Measured FX-VM performance across hardware platforms, fitted from the golden HITL",
  );
  doc.push(
    "benchmark bundles (`web/tests/testdata/device-bench-*.json`) captured on real devices",
  );
  doc.push(
    "over the rig. This file is **auto-generated** and pinned by CI — regenerate it with:",
  );
  doc.push("");
  doc.push("```sh");
  doc.push(REGEN_CMD);
  doc.push("```");
  doc.push("");
  doc.push(
    "The numbers come from the same cost model the app and CI use: `buildDeviceProfile`",
  );
  doc.push(
    "(`web/src/effects/deviceProfile.ts`) fits the per-opcode table and validates it against",
  );
  doc.push(
    "held-out programs (`profileValidation.ts`), gated at the same tolerance as",
  );
  doc.push(
    "`web/tests/deviceProfileHardware.test.ts`. See",
  );
  doc.push(
    "[`docs/design/perf-monitoring.md`](./design/perf-monitoring.md) for the methodology and",
  );
  doc.push("[`EFFECTS.md`](../EFFECTS.md#performance-on-the-esp32-c6) for the narrative.");
  doc.push("");
  doc.push("## Platforms");
  doc.push("");
  doc.push(
    mdTable(
      ["SoC", "Device", "MHz", "Fit", "Held-out", "RMS", "Max", "Tolerance", "Verdict"],
      platforms.map((p) => p.summaryRow),
    ),
  );
  doc.push("");
  for (const p of platforms) {
    doc.push(p.section);
    doc.push("");
  }

  // Single trailing newline (MD047); collapse any accidental blank-line runs.
  return doc.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "") + "\n";
}

// -- CLI ---------------------------------------------------------------------

/** Resolve the bundle golden paths + output path from argv, defaulting to the
 * in-tree layout under $BUILD_WORKSPACE_DIRECTORY when run via `bazel run`. */
function resolveArgs(argv: string[]): { check: boolean; outPath: string; bundles: string[] } {
  let check = false;
  let outPath = "";
  const bundles: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--check") check = true;
    else if (a === "--out") outPath = argv[++i]!;
    else bundles.push(a);
  }

  const ws = process.env["BUILD_WORKSPACE_DIRECTORY"];
  if (!outPath) {
    if (!ws) throw new Error("no --out and no BUILD_WORKSPACE_DIRECTORY; pass --out <path>");
    outPath = path.join(ws, DOC_REL_PATH);
  }
  if (bundles.length === 0) {
    if (!ws) throw new Error("no bundle paths and no BUILD_WORKSPACE_DIRECTORY");
    const dir = path.join(ws, BUNDLE_GLOB_DIR);
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.startsWith(BUNDLE_PREFIX) && f.endsWith(".json")) bundles.push(path.join(dir, f));
    }
  }
  // Stable order regardless of how the bundles were supplied.
  bundles.sort();
  return { check, outPath, bundles };
}

function main(): number {
  const { check, outPath, bundles } = resolveArgs(process.argv.slice(2));
  if (bundles.length === 0) {
    process.stderr.write("no device-bench-*.json goldens found\n");
    return 2;
  }
  const doc = renderDoc(bundles);

  if (check) {
    const actual = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (actual !== doc) {
      process.stderr.write(
        `STALE: ${DOC_REL_PATH} is out of date with the golden benchmark bundles.\n` +
          `Run \`${REGEN_CMD}\` to regenerate it.\n`,
      );
      return 1;
    }
    process.stderr.write(`${DOC_REL_PATH} is up to date.\n`);
    return 0;
  }

  fs.writeFileSync(outPath, doc);
  process.stderr.write(`wrote ${DOC_REL_PATH} (${bundles.length} platform(s))\n`);
  return 0;
}

process.exit(main());
