/**
 * Mapping-link throughput benchmark (#448).
 *
 *   bazel run //web:link_bench                              # simulated suite, all policies
 *   bazel run //web:link_bench -- --policy baseline --json /tmp/base.json
 *   bazel run //web:link_bench -- --baseline /tmp/base.json # compare vs a saved run
 *   bazel run //web:link_bench -- capture.splanc-capture.json [...]
 *
 * With capture bundles (v2+, from Settings ▸ Debugging ▸ Export, or the
 * moving-camera HITL rig) it reports each bundle's recorded link telemetry:
 * time to decode coverage, decoded-ID error signals, dropouts, the negotiated
 * symbols / bit period and the selected exposure. v1 bundles predate the
 * telemetry and are listed as such.
 *
 * Without bundles it runs the moving-camera simulator (tests/linkSim.ts) over
 * the standard scenario suite for each policy (seeded, deterministic) and
 * compares every candidate against `baseline` — the production negotiation —
 * with a correctness-first verdict (cv/linkReport.ts compareReports): any rise
 * in the wrong-ID rate or a config under 3 camera frames per bit is UNSAFE,
 * whatever it does for speed.
 *
 * Flags: --policy <name> (repeatable), --scenario <name> (repeatable),
 * --leds N (default 120), --seeds N (default 3), --json <out>,
 * --baseline <json from an earlier --json run>, --coverage-of N (bundles).
 * Exit status 3 when any compared candidate is unsafe.
 */

import * as fs from "node:fs";
import { linkReport, compareReports, formatReport, type LinkReport } from "../../src/cv/linkReport";
import type { LinkTelemetrySnapshot } from "../../src/cv/linkTelemetry";
import { BASELINE_POLICY, runLinkSim, standardScenarios, type LinkPolicy } from "../linkSim";

/** Candidate tunings the suite measures against the baseline. */
export const POLICIES: LinkPolicy[] = [
  BASELINE_POLICY,
  // Conservative fallback: the robust red/blue alphabet only.
  { ...BASELINE_POLICY, name: "sym2-only", symbols: 2 },
  // Always 4 symbols (no fallback) — what "less conservative" would mean naively.
  { ...BASELINE_POLICY, name: "sym4-only", symbols: 4 },
  // Upgrade 2 → 4 on a lower measured margin.
  { ...BASELINE_POLICY, name: "upgrade-0.55", upgradeMargin: 0.55 },
  // Let the measured margin alone upgrade 2 → 4 in a dark room (the luma
  // gate otherwise pins dark rooms to 2 symbols for the whole run).
  { ...BASELINE_POLICY, name: "upgrade-dark", upgradeMinLuma: 0 },
  // Start the exposure servo longer (fewer dim first seconds).
  { ...BASELINE_POLICY, name: "exp-start-0.5", exposureStart: 0.5 },
  // Faster signaling than the timing constraint allows (expected UNSAFE).
  { ...BASELINE_POLICY, name: "bit-60ms", bitPeriodMs: 60 },
];

interface Args {
  bundles: string[];
  policies: string[];
  scenarios: string[];
  leds: number;
  seeds: number;
  json: string | null;
  baseline: string | null;
  coverageOf: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { bundles: [], policies: [], scenarios: [], leds: 120, seeds: 3, json: null, baseline: null, coverageOf: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    const next = (): string => {
      const n = argv[++i];
      if (n === undefined) throw new Error(`${v} needs a value`);
      return n;
    };
    if (v === "--policy") a.policies.push(next());
    else if (v === "--scenario") a.scenarios.push(next());
    else if (v === "--leds") a.leds = Number(next());
    else if (v === "--seeds") a.seeds = Number(next());
    else if (v === "--json") a.json = next();
    else if (v === "--baseline") a.baseline = next();
    else if (v === "--coverage-of") a.coverageOf = Number(next());
    else if (v === "-h" || v === "--help") {
      console.log("usage: link_bench [--policy P]... [--scenario S]... [--leds N] [--seeds N] [--json out] [--baseline in] [bundle.json ...]");
      process.exit(0);
    } else a.bundles.push(v);
  }
  return a;
}

/** Fold several seeds of one (policy, scenario) into one report: median
 * coverage times, summed truth counts, mean rates. */
