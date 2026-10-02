/**
 * Informational UI (PR-5): toasts, help tips, first-run hints, the tutorial
 * overlay and the startup splash never block the primary workflow — each is
 * self-clearing or dismissible, and a dismissal sticks.
 *
 *  - toast() (src/ui/kit) lives in its own host and removes itself on a timer.
 *  - HelpTip (src/ui/kit) closes on any outside press — capture phase, so a
 *    control that stops propagation can't keep it stuck open (FUG-31) — and on
 *    Escape, without swallowing the press that dismissed it.
 *  - The Effects-tab AI hint starts open only while AI is unconfigured, is gone
 *    for good once dismissed, and stops listening when the tab unmounts.
 *  - The first-run tour hint shows once; the tutorial overlay is fully removed
 *    when skipped (src/ui/guide).
 *  - The startup splash (src/ui/app/splash.ts) fades out on its own and can be
 *    switched off.
 *
 * Runs against the fake DOM (tests/fakeDom.ts) with node:test mock timers.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { asFake, fire, installFakeDom, textOf, type FakeElement } from "./fakeDom";
import { resetAppearance, updateAppearance } from "../src/store/appearance";
import { prefs } from "../src/store/prefs";
import { defaultConfig, updateAiConfig } from "../src/effects/ai/provider";
import { HelpTip, toast } from "../src/ui/kit";
import type { Router } from "../src/ui/app/router";
import { maybeShowSplash } from "../src/ui/app/splash";
import { EffectsBrowserScreen } from "../src/ui/screens/effectsBrowser";
import { maybeShowFirstRunHint, startTour } from "../src/ui/guide/tour";
import { loadTourState, resetTour } from "../src/ui/guide/tourStore";

const dom = installFakeDom();
const router = { navigate: () => undefined, path: () => "/maps", back: () => undefined } as unknown as Router;
const body = (): FakeElement => asFake(document.body);
const doc = (): FakeElement => dom.document as unknown as FakeElement;

/** An ordinary control elsewhere in the app, counting its clicks. */
function outsideButton(): { el: FakeElement; clicks: () => number } {
  const b = asFake(document.createElement("button"));
  let n = 0;
  b.addEventListener("click", () => void n++);
  document.body.appendChild(b as unknown as Node);
  return { el: b, clicks: () => n };
}

/** A help tip mounted in the page, already open (as first-run hints are). */
function openTip(): { tip: FakeElement; trigger: FakeElement; dismissals: () => number; close: () => void } {
  let n = 0;
  const h = HelpTip({
    title: "AI generation",
    body: "Bring your own key…",
    defaultOpen: true,
    onDismiss: () => void n++,
  });
  document.body.appendChild(h.el);
  mock.timers.tick(0); // the dismiss listeners arm right after opening
  const tip = asFake(h.el);
  return { tip, trigger: tip.querySelector(".k-helptip-btn")!, dismissals: () => n, close: h.close };
}

const isOpen = (tip: FakeElement): boolean => tip.classList.contains("k-helptip--open");

// -- toasts ----------------------------------------------------------------------------

test("toasts appear in their own layer and clear themselves after their display time [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    toast("Saved to device");
    toast("Export failed", { error: true, ms: 5000 });
    const host = body().querySelector(".k-toast-host")!;
    assert.ok(host.parentElement === body(), "a layer of its own, not inserted into screen content");
    const shown = (): string[] => host.querySelectorAll(".k-toast").map((t) => textOf(t));
    dom.flushAnimationFrames();
    assert.deepEqual(shown(), ["Saved to device", "Export failed"]);
    assert.ok(host.querySelectorAll(".k-toast").every((t) => t.classList.contains("k-toast--in")));
    mock.timers.tick(2599);
    assert.equal(shown().length, 2);
    mock.timers.tick(1); // display time over → fades…
    assert.ok(!host.querySelector(".k-toast")!.classList.contains("k-toast--in"));
    mock.timers.tick(160); // …and is gone, with no user action
    assert.deepEqual(shown(), ["Export failed"]);
    mock.timers.tick(5000 - 2760); // the longer toast's own display time…
    mock.timers.tick(160);
    assert.deepEqual(shown(), [], "every toast clears itself");
  } finally {
    mock.timers.reset();
  }
});

// -- help tips ----------------------------------------------------------------------------

