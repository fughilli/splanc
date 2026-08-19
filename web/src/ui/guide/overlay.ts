/**
 * Coach-mark overlay for the interactive tutorial (FUG-103).
 *
 * A single full-screen scrim dims the app; a highlight box cut out of the scrim
 * (via a large `box-shadow` spread — the classic spotlight trick) draws the eye
 * to the current step's target element; a bubble anchored beside it shows the
 * copy plus Back / Next / Skip. Targetless steps show a centered card with no
 * cutout (intros / prose-only steps).
 *
 * This module only renders ONE step at a time — {@link tour.ts} owns the
 * sequence, screen navigation, and target lookup. It injects its own stylesheet
 * (CJS-safe, mirroring the *.css.ts screen styles), so it's self-contained.
 */

let installed = false;

function installTourStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Everything needed to paint one coach-mark. */
export interface CoachView {
  title: string;
  body: string;
  /** 1-based position + total, shown as "2 / 7". */
  index: number;
  total: number;
  /** The element to spotlight, or null for a centered step. */
  target: HTMLElement | null;
  placement?: "top" | "bottom" | "left" | "right";
  isLast: boolean;
  isFirst: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

const BUBBLE_GAP = 12; // px between the target rect and the bubble
const PAD = 6; // px halo padding around the highlighted target

/**
 * The overlay controller. Construct once at tour start; call {@link render} for
 * each step and {@link destroy} at the end. It keeps its DOM mounted between
 * steps (only the highlight + bubble move) so the scrim doesn't flash.
 */
export class TourOverlay {
  private readonly scrim: HTMLElement;
  private readonly highlight: HTMLElement;
  private readonly bubble: HTMLElement;
  private view: CoachView | null = null;
  private readonly onResize = (): void => this.reposition();

  constructor() {
    installTourStyles();
    this.scrim = document.createElement("div");
    this.scrim.className = "tour-scrim";
    // A tap on the dim area advances (feels natural), except it must not be
    // mistaken for a Skip — Skip is the explicit control in the bubble.
    this.scrim.addEventListener("click", (e) => {
      if (e.target === this.scrim) this.view?.onNext();
    });

    this.highlight = document.createElement("div");
    this.highlight.className = "tour-highlight";

    this.bubble = document.createElement("div");
    this.bubble.className = "tour-bubble";
    this.bubble.setAttribute("role", "dialog");
    this.bubble.setAttribute("aria-live", "polite");

    document.body.append(this.scrim, this.highlight, this.bubble);
    window.addEventListener("resize", this.onResize, { passive: true });
    window.addEventListener("scroll", this.onResize, { passive: true, capture: true });
    document.addEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.view) return;
    if (e.key === "Escape") this.view.onSkip();
    else if (e.key === "ArrowRight" || e.key === "Enter") this.view.onNext();
    else if (e.key === "ArrowLeft") this.view.onBack();
  };

  render(view: CoachView): void {
    this.view = view;
    this.bubble.replaceChildren(...this.buildBubble(view));
    this.reposition();
  }

  private buildBubble(view: CoachView): Node[] {
    const head = document.createElement("div");
    head.className = "tour-bubble-head";
    const title = document.createElement("h2");
    title.className = "tour-bubble-title";
    title.textContent = view.title;
    const count = document.createElement("span");
    count.className = "tour-bubble-count";
    count.textContent = `${view.index} / ${view.total}`;
    head.append(title, count);

    const body = document.createElement("p");
    body.className = "tour-bubble-body";
    body.textContent = view.body;

    const actions = document.createElement("div");
    actions.className = "tour-bubble-actions";
    const skip = mkBtn(view.isLast ? "Close" : "Skip", "tour-btn-quiet", view.onSkip);
    const spacer = document.createElement("div");
    spacer.className = "tour-spacer";
    const back = mkBtn("Back", "tour-btn-quiet", view.onBack);
    back.disabled = view.isFirst;
    const next = mkBtn(view.isLast ? "Done" : "Next", "tour-btn-primary", view.onNext);
    actions.append(skip, spacer, back, next);

    return [head, body, actions];
  }

