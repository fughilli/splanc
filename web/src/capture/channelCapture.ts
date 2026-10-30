/**
 * Per-channel capture (Halloween 2026: a dense LED curtain on CH0 + a diffused
 * LED rope on CH1, mapped in ONE capture).
 *
 * The output channels share one LED index space (CH0 = [0, n0), CH1 follows —
 * see hardwareSetup.ts). Each channel can be captured `regular` (every LED
 * coded at once, today's dense capture) or `strided` (stride N + the diffuse
 * detector, today's diffuse capture). The device plays the code pattern ITSELF
 * from the pattern epoch (firmware/player pattern_color) — the phone only sends
 * start / configure / stop — and its mask is "LED < ledCount, and on the stride
 * phase when striding". That cannot express "CH0 dense AND CH1 strided" in one
 * frame without a firmware change, so a mixed fixture runs as STAGES of one
 * capture session (no firmware change, works on every shipped C6 build):
 *
 *   1. regular stage: `ledCount` = the leading run of regular channels (CH0),
 *      stride off. LEDs past it are dark.
 *   2. strided stage: `ledCount` = every LED, stride = the largest strided
 *      channel's stride, phases rotating as in diffuse capture. The regular
 *      channels are strided too here — harmless extra observations of LEDs the
 *      first stage already covered, and they keep linking the two stages.
 *
 * The code book is pinned to the WHOLE fixture from the start (`codeSpace` =
 * every LED), so LED ids and code timing are identical in both stages: the
 * switch is one `configure` and the decoded records fuse by id into one solve.
 *
 * After the solve, unmapped LEDs are filled by index WITHIN their own channel
 * ({@link fillChannelGaps}); the firmware's own fill (#255) runs across the
 * whole index space and would otherwise interpolate between the last curtain
 * LED and the first rope LED.
 *
 * Pure (no DOM); capture.ts wires it in.
 */

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { strideLit } from "../code/stride";
import type { ChannelCaptureProfile } from "../store/deviceStore";

/** One output channel's slice of the global LED index space. */
export interface ChannelSpan {
  channel: number;
  /** First global LED index. */
  start: number;
  count: number;
}

/** Channel spans in channel order from per-channel LED counts (index =
 * channel). Zero-LED channels get an empty span. */
export function channelSpans(counts: readonly number[]): ChannelSpan[] {
  const out: ChannelSpan[] = [];
  let start = 0;
  counts.forEach((n, channel) => {
    const count = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
    out.push({ channel, start, count });
    start += count;
  });
  return out;
}

export interface CaptureStage {
  kind: "regular" | "strided";
  /** The device codes LEDs [0, ledCount) this stage (configure.ledCount). */
  ledCount: number;
  /** Stride spacing (0 = every LED lit). */
  strideSpacing: number;
  /** Channels this stage is meant to capture (for the HUD). */
  channels: number[];
}

export interface ChannelCapturePlan {
  /** Every LED on the fixture: the code space and the solve's ledCount. */
  total: number;
  spans: ChannelSpan[];
  stages: CaptureStage[];
}

/**
 * The capture plan for a device's per-channel profiles, or null to capture
 * exactly as today (no profile set, or no usable channel layout). A channel
 * with LEDs but no profile is treated as `regular`. Profiles past the
 * hardware's channel list are ignored.
 */
export function planChannelCapture(
  counts: readonly number[] | null | undefined,
  profiles: readonly (ChannelCaptureProfile | null)[] | null | undefined,
): ChannelCapturePlan | null {
  if (!counts || !profiles || !profiles.some((p) => p !== null)) return null;
  const spans = channelSpans(counts);
  const total = spans.reduce((s, x) => s + x.count, 0);
  if (total <= 0) return null;
  const used = spans.filter((s) => s.count > 0);
  const mode = (ch: number): ChannelCaptureProfile => profiles[ch] ?? { mode: "regular", stride: 1 };
  const strided = used.filter((s) => mode(s.channel).mode === "strided" && mode(s.channel).stride >= 2);
  // The leading run of regular channels: the only part the device can code
  // densely while keeping the strided channels dark (its mask is a prefix).
  let prefix = 0;
  const prefixChannels: number[] = [];
  for (const s of used) {
    if (strided.includes(s)) break;
    prefix = s.start + s.count;
    prefixChannels.push(s.channel);
  }
  const stages: CaptureStage[] = [];
  if (prefix > 0) {
    stages.push({ kind: "regular", ledCount: prefix, strideSpacing: 0, channels: prefixChannels });
  }
  if (strided.length > 0) {
    // One stride for the stage: the largest keeps every strided channel's lit
    // spots at least its own spacing apart.
    const stride = Math.max(...strided.map((s) => mode(s.channel).stride));
    stages.push({
      kind: "strided",
      ledCount: total,
      strideSpacing: stride,
      channels: used.filter((s) => !prefixChannels.includes(s.channel)).map((s) => s.channel),
    });
  } else if (prefix < total) {
    // Unreachable (no strided channel means every used channel is in the
    // prefix); kept so a future mode can't silently drop LEDs.
    stages.push({ kind: "regular", ledCount: total, strideSpacing: 0, channels: used.map((s) => s.channel) });
  }
  return { total, spans, stages };
}

