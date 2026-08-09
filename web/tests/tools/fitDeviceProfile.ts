/**
 * Headless fit + validation of a HITL device-measurement bundle (FUG-11).
 *
 * The on-hardware harness (pi/hitl/harness/fx_bench.py) measures the calibration
 * programs on a real C6 and writes a device-measurement bundle. The BROWSER path
 * imports that bundle through deviceProfile.ts `buildDeviceProfile` (fit the
 * per-opcode cost model, then VALIDATE it by predicting the held-out programs and
 * stamping measuredError). This runs the IDENTICAL code path headlessly — so a
 * rig run can fit + validate + commit an authoritative device profile with no
 * browser, and prints the predicted-vs-measured table that proves the model
 * tracks the actual hardware (Kevin's requirement).
 *
 *   bazelisk run //web:fit_device_profile -- <bundle.json> [out-profile.json]
 *
 * Prints the validation summary to stderr; writes the app-importable cost-table
 * JSON (the same shape as the profiles screen's "Export") to out-profile.json (or
 * stdout). Exit code is nonzero if the held-out RMS error exceeds the tolerance,
 * so the one command doubles as a regression gate.
 */

import * as fs from "node:fs";
import { parseDeviceBundle, buildDeviceProfile } from "../../src/effects/deviceProfile";
import { profileToStored, profileToCostTable } from "../../src/effects/executionProfile";
import { validateCostModel } from "../../src/effects/profileValidation";
import { CURRENT_TABLE_VERSION, exportTable } from "../../src/store/costTableStore";

function main(): number {
  const [bundlePath, outPath] = process.argv.slice(2);
  if (!bundlePath) {
    process.stderr.write("usage: fit_device_profile <bundle.json> [out-profile.json]\n");
    return 2;
  }
  const bundle = parseDeviceBundle(fs.readFileSync(bundlePath, "utf8"));
  const { profile, validation } = buildDeviceProfile(bundle);

  const soc = profile.soc;
  const label = profile.deviceLabel || soc;
  const lines: string[] = [];
  lines.push(`Device profile — ${label} (${soc} @ ${(profile.cpuHz / 1e6).toFixed(0)} MHz)`);
  lines.push(`  fit programs: ${bundle.fit.length}   held-out: ${bundle.heldout.length}`);
  lines.push(`  fit residual: ±${(profile.residualError * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("  held-out program        LEDs   measured    predicted    error");
  for (const s of validation.samples) {
    lines.push(
      "  " +
        s.label.padEnd(22) +
        String(s.ledCount).padStart(5) +
        `   ${s.measuredMs.toFixed(2)} ms`.padStart(12) +
        `   ${s.predictedMs.toFixed(2)} ms`.padStart(13) +
        `   ${(s.relError * 100 >= 0 ? "+" : "") + (s.relError * 100).toFixed(1)}%`.padStart(9),
    );
  }
  lines.push("");
  lines.push(
    `  RMS ${(validation.rmsError * 100).toFixed(1)}%  ·  mean-abs ${(
      validation.meanAbsError * 100
    ).toFixed(1)}%  ·  max ${(validation.maxAbsError * 100).toFixed(1)}%  ·  R² ${validation.r2.toFixed(
      3,
    )}`,
  );
  lines.push(
    `  verdict: ${validation.passed ? "PASS" : "FAIL"} (RMS ${(validation.rmsError * 100).toFixed(
      1,
    )}% vs tolerance ${(validation.tolerance * 100).toFixed(0)}%)`,
  );
  process.stderr.write(lines.join("\n") + "\n");

  // FIT_DEBUG: dump per-program predicted-vs-measured (fit programs too) via the
  // exact same estimator path, sorted by |error| — to see which programs the
  // linear opcode model mis-predicts.
  if (process.env.FIT_DEBUG) {
    const table = profileToCostTable(profile);
    const all = [...bundle.fit, ...bundle.heldout].map((s) => ({
      label: s.label,
      bytecode: s.fxb,
      ledCount: s.ledCount,
      measuredMs: ((s.measuredFrameCycles + s.measuredShowCycles) / profile.cpuHz) * 1000,
    }));
    const v = validateCostModel(table, all, 999);
    const rows = v.samples.slice().sort((a, b) => b.absRelError - a.absRelError);
    process.stderr.write("\n  per-program |error| (all programs, fit path):\n");
    for (const r of rows) {
      process.stderr.write(
        "  " +
          r.label.padEnd(16) +
          String(r.ledCount).padStart(4) +
          `  meas ${r.measuredMs.toFixed(2)}`.padStart(13) +
          `  pred ${r.predictedMs.toFixed(2)}`.padStart(13) +
          `  ${(r.relError * 100 >= 0 ? "+" : "") + (r.relError * 100).toFixed(1)}%`.padStart(9) +
          "\n",
      );
    }
    process.stderr.write(`  in-sample RMS over all ${all.length}: ${(v.rmsError * 100).toFixed(1)}%\n`);
  }

  // The app-importable artifact: the same {kind, version, table} export the
  // profiles screen writes, so it round-trips through "Import profile".
  const stored = profileToStored(profile, CURRENT_TABLE_VERSION);
  const json = exportTable(stored);
  if (outPath) {
    fs.writeFileSync(outPath, json + "\n");
    process.stderr.write(`\nwrote ${outPath}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
  return validation.passed ? 0 : 1;
}

process.exit(main());
