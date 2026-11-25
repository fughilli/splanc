/**
 * Plays an explain_code walkthrough (D-541 PR 7): one step at a time, each
 * held on screen for as long as it takes to read (or, with a voice narrator,
 * to speak), its highlight drawn as it starts. Ported from the stage demo's
 * playback queue (agent/src/stage/page.ts).
 *
 * Voice seam (PR 8): a `Narrator` decides how long a step lasts. The default
 * holds the text for reading time; the speaking narrator (tts.ts) speaks it
 * and resolves when the speech ends.
 *
 * No DOM: the editor renders `PlayerView` snapshots (marks + current step).
 */

import type { ExplainMark, ExplainStep } from "./explain";

/** How a step is presented over time. Resolves when the step is done; must
 * resolve promptly (or reject) once `signal` aborts. */
export interface Narrator {
  present(text: string, signal: AbortSignal): Promise<void>;
  /** A step was queued: get ready to present it (a voice synthesises ahead,
   * so the next step starts without a gap). Optional. */
  prepare?(text: string): void;
}

/** Reading time for `text`: about 62 ms a character plus a beat, capped
 * (the stage demo's pace). An empty step still lingers briefly on its mark. */
export function readingMs(text: string): number {
  const n = text.trim().length;
  return Math.min(9000, 700 + n * 62);
}

/** The default narrator: hold each step for its reading time. */
export function readingPace(
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
): Narrator {
  return { present: (text, signal) => sleep(readingMs(text), signal) };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** What the editor shows. */
export interface PlayerView {
  steps: readonly ExplainStep[];
  /** The step on screen (-1 before the first). */
  current: number;
  /** The marks drawn now (the current step's, plus kept ones). */
  marks: readonly ExplainMark[];
  /** True while steps are still being presented (or more are expected). */
  playing: boolean;
}

export interface PlayerOptions {
  narrator?: Narrator;
  /** Called on every change. */
  onView: (view: PlayerView) => void;
}

/** The marks on screen once step `i` has been applied. */
export function marksAt(steps: readonly ExplainStep[], i: number): ExplainMark[] {
  let marks: ExplainMark[] = [];
  for (let k = 0; k <= i && k < steps.length; k++) {
    const s = steps[k]!;
    if (!s.keep) marks = [];
    if (s.mark) marks.push(s.mark);
  }
  return marks;
}

export class ExplainPlayer {
  private steps: ExplainStep[] = [];
  private current = -1;
  private busy = false;
  /** More steps may still stream in (the call has not finished). */
  private open = false;
  /** The user skipped (or picked a step): later streamed steps show at once. */
  private settled = false;
  private abort: AbortController | null = null;
  narrator: Narrator;

  constructor(private readonly o: PlayerOptions) {
    this.narrator = o.narrator ?? readingPace();
  }

  /** A new walkthrough: drop the old one. */
  start(): void {
    this.stopPresenting();
    this.steps = [];
    this.current = -1;
    this.open = true;
    this.settled = false;
    this.render();
  }

  /** Queue a step (in order). Starts playing if idle. */
  add(step: ExplainStep): void {
    this.steps.push(step);
    if (this.settled) {
      this.current = this.steps.length - 1;
      this.render();
      return;
    }
    // The step right after the one playing is the next to speak: start on it.
    if (this.steps.length - 1 <= this.current + 1) this.narrator.prepare?.(step.say);
    this.render();
    void this.pump();
  }

  /** No more steps will arrive for this walkthrough. */
  end(): void {
    this.open = false;
    this.render();
  }

  /** Jump to the end: every remaining highlight applied, nothing more presented. */
  skip(): void {
    this.stopPresenting();
    this.settled = true;
    this.current = this.steps.length - 1;
    this.render();
  }

  /** Show step `i` and stop there (a click on a step in the list). */
  show(i: number): void {
    if (i < 0 || i >= this.steps.length) return;
    this.stopPresenting();
    this.settled = true;
    this.current = i;
    this.render();
  }

  /** Play again from the first step. */
  replay(): void {
    if (this.steps.length === 0) return;
    this.stopPresenting();
    this.settled = false;
    this.current = -1;
    this.render();
    void this.pump();
  }

  /** Remove the walkthrough (and its highlights). */
  clear(): void {
    this.stopPresenting();
    this.steps = [];
    this.current = -1;
    this.open = false;
    this.settled = false;
    this.render();
  }

  view(): PlayerView {
    return {
      steps: this.steps,
      current: this.current,
      marks: marksAt(this.steps, this.current),
      playing: !this.settled && (this.busy || this.open || this.current < this.steps.length - 1),
    };
  }

  private stopPresenting(): void {
    this.abort?.abort();
    this.abort = null;
    this.busy = false;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    while (this.current < this.steps.length - 1) {
      this.busy = true;
      this.current++;
      const step = this.steps[this.current]!;
      const next = this.steps[this.current + 1];
      if (next) this.narrator.prepare?.(next.say);
      const ac = new AbortController();
      this.abort = ac;
      this.render();
      try {
        await this.narrator.present(step.say, ac.signal);
      } catch {
        // A narrator failure (e.g. speech refused) just ends that step.
      }
      if (ac.signal.aborted) return; // skipped / replaced: the caller owns state now
      this.abort = null;
    }
    this.busy = false;
    this.render();
  }

  private render(): void {
    this.o.onView(this.view());
  }
}