/**
 * Is `led` lit (coded) in `stage` at stride phase `phase`? The phone-side
 * mirror of the firmware's mask (player pattern_color): striding first, then
 * `led < ledCount`. Used by the simulator and tests.
 */
export function stageLit(led: number, stage: CaptureStage, phase: number, anchorDensity: number): boolean {
  if (stage.strideSpacing > 1 && !strideLit(led, phase, { spacing: stage.strideSpacing, anchorDensity })) {
    return false;
  }
  return led >= 0 && led < stage.ledCount;
}

/** Decoded-id coverage of a stage's target channels, [0, 1]. */
export function stageCoverage(stage: CaptureStage, spans: readonly ChannelSpan[], decoded: ReadonlySet<number>): number {
  let want = 0;
  let got = 0;
  for (const s of spans) {
    if (!stage.channels.includes(s.channel)) continue;
    for (let i = s.start; i < s.start + s.count; i++) {
      want++;
      if (decoded.has(i)) got++;
    }
  }
  return want > 0 ? got / want : 1;
}

/** When the regular stage hands over to the next one: most of its LEDs decoded
 * and the user had time to sweep (the solve needs parallax, not just ids), or a
 * hard cap so a few unreachable LEDs never stall the capture. */
export const REGULAR_STAGE_MIN_MS = 20_000;
export const REGULAR_STAGE_MAX_MS = 60_000;
export const REGULAR_STAGE_COVERAGE = 0.85;

export function shouldAdvanceStage(o: { elapsedMs: number; coverage: number; isLast: boolean }): boolean {
  if (o.isLast) return false;
  if (o.elapsedMs >= REGULAR_STAGE_MAX_MS) return true;
  return o.elapsedMs >= REGULAR_STAGE_MIN_MS && o.coverage >= REGULAR_STAGE_COVERAGE;
}

/** HUD line for a stage. */
export function stageLabel(plan: ChannelCapturePlan, idx: number): string {
  const st = plan.stages[idx]!;
  const chans = st.channels.map((c) => `CH${c}`).join("+");
  const what = st.kind === "regular" ? "regular" : `strided ${st.strideSpacing}`;
  return `stage ${idx + 1}/${plan.stages.length}: ${chans} (${what})`;
}

function isInferredEntry(l: LedEntry): boolean {
  return l.nViews === 0 && l.confidence === 0;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Fill unmapped LEDs by index WITHIN each channel: an interior run is placed
 * linearly between its mapped neighbours in the same channel, a run at either
 * end of a channel clamps to that channel's nearest mapped LED. Placed LEDs are
 * emitted like the solver's strip-prior placements (nViews = 0, confidence = 0
 * — geom/inferred), so any later real observation outranks them.
 *
 * Existing placements (strip prior) are dropped and redone here: the solver's
 * strip chain runs over the whole index space and can bridge the boundary.
 * A channel with no measured LED is left unmapped. LEDs outside every span
 * are untouched. Never moves a measured LED.
 */
export function fillChannelGaps(map: OutputMap, spans: readonly ChannelSpan[]): OutputMap {
  const unmappedIn = new Set(map.unmapped);
  const measured = new Map<number, LedEntry>();
  for (const l of map.leds) if (!isInferredEntry(l) && !unmappedIn.has(l.id)) measured.set(l.id, l);
  const inSpan = (id: number): boolean => spans.some((s) => id >= s.start && id < s.start + s.count);
  // Keep everything outside the spans as it was (measured or placed).
  const leds: LedEntry[] = map.leds.filter((l) => measured.has(l.id) || !inSpan(l.id));
  const placed = new Set<number>();
  for (const s of spans) {
    const ids: number[] = [];
    for (let i = s.start; i < s.start + s.count; i++) if (measured.has(i)) ids.push(i);
    if (ids.length === 0) continue;
    for (let i = s.start; i < s.start + s.count; i++) {
      if (measured.has(i)) continue;
      // Nearest measured neighbours inside this channel.
      let lo = -1;
      let hi = -1;
      for (const id of ids) {
        if (id < i) lo = id;
        else if (id > i) {
          hi = id;
          break;
        }
      }
      const a = lo >= 0 ? measured.get(lo)!.xyz : null;
      const b = hi >= 0 ? measured.get(hi)!.xyz : null;
      const xyz: Vec3 = a && b ? lerp3(a, b, (i - lo) / (hi - lo)) : ([...(a ?? b)!] as Vec3);
      leds.push({ id: i, xyz, confidence: 0, nViews: 0, rmsReprojPx: 0, parallaxDeg: 0 });
      placed.add(i);
    }
  }
  leds.sort((x, y) => x.id - y.id);
  // Outside the spans the original unmapped list stands; inside, whatever
  // is still not placed (a channel with nothing measured).
  const present = new Set(leds.map((l) => l.id));
  const unmapped = map.unmapped.filter((id) => !inSpan(id));
  for (const s of spans) {
    for (let i = s.start; i < s.start + s.count && i < map.ledCount; i++) if (!present.has(i)) unmapped.push(i);
  }
  unmapped.sort((x, y) => x - y);
  return { ...map, leds, unmapped };
}
