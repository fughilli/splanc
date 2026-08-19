/**
 * Interactive tutorial (FUG-103) — the on-demand guided walkthrough plus the
 * dismissible first-run hint that offers it.
 *
 * The step sequence is derived from the shared {@link GUIDE_TOPICS} catalog
 * (the SAME data the static docs are generated from), so the tour and the
 * website never drift. Each topic with `steps` contributes them in catalog
 * order; before a topic's steps run, the tour navigates to a screen where its
 * chrome is on-screen. Dismissing (Skip / Escape / the scrim's Close on the
 * last step) records the tutorial as done so it never auto-prompts again — it's
 * then only reachable from Settings ▸ Help & tutorial.
 */

import { HelpTip } from "../kit";
import type { Router } from "../app/router";
import { GUIDE_TOPICS, type GuideStep, type GuideTopic } from "./catalog";
import { TourOverlay, type CoachView } from "./overlay";
import { dismissTour, loadTourState, shouldShowHint, updateTourState } from "./tourStore";

/** A flattened step plus the topic it came from (for routing + keys). */
interface FlatStep {
  topic: GuideTopic;
  step: GuideStep;
}

/** The route the tour should be on to show a topic's chrome. Effects topics
 * need the Effects screen (its FAB / library); everything else reads cleanly on
 * the Maps screen, where the shell chrome (tab bar, pill) and a FAB are present.
 * (Topics' catalog `route` is the canonical "where it lives" for the docs; the
 * tour only needs a chrome-visible screen to point at.) */
function tourRouteFor(topic: GuideTopic): string {
  return topic.tab === "effects" ? "/effects" : "/maps";
}

function flattenSteps(): FlatStep[] {
  const out: FlatStep[] = [];
  for (const topic of GUIDE_TOPICS) {
    for (const step of topic.steps ?? []) out.push({ topic, step });
  }
  return out;
}

let running = false;

/**
 * Run the full guided walkthrough. Navigates between screens as needed and
 * spotlights each step's target. Resolves (and records dismissal) when the user
 * finishes or skips. Safe to call repeatedly; a second call is a no-op while one
 * is running.
 */
export function startTour(router: Router): void {
  if (running || typeof document === "undefined") return;
  const steps = flattenSteps();
  if (steps.length === 0) return;
  running = true;

  const overlay = new TourOverlay();
  let i = 0;

  const finish = (): void => {
    running = false;
    overlay.destroy();
    dismissTour();
  };

  const show = async (): Promise<void> => {
    const { topic, step } = steps[i]!;
    // Get to a screen that shows this topic's chrome before we point at it.
    const wantRoute = tourRouteFor(topic);
    if (router.path() !== wantRoute) router.navigate(wantRoute);

    const target = step.target ? await waitForTarget(step.target) : null;
    const view: CoachView = {
      title: step.title,
      body: step.body,
      index: i + 1,
      total: steps.length,
      target,
      isFirst: i === 0,
      isLast: i === steps.length - 1,
      onBack: () => {
        if (i > 0) {
          i--;
          void show();
        }
      },
      onNext: () => {
        if (i < steps.length - 1) {
          i++;
          void show();
        } else {
          finish();
        }
      },
      onSkip: finish,
    };
    if (step.placement) view.placement = step.placement;
    overlay.render(view);
  };

  void show();
}

/**
 * Show the one-time first-run hint: a small "?" affordance offering the tour.
 * No-op if the user has already dismissed the tutorial or seen the hint. Marks
 * the hint seen as soon as it's surfaced, and records full dismissal if the user
 * closes it without taking the tour — either way it won't nag again.
 */
export function maybeShowFirstRunHint(router: Router): void {
  if (typeof document === "undefined") return;
  if (!shouldShowHint(loadTourState())) return;
  updateTourState({ hintSeen: true });

  const anchor = document.createElement("div");
  anchor.className = "tour-hint-anchor";
  installHintStyles();

  const tip = HelpTip({
    title: "New to Splanc?",
    body: "Take a 60-second tour of the main features. You can restart it any time from Settings.",
    label: "Take a tour",
    align: "left",
    // The anchor sits just above the tab bar at the bottom of the viewport, so
    // open the bubble upward — otherwise it renders off the bottom edge.
    direction: "up",
    defaultOpen: true,
    action: {
      label: "Take a tour",
      icon: "sparkles",
      onClick: () => {
        anchor.remove();
        startTour(router);
      },
    },
    // Dismissing the hint (outside press / Escape / tapping the ?) counts as
    // declining the tutorial — don't pop it again on the next launch.
    onDismiss: () => {
      dismissTour();
      // Leave the collapsed "?" affordance in place for this session so it's
      // still discoverable; it just won't reappear on future launches.
    },
  });
  anchor.appendChild(tip.el);
  document.body.appendChild(anchor);
}

/**
 * Wait (a few rAF ticks) for a freshly-navigated screen to mount and expose the
 * target selector, then resolve the element — or null if it never appears (the
 * overlay degrades to a centered step). Also waits for a non-zero layout box so
 * the spotlight lands on the painted element.
 */
function waitForTarget(selector: string, maxFrames = 40): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let frames = 0;
    const tick = (): void => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
        resolve(el);
        return;
      }
      if (++frames >= maxFrames) {
        resolve(el ?? null);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

let hintStylesInstalled = false;
function installHintStyles(): void {
  if (hintStylesInstalled || typeof document === "undefined") return;
  hintStylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
.tour-hint-anchor {
  position: fixed;
  left: env(safe-area-inset-left, 0);
  bottom: calc(64px + env(safe-area-inset-bottom, 0));
  margin-left: var(--sp-3);
  z-index: 90;
}`;
  document.head.appendChild(style);
}