  /** Place the highlight over the target and the bubble beside it (or center
   * both when there's no target). */
  private reposition(): void {
    const view = this.view;
    if (!view) return;
    const target = view.target;
    if (!target || !target.isConnected) {
      this.highlight.style.display = "none";
      this.centerBubble();
      return;
    }
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      // Target is present but not laid out (display:none) — fall back to center.
      this.highlight.style.display = "none";
      this.centerBubble();
      return;
    }
    this.highlight.style.display = "";
    this.highlight.style.left = `${r.left - PAD}px`;
    this.highlight.style.top = `${r.top - PAD}px`;
    this.highlight.style.width = `${r.width + PAD * 2}px`;
    this.highlight.style.height = `${r.height + PAD * 2}px`;
    this.placeBubbleNear(r, view.placement ?? "auto");
  }

  private centerBubble(): void {
    const b = this.bubble;
    b.style.left = "50%";
    b.style.top = "50%";
    b.style.transform = "translate(-50%, -50%)";
  }

  /** Anchor the bubble to a side of the target rect, flipping if it would
   * overflow the viewport. */
  private placeBubbleNear(r: DOMRect, pref: "top" | "bottom" | "left" | "right" | "auto"): void {
    const b = this.bubble;
    b.style.transform = "none";
    // Measure after content is set.
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Room on each side of the target.
    const room = {
      top: r.top,
      bottom: vh - r.bottom,
      left: r.left,
      right: vw - r.right,
    };
    let side = pref;
    if (side === "auto") {
      // Prefer the side with the most room, biasing vertical (reads better).
      side = room.bottom >= bh + BUBBLE_GAP ? "bottom" : room.top >= bh + BUBBLE_GAP ? "top" : "bottom";
    }
    // Flip if the preferred side can't fit.
    if (side === "bottom" && room.bottom < bh + BUBBLE_GAP && room.top >= bh + BUBBLE_GAP) side = "top";
    if (side === "top" && room.top < bh + BUBBLE_GAP && room.bottom >= bh + BUBBLE_GAP) side = "bottom";
    if (side === "right" && room.right < bw + BUBBLE_GAP && room.left >= bw + BUBBLE_GAP) side = "left";
    if (side === "left" && room.left < bw + BUBBLE_GAP && room.right >= bw + BUBBLE_GAP) side = "right";

    let left: number;
    let top: number;
    if (side === "bottom") {
      top = r.bottom + BUBBLE_GAP;
      left = r.left + r.width / 2 - bw / 2;
    } else if (side === "top") {
      top = r.top - BUBBLE_GAP - bh;
      left = r.left + r.width / 2 - bw / 2;
    } else if (side === "right") {
      left = r.right + BUBBLE_GAP;
      top = r.top + r.height / 2 - bh / 2;
    } else {
      left = r.left - BUBBLE_GAP - bw;
      top = r.top + r.height / 2 - bh / 2;
    }
    // Clamp into the viewport with an 8px margin.
    left = Math.max(8, Math.min(left, vw - bw - 8));
    top = Math.max(8, Math.min(top, vh - bh - 8));
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
  }

  destroy(): void {
    this.view = null;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("scroll", this.onResize, { capture: true } as EventListenerOptions);
    document.removeEventListener("keydown", this.onKey);
    this.scrim.remove();
    this.highlight.remove();
    this.bubble.remove();
  }
}

function mkBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tour-btn ${cls}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

const CSS = `
.tour-scrim {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: transparent;
}
.tour-highlight {
  position: fixed;
  z-index: 401;
  border-radius: var(--r-ctrl);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.62), 0 0 0 2px var(--accent);
  pointer-events: none;
  transition: left 0.22s ease, top 0.22s ease, width 0.22s ease, height 0.22s ease;
}
/* Centered (targetless) steps: no cutout, so dim the whole screen via the scrim. */
.tour-scrim:has(~ .tour-highlight[style*="display: none"]) { background: rgba(0, 0, 0, 0.62); }
.tour-bubble {
  position: fixed;
  z-index: 402;
  width: min(340px, calc(100vw - 32px));
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  padding: var(--sp-4);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  transition: left 0.2s ease, top 0.2s ease;
}
.tour-bubble-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-2);
}
.tour-bubble-title { font-size: var(--f-title); margin: 0; }
.tour-bubble-count { font-size: var(--f-caption); color: var(--text-dim); flex: none; }
.tour-bubble-body { margin: 0 0 var(--sp-4); color: var(--text); line-height: 1.5; }
.tour-bubble-actions { display: flex; align-items: center; gap: var(--sp-2); }
.tour-spacer { flex: 1; }
.tour-btn {
  font: inherit;
  font-weight: 600;
  border-radius: var(--r-ctrl);
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  border: 1px solid transparent;
}
.tour-btn:disabled { opacity: 0.4; cursor: default; }
.tour-btn-quiet { background: none; border-color: var(--border); color: var(--text-dim); }
.tour-btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`;
