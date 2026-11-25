/**
 * The code walkthrough in the effect editor (D-541 PR 7): wires the chat's
 * explain_code steps (effects/ai/explain.ts) to
 * - the explain layer over the code (explainOverlay.ts), scrolled to each mark;
 * - a caption bar at the foot of the Code pane with the step being read, so the
 *   walkthrough reads on a phone where the chat sits in another tab;
 * - a step list in the chat log; tapping a step shows it.
 * Playback is ExplainPlayer at reading pace; PR 8 swaps in a speaking narrator
 * through `setNarrator` and changes nothing here.
 */

import { Button } from "../../ui/kit";
import { normaliseSource, type ExplainStep } from "../ai/explain";
import { ExplainPlayer, type Narrator, type PlayerView } from "../ai/explainPlayer";
import { explainHtml } from "./explainOverlay";

export interface ExplainViewOptions {
  codeEl: HTMLTextAreaElement;
  /** The positioned Code pane box the caption bar is placed in. */
  codeWrap: HTMLElement;
  /** Where the step list goes (the chat log). */
  chatLog: HTMLElement;
  /** Bring the Code pane to the front (phone: it may sit behind the chat tab). */
  revealCode: () => void;
  /** A walkthrough's steps are all in: persist them as transcript text. */
  onComplete?: (text: string) => void;
}

/** The transcript text a walkthrough is saved as (a numbered list). */
export function walkthroughText(steps: readonly ExplainStep[]): string {
  return steps
    .filter((s) => s.say)
    .map((s, i) => `${i + 1}. ${s.say}`)
    .join("\n");
}

export class ExplainView {
  /** Insert between the highlighted backdrop and the diagnostics layer. */
  readonly layer: HTMLPreElement;
  private readonly bar: HTMLDivElement;
  private readonly barCount: HTMLSpanElement;
  private readonly barText: HTMLSpanElement;
  private readonly barActions: HTMLDivElement;
  private card: HTMLElement | null = null;
  /** The newest walkthrough's step list in the chat (for the Report control). */
  lastCard: HTMLElement | null = null;
  private readonly player: ExplainPlayer;
  private call = "";
  /** Source the marks were drawn for: an edit clears the walkthrough. */
  private source = "";
  private lastTarget = -1;
  private barState = "";

  constructor(private readonly o: ExplainViewOptions) {
    this.layer = document.createElement("pre");
    this.layer.className = "fxedit-explainlayer";
    this.layer.setAttribute("aria-hidden", "true");
    this.bar = document.createElement("div");
    this.bar.className = "fxexp-bar";
    this.bar.setAttribute("role", "status");
    this.bar.setAttribute("aria-live", "polite");
    this.bar.hidden = true;
    const text = document.createElement("div");
    text.className = "fxexp-bar-text";
    this.barCount = document.createElement("span");
    this.barCount.className = "fxexp-bar-count";
    this.barText = document.createElement("span");
    this.barText.className = "fxexp-bar-say";
    text.append(this.barCount, this.barText);
    this.barActions = document.createElement("div");
    this.barActions.className = "fxexp-bar-actions";
    this.bar.append(text, this.barActions);
    o.codeWrap.appendChild(this.bar);
    this.player = new ExplainPlayer({ onView: (v) => this.render(v) });
  }

  /** PR 8 (voice): present steps by speaking them instead of reading time. */
  setNarrator(n: Narrator): void {
    this.player.narrator = n;
  }

  /** The chat-turn hooks (generate.ts ChatHooks.explain). */
  hooks(): { source: () => string; onStep: (s: ExplainStep) => void; onEnd: (call: string) => void } {
    return {
      source: () => this.o.codeEl.value,
      onStep: (s) => this.step(s),
      onEnd: (call) => this.end(call),
    };
  }

  /** Repaint for the editor's current text (call on every edit). An edit to
   * the code the marks point into ends the walkthrough. */
  paint(): void {
    if (this.source && normaliseSource(this.o.codeEl.value) !== this.source) {
      this.clear();
      return;
    }
    this.layer.innerHTML = explainHtml(this.o.codeEl.value, this.player.view().marks);
    this.syncScroll();
  }

  syncScroll(): void {
    this.layer.scrollTop = this.o.codeEl.scrollTop;
    this.layer.scrollLeft = this.o.codeEl.scrollLeft;
  }

  /** Remove the walkthrough and its highlights. */
  clear(): void {
    this.source = "";
    this.call = "";
    this.player.clear();
  }

  dispose(): void {
    this.player.clear();
    this.bar.remove();
  }