test("an open help tip closes on any press elsewhere without swallowing that press [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { tip, dismissals, close } = openTip();
  const other = outsideButton();
  try {
    assert.ok(isOpen(tip));
    const down = fire(other.el, "pointerdown", { pointerId: 1 });
    other.el.click();
    assert.equal(isOpen(tip), false, "dismissed by the outside press");
    assert.equal(tip.querySelector(".k-helptip-btn")!.getAttribute("aria-expanded"), "false");
    assert.equal(dismissals(), 1);
    assert.equal(down.defaultPrevented, false, "the press is not cancelled…");
    assert.equal(other.clicks(), 1, "…so the control underneath still works");
    // Presses inside the tip itself don't dismiss it.
    tip.querySelector(".k-helptip-btn")!.click(); // reopen
    mock.timers.tick(0);
    fire(tip.querySelector(".k-helptip-body")!, "pointerdown", { pointerId: 1 });
    assert.ok(isOpen(tip));
  } finally {
    close();
    tip.remove();
    other.el.remove();
    mock.timers.reset();
  }
});

test("a control that stops event propagation cannot leave a help tip stuck open [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { tip, dismissals, close } = openTip();
  // Editor panes / layout drag handles stop propagation on their own presses.
  const pane = asFake(document.createElement("div"));
  pane.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  document.body.appendChild(pane as unknown as Node);
  try {
    fire(pane, "pointerdown", { pointerId: 1 });
    assert.equal(isOpen(tip), false);
    assert.equal(dismissals(), 1);
  } finally {
    close();
    tip.remove();
    pane.remove();
    mock.timers.reset();
  }
});

test("Escape dismisses a help tip and hands focus back to its trigger [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { tip, trigger, dismissals, close } = openTip();
  try {
    fire(doc(), "keydown", { key: "Escape" });
    assert.equal(isOpen(tip), false);
    assert.equal(dismissals(), 1);
    assert.ok((document.activeElement as unknown) === trigger, "keyboard users land back where they were");
    // Once closed, the tip no longer reacts to presses or keys.
    fire(doc(), "keydown", { key: "Escape" });
    fire(body(), "pointerdown", { pointerId: 1 });
    assert.equal(dismissals(), 1);
  } finally {
    close();
    tip.remove();
    mock.timers.reset();
  }
});

// -- Effects-tab AI hint -----------------------------------------------------------------

function freshAiState(): void {
  localStorage.removeItem("ledmapper.aiHintDismissed");
  updateAiConfig(defaultConfig()); // no provider configured
}

const aiHint = (screenEl: HTMLElement): FakeElement | null =>
  asFake(screenEl).querySelector(".fxlib-aihelp .k-helptip");

test("the AI-generation hint starts open on first visit and, once dismissed, is gone for good [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  freshAiState();
  const first = EffectsBrowserScreen(router);
  document.body.appendChild(first.el);
  try {
    const tip = aiHint(first.el)!;
    assert.ok(tip && isOpen(tip), "surfaced expanded while nothing is configured");
    mock.timers.tick(0);
    fire(body(), "pointerdown", { pointerId: 1 }); // tap anywhere else
    assert.ok(aiHint(first.el) === null, "the affordance is removed once dismissed");
    assert.equal(prefs.getAiHintDismissed(), true);
    first.onUnmount?.();
    first.el.remove();
    // Coming back to the tab (or relaunching): it does not return.
    const again = EffectsBrowserScreen(router);
    assert.ok(aiHint(again.el) === null, "not re-offered after a dismissal");
    again.onUnmount?.();
  } finally {
    first.el.remove();
    freshAiState();
    mock.timers.reset();
  }
});

test("the AI-generation hint clears itself once an AI provider is configured [rr:PR-5]", () => {
  freshAiState();
  updateAiConfig({
    kind: "local",
    local: { baseUrl: "http://localhost:11434/v1", key: "", model: "qwen3", vision: false },
  });
  try {
    const screen = EffectsBrowserScreen(router);
    assert.ok(aiHint(screen.el) === null, "nothing to prompt for");
    assert.equal(asFake(screen.el).querySelector(".fxlib-aihelp")!.childElementCount, 0);
    screen.onUnmount?.();
  } finally {
    freshAiState();
  }
});