export function aggregate(name: string, rs: LinkReport[]): LinkReport {
  const first = rs[0]!;
  const med = (xs: (number | null)[]): number | null => {
    // A seed that never reached the target sorts last (as +∞).
    const s = xs.map((x) => (x === null ? Infinity : x)).sort((a, b) => a - b);
    const m = s[s.length >> 1]!;
    return Number.isFinite(m) ? m : null;
  };
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const truths = rs.map((r) => r.truth).filter((t) => t !== null);
  const checked = truths.reduce((a, t) => a + t.checked, 0);
  const wrong = truths.reduce((a, t) => a + t.wrong, 0);
  return {
    ...first,
    name,
    finalIds: Math.round(mean(rs.map((r) => r.finalIds))),
    finalCoverage: mean(rs.map((r) => r.finalCoverage)),
    timeToCoverage: first.timeToCoverage.map((x, i) => ({ frac: x.frac, tMs: med(rs.map((r) => r.timeToCoverage[i]!.tMs)) })),
    records: Math.round(mean(rs.map((r) => r.records))),
    truth:
      truths.length === 0
        ? null
        : { checked, wrong, wrongRate: checked > 0 ? wrong / checked : 0, wrongIds: Math.max(...truths.map((t) => t.wrongIds)) },
    idFlipsPerKDecodes: mean(rs.map((r) => r.idFlipsPerKDecodes)),
    rangeRejectsPerKDecodes: mean(rs.map((r) => r.rangeRejectsPerKDecodes)),
    fecCorrectedPerKDecodes: mean(rs.map((r) => r.fecCorrectedPerKDecodes)),
    minFramesPerBit: rs.reduce<number | null>(
      (m, r) => (r.minFramesPerBit === null ? m : m === null ? r.minFramesPerBit : Math.min(m, r.minFramesPerBit)),
      null,
    ),
  };
}

/** Run the simulated suite: report per policy × scenario (seeds aggregated). */
export function runSuite(opts: { policies: LinkPolicy[]; scenarios?: string[]; leds?: number; seeds?: number }): Record<string, LinkReport> {
  const out: Record<string, LinkReport> = {};
  const scs = standardScenarios(opts.leds ?? 120).filter((s) => !opts.scenarios?.length || opts.scenarios.includes(s.name));
  for (const pol of opts.policies) {
    for (const sc of scs) {
      const rs: LinkReport[] = [];
      for (let seed = 1; seed <= (opts.seeds ?? 3); seed++) {
        const res = runLinkSim({ ...sc, seed }, pol);
        rs.push(linkReport(res.telemetry, { name: `${pol.name}/${sc.name}`, coverageOf: res.visibleIds }));
      }
      out[`${pol.name}/${sc.name}`] = aggregate(`${pol.name}/${sc.name}`, rs);
    }
  }
  return out;
}

function bundleReports(paths: string[], coverageOf: number | null): Record<string, LinkReport> {
  const out: Record<string, LinkReport> = {};
  for (const p of paths) {
    const b = JSON.parse(fs.readFileSync(p, "utf8")) as { format?: string; version?: number; link?: LinkTelemetrySnapshot | null };
    if (b.format !== "splanc-capture-bundle") {
      console.error(`${p}: not a capture bundle`);
      continue;
    }
    if (b.link === undefined || b.link === null) {
      console.log(`${p}: v${b.version ?? "?"} bundle has no link telemetry (recorded from bundle v2 on)`);
      continue;
    }
    const name = p.split("/").pop()!;
    out[name] = linkReport(b.link, { name, ...(coverageOf !== null ? { coverageOf } : {}) });
  }
  return out;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  let reports: Record<string, LinkReport>;
  if (args.bundles.length > 0) {
    reports = bundleReports(args.bundles, args.coverageOf);
  } else {
    const pols = args.policies.length > 0 ? POLICIES.filter((p) => args.policies.includes(p.name)) : POLICIES;
    if (pols.length === 0) {
      console.error(`unknown policy; known: ${POLICIES.map((p) => p.name).join(", ")}`);
      return 1;
    }
    reports = runSuite({ policies: pols, scenarios: args.scenarios, leds: args.leds, seeds: args.seeds });
  }
  for (const r of Object.values(reports)) console.log(formatReport(r) + "\n");

  // Comparisons: against a saved baseline file, else in-suite vs `baseline/…`.
  const base: Record<string, LinkReport> =
    args.baseline !== null ? (JSON.parse(fs.readFileSync(args.baseline, "utf8")) as Record<string, LinkReport>) : reports;
  let unsafe = 0;
  const lines: string[] = [];
  for (const [key, r] of Object.entries(reports)) {
    const scenario = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
    const bKey = args.baseline !== null ? (base[key] !== undefined ? key : `baseline/${scenario}`) : `baseline/${scenario}`;
    const b = base[bKey];
    if (b === undefined || (b === r && args.baseline === null)) continue;
    const cmp = compareReports(b, r);
    if (cmp.verdict === "unsafe") unsafe++;
    lines.push(`${cmp.verdict.toUpperCase().padEnd(6)} ${key} vs ${bKey}: ${cmp.reasons.join("; ")}`);
  }
  if (lines.length > 0) console.log(["== vs baseline ==", ...lines].join("\n"));
  if (args.json !== null) fs.writeFileSync(args.json, JSON.stringify(reports, null, 1));
  return unsafe > 0 ? 3 : 0;
}

if (require.main === module) process.exitCode = main();
