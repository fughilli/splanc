/**
 * Offline decode of a `?record=1` frames trace (VIO exploration phase 3 —
 * docs/vio-exploration.md).
 *
 * Replays the recorded per-frame blob stream through the CANONICAL M6
 * tracker/decoder (`CvPipeline` — the exact code the phone runs, so there is
 * no reimplementation to drift), and emits id-labeled observations for the
 * offline joint pose+LED solver:
 *
 *  - `records`: §7.4 DetectionRecords, one per (track, cycle) — what the
 *    phone would have streamed; feeds the pose-trusting `reconstruct()` for
 *    the comparison baseline (they carry the recorded WebXR poses).
 *  - `frames`: dense per-frame labeled samples `{t, k, obs: [[ledId, u, v]]}`
 *    — every blob whose track has a decoded id, every frame. This is the
 *    solver's visual input (10–30× denser than the per-cycle records; the
 *    VIO solve wants every sighting, not just cycle anchors). Only frames
 *    with at least one labeled blob are emitted.
 *
 * Usage:  bazelisk run //web:offline_decode -- <frames.jsonl> [out.json]
 *         (out defaults to stdout)
 */

import * as fs from "node:fs";
import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import { CvPipeline } from "../../src/cv/pipeline";
import type { Blob } from "../../src/cv/types";

interface TraceFrame {
  t: number;
  tServer: number;
  pose: { p: [number, number, number]; q: [number, number, number, number] };
  K: [number, number, number, number];
  imgW: number;
  imgH: number;
  blobs: Blob[];
}

function main(): number {
  const [tracePath, outPath] = process.argv.slice(2);
  if (!tracePath) {
    console.error("usage: offline_decode <frames.jsonl> [out.json]");
    return 1;
  }
  const lines = fs.readFileSync(tracePath, "utf8").split("\n");

  let params: CodeParams | null = null;
  let epoch = 0;
  const frames: TraceFrame[] = [];
  let imuCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as Record<string, unknown>;
    if (rec["reset"]) {
      // A trace file can contain several reset segments (one per capture on
      // the same server run); the LAST segment wins, matching the file's
      // append semantics.
      params = rec["codeParams"] as CodeParams;
      epoch = rec["epoch"] as number;
      frames.length = 0;
      imuCount = 0;
      continue;
    }
    if (rec["imu"]) {
      imuCount++;
      continue; // IMU is consumed by the Python side straight from the trace
    }
    frames.push(rec as unknown as TraceFrame);
  }
  if (!params || frames.length === 0) {
    console.error("trace has no reset/codeParams or no frames");
    return 1;
  }

  // Constant local→server clock offset, as the live client's ServerClock
  // would hold it: median over the trace (robust to the odd delayed post).
  const offsets = frames.map((f) => f.tServer - f.t).sort((a, b) => a - b);
  const offset = offsets[offsets.length >> 1]!;

  const pipeline = new CvPipeline(params, epoch, (t) => t + offset);
  const records: DetectionRecord[] = [];
  pipeline.onDetections((r) => records.push(...r));

  const denseFrames: { t: number; k: number[]; obs: [number, number, number][] }[] = [];
  for (const f of frames) {
    pipeline.step(f.blobs, {
      tCaptureMs: f.t,
      pose: f.pose,
      K: f.K,
      imgW: f.imgW,
      imgH: f.imgH,
    });
    // Dense labeled stream: every blob whose track has a decoded id. Labels
    // are prospective (a track is labeled from its first decoded cycle on),
    // so roughly the first cycle of each track goes unlabeled — acceptable.
    const obs: [number, number, number][] = [];
    for (const b of pipeline.lastBlobStatus) {
      if (b.ledId !== null && b.ledId !== undefined) {
        obs.push([b.ledId, b.u, b.v]);
      }
    }
    if (obs.length > 0) denseFrames.push({ t: f.t, k: [...f.K], obs });
  }

  const stats = pipeline.stats;
  const out = {
    codeParams: params,
    epoch,
    clockOffsetMs: offset,
    stats: {
      frames: frames.length,
      imuSamples: imuCount,
      cyclesCompleted: stats.cyclesCompleted,
      recordsEmitted: stats.recordsEmitted,
      uniqueIds: [...stats.uniqueIds].sort((a, b) => a - b),
      correctedCycles: stats.correctedCycles,
      rejectedFec: stats.rejectedFec,
      rejectedSync: stats.rejectedSync,
      rejectedLowConf: stats.rejectedLowConf,
      rejectedSupport: stats.rejectedSupport,
      rejectedDuplicate: stats.rejectedDuplicate,
      denseFrames: denseFrames.length,
      denseObs: denseFrames.reduce((n, f) => n + f.obs.length, 0),
    },
    records,
    frames: denseFrames,
  };
  const json = JSON.stringify(out);
  if (outPath) {
    fs.writeFileSync(outPath, json);
    console.error(
      `decoded ${records.length} records, ${out.stats.denseObs} dense obs over ` +
        `${denseFrames.length} frames -> ${outPath}`,
    );
  } else {
    process.stdout.write(json);
  }
  console.error(`decode stats: ${JSON.stringify(out.stats)}`);
  return 0;
}

process.exitCode = main();