test("leaving the Effects tab with the AI hint open leaves nothing listening to presses elsewhere [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  freshAiState();
  const before = { down: doc().listenerCount("pointerdown"), key: doc().listenerCount("keydown") };
  const screen = EffectsBrowserScreen(router);
  document.body.appendChild(screen.el);
  try {
    mock.timers.tick(0);
    assert.equal(doc().listenerCount("pointerdown"), before.down + 1, "the open hint listens for outside presses");
    screen.onUnmount?.();
    screen.el.remove();
    assert.deepEqual(
      { down: doc().listenerCount("pointerdown"), key: doc().listenerCount("keydown") },
      before,
      "unmounting drops the listeners",
    );
    // A press on another screen is not mistaken for dismissing the hint.
    fire(body(), "pointerdown", { pointerId: 1 });
    assert.equal(prefs.getAiHintDismissed(), false);
  } finally {
    screen.el.remove();
    freshAiState();
    mock.timers.reset();
  }
});

// -- tutorial -----------------------------------------------------------------------------

test("the first-run tour hint shows once, and dismissing it stops it nagging [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  resetTour();
  const anchors = (): FakeElement[] => body().querySelectorAll(".tour-hint-anchor");
  try {
    maybeShowFirstRunHint(router);
    assert.equal(anchors().length, 1);
    const tip = anchors()[0]!.querySelector(".k-helptip")!;
    assert.ok(isOpen(tip), "offered expanded on first launch");
    maybeShowFirstRunHint(router); // e.g. the next screen mount / launch
    assert.equal(anchors().length, 1, "never stacked or re-offered once seen");
    mock.timers.tick(0);
    fire(doc(), "keydown", { key: "Escape" });
    assert.equal(isOpen(tip), false);
    assert.equal(loadTourState().dismissed, true, "declining is remembered");
    for (const a of anchors()) a.remove();
    maybeShowFirstRunHint(router); // next launch
    assert.equal(anchors().length, 0);
  } finally {
    for (const a of anchors()) a.remove();
    resetTour();
    mock.timers.reset();
  }
});

test("skipping the tutorial removes its whole overlay and remembers the choice [rr:PR-5]", () => {
  resetTour();
  const overlayParts = (): FakeElement[] => body().querySelectorAll(".tour-scrim, .tour-highlight, .tour-bubble");
  const keyListeners = doc().listenerCount("keydown");
  try {
    startTour(router);
    assert.equal(overlayParts().length, 3);
    assert.match(textOf(body().querySelector(".tour-bubble")!), /Skip/, "a way out on every step");
    fire(doc(), "keydown", { key: "Escape" });
    assert.equal(overlayParts().length, 0, "no leftover scrim blocking the app");
    assert.equal(doc().listenerCount("keydown"), keyListeners);
    assert.equal(loadTourState().dismissed, true);
    // The explicit Skip button does the same.
    resetTour();
    startTour(router);
    body()
      .querySelectorAll(".tour-bubble button")
      .find((b) => textOf(b) === "Skip")!
      .click();
    assert.equal(overlayParts().length, 0);
  } finally {
    for (const p of overlayParts()) p.remove();
    resetTour();
  }
});

// -- startup splash --------------------------------------------------------------------

/** The fake DOM has no HTML parser: hand the splash its logo as one parsed <svg>. */
function withTemplateParsing<T>(fn: () => T): T {
  const d = dom.document;
  const realCreate = d.createElement.bind(d);
  d.createElement = (tag: string) => {
    const el = realCreate(tag);
    if (tag === "template") {
      const frag = d.createDocumentFragment();
      frag.appendChild(d.createElementNS("http://www.w3.org/2000/svg", "svg"));
      Object.defineProperty(el, "content", { value: frag });
    }
    return el;
  };
  try {
    return fn();
  } finally {
    Reflect.deleteProperty(d, "createElement");
  }
}

test("the startup splash fades out on its own and can be switched off [rr:PR-5]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  resetAppearance();
  const splash = (): FakeElement | null => body().querySelector(".splash");
  try {
    withTemplateParsing(() => maybeShowSplash());
    assert.ok(splash(), "shown at launch");
    assert.equal(splash()!.getAttribute("role"), "presentation");
    mock.timers.tick(1400);
    assert.ok(splash()!.classList.contains("splash--out"), "fades without any user action");
    mock.timers.tick(420);
    assert.ok(splash() === null, "then removes itself");
    updateAppearance({ splash: false }); // Appearance ▸ Startup ▸ Off
    withTemplateParsing(() => maybeShowSplash());
    assert.ok(splash() === null, "switched off: never shown");
  } finally {
    splash()?.remove();
    resetAppearance();
    mock.timers.reset();
  }
});