  private step(s: ExplainStep): void {
    if (s.call !== this.call) {
      this.call = s.call;
      this.source = normaliseSource(this.o.codeEl.value);
      this.lastTarget = -1;
      this.player.start();
      this.newCard();
      this.o.revealCode();
    }
    this.player.add(s);
  }

  private end(call: string): void {
    if (call !== this.call) return;
    this.player.end();
    const text = walkthroughText(this.player.view().steps);
    if (text) this.o.onComplete?.(text);
  }

  private newCard(): void {
    const card = document.createElement("div");
    card.className = "fxedit-msg fxedit-msg--assistant fxexp-card";
    const ol = document.createElement("ol");
    ol.className = "fxexp-steps";
    card.appendChild(ol);
    this.o.chatLog.appendChild(card);
    this.card = card;
    this.lastCard = card;
  }

  private render(v: PlayerView): void {
    this.layer.innerHTML = explainHtml(this.o.codeEl.value, v.marks);
    this.syncScroll();
    if (v.current !== this.lastTarget) {
      this.lastTarget = v.current;
      this.scrollToMark();
    }
    this.renderBar(v);
    this.renderCard(v);
  }

  /** Bring the newest mark into view: its first line about a third of the way
   * down (and its matched text into view horizontally). */
  private scrollToMark(): void {
    const target = this.layer.querySelector<HTMLElement>(".fxexp-target");
    if (!target) return;
    const code = this.o.codeEl;
    const top = Math.max(0, target.offsetTop - code.clientHeight * 0.3);
    const span = this.layer.querySelector<HTMLElement>(".fxexp-span");
    let left = code.scrollLeft;
    if (span) {
      const a = span.offsetLeft;
      const b = a + span.offsetWidth;
      if (a < code.scrollLeft || b > code.scrollLeft + code.clientWidth) left = Math.max(0, a - code.clientWidth * 0.2);
    } else if (target.offsetLeft < code.scrollLeft) left = 0;
    if (typeof code.scrollTo === "function") code.scrollTo({ top, left, behavior: "smooth" });
    else {
      code.scrollTop = top;
      code.scrollLeft = left;
    }
  }

  private renderBar(v: PlayerView): void {
    const step = v.steps[v.current];
    this.bar.hidden = v.steps.length === 0;
    // Room under the code so the last lines can scroll clear of the bar.
    this.o.codeWrap.classList.toggle("fxexp-on", v.steps.length > 0);
    if (v.steps.length === 0) return;
    this.barCount.textContent = step ? `${v.current + 1} / ${v.steps.length}` : `0 / ${v.steps.length}`;
    this.barText.textContent = step?.say ?? "";
    const state = v.playing ? "playing" : "done";
    if (state === this.barState) return;
    this.barState = state;
    // One action while it plays; Replay and Close (spaced, never crammed) after.
    this.barActions.replaceChildren(
      ...(v.playing
        ? [Button({ label: "Skip", variant: "quiet", onClick: () => this.player.skip() })]
        : [
            Button({ label: "Replay", variant: "quiet", onClick: () => this.player.replay() }),
            Button({ label: "Close", variant: "quiet", onClick: () => this.clear() }),
          ]),
    );
  }

  private renderCard(v: PlayerView): void {
    const ol = this.card?.querySelector("ol");
    if (!ol) return;
    if (v.steps.length === 0) {
      // Cleared: the list stays as a record, without a "current" step.
      for (const li of ol.querySelectorAll("li")) li.classList.remove("fxexp-step--now");
      this.card = null;
      return;
    }
    while (ol.children.length < v.steps.length) {
      const i = ol.children.length;
      const li = document.createElement("li");
      li.className = "fxexp-step";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fxexp-step-btn";
      b.textContent = v.steps[i]!.say || "(highlight)";
      b.addEventListener("click", () => this.player.show(i));
      li.appendChild(b);
      ol.appendChild(li);
    }
    Array.from(ol.children).forEach((li, i) => {
      li.classList.toggle("fxexp-step--now", i === v.current);
      li.classList.toggle("fxexp-step--next", i > v.current);
    });
    this.revealStep(ol.children[v.current] as HTMLElement | undefined);
  }

  /** Keep the step being read visible in the chat log (without yanking a log
   * the user has scrolled elsewhere further than needed). */
  private revealStep(li: HTMLElement | undefined): void {
    if (!li || typeof li.getBoundingClientRect !== "function") return;
    const log = this.o.chatLog.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    if (log.height === 0) return;
    if (r.top < log.top || r.bottom > log.bottom) this.o.chatLog.scrollTop += r.top - log.top - log.height * 0.3;
  }
}
