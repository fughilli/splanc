/**
 * The Schedule flow (route /device/schedule; firmware feature "schedule",
 * docs/design/schedule.md): the lamp's wall-clock rules ("07:00 Mon–Fri · Turn
 * on"), each with an on/off switch, and a stepped editor, one decision per
 * screen:
 *
 *   when      — a time of day, sunrise or sunset.
 *   time      — the time, or the offset from the sun event.
 *   days      — every day / weekdays / weekends / picked days.
 *   action    — turn on, turn off, brightness, an effect, a trigger.
 *   detail    — that action's settings (fade, level + ramp, stored effect +
 *               crossfade, trigger name).
 *   location  — only for the first sun rule on a lamp with no location: the
 *               phone's position, rounded to 0.1°, after an explicit prompt.
 *   review    — the rule in one line, an optional name, Save (and Delete when
 *               editing).
 *
 * The rules live on the lamp; this screen reads them on mount and after each
 * change. The logic is in net/schedule.ts and scheduleModel.ts.
 */

import { Button, Field, Slider, Switch, confirmDialog, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { effectStore } from "../../store/effectStore";
import type { StoredEffectInfoFlat } from "../../net/proto";
import type { ClockState } from "../../net/wallClock";
import {
  DAY_NAMES,
  MAX_FADE_MS,
  WEEKDAYS_MASK,
  WEEKENDS_MASK,
  actionLabel,
  clampLabel,
  daysLabel,
  dayShort,
  deviceHasSchedule,
  hhmm,
  locationLabel,
  locationRequest,
  nextFreeId,
  readSchedule,
  ruleSummary,
  saveRule,
  scheduleResultError,
  scheduleStatus,
  secondsLabel,
  skipLabel,
  whenLabel,
  type RuleActionKind,
  type ScheduleRule,
  type ScheduleState,
} from "../../net/schedule";
import {
  actionFor,
  daysPreset,
  detailComplete,
  flowSteps,
  newRule,
  stepAfter,
  stepBefore,
  toggleDay,
  type FlowStep,
} from "./scheduleModel";
import { installPowerStyles } from "./power.css";
import { installScheduleStyles } from "./schedule.css";

type Step = "list" | FlowStep;

/** The phone's position (degrees), or a reason it isn't available. */
function phonePosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    const g = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
    if (!g) {
      reject(new Error("this browser can't share its location"));
      return;
    }
    g.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) =>
        reject(
          new Error(
            e.code === 1
              ? "location access was denied; allow it in the browser or phone settings"
              : "couldn't find this phone's location",
          ),
        ),
      // Coarse is plenty (it is rounded to ~11 km), and quick.
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 30 * 60_000 },
    );
  });
}

export function ScheduleScreen(_router: Router): Screen {
  installPowerStyles();
  installScheduleStyles();
  const el = document.createElement("div");
  el.className = "screen screen--pw";

  let sched: ScheduleState | null = null;
  let clock: ClockState | null = null;
  let stored: StoredEffectInfoFlat[] | null = null;
  const libNames = new Map<string, string>();
  let loadError = "";
  let step: Step = "list";
  let draft: ScheduleRule = newRule(1);
  /** Editing an existing rule (vs adding one). */
  let editing = false;
  /** The review has been reached: a change from it takes the short way back. */
  let fromReview = false;
  /** The location picked in this flow (1e-4 degrees), sent with Save. */
  let pickedLoc: { latE4: number; lonE4: number } | null = null;
  let busy = false;
  let unsubApp: (() => void) | null = null;
  let bound: ReturnType<typeof client> = null;

  const client = () => {
    const c = appState.client;
    return c?.isConnected ? c : null;
  };

  const effectName = (id: string): string | undefined =>
    stored?.find((e) => e.effectId === id)?.name || libNames.get(id) || undefined;

  const lampHasLocation = (): boolean => Boolean(clock?.hasLocation || sched?.hasLocation || pickedLoc);

  // -- small builders ---------------------------------------------------------

  function headline(text: string, sub?: string): HTMLElement[] {
    const h = document.createElement("h1");
    h.className = "screen-headline";
    h.textContent = text;
    const out: HTMLElement[] = [h];
    if (sub) {
      const p = document.createElement("p");
      p.className = "screen-sub";
      p.textContent = sub;
      out.push(p);
    }
    return out;
  }

  function steps(): FlowStep[] {
    // In this flow, a picked location counts: the location step stays in the list
    // (so its number doesn't jump) once it has been passed.
    return flowSteps(draft, Boolean(clock?.hasLocation || sched?.hasLocation));
  }

  function stepLine(): HTMLElement {
    const order = steps();
    const s = document.createElement("div");
    s.className = "pw-steps";
    s.textContent = `${editing ? "Editing a rule" : "New rule"} · step ${order.indexOf(step as FlowStep) + 1} of ${order.length}`;
    return s;
  }

  function footer(primary: HTMLButtonElement | null, back: () => void, backLabel = "Back"): HTMLElement {
    const f = document.createElement("div");
    f.className = "pw-footer";
    f.append(Button({ label: backLabel, variant: "quiet", onClick: back }));
    if (primary) f.append(primary);
    return f;
  }

  function next(label = "Next", disabled = false): HTMLButtonElement {
    return Button({
      label,
      variant: "primary",
      disabled: busy || disabled,
      onClick: () => {
        const n = fromReview ? shortNext(step as FlowStep) : stepAfter(steps(), step as FlowStep);
        if (n) go(n);
      },
    });
  }

  /** From the review, a change takes only the steps it needs, then returns. */
  function shortNext(s: FlowStep): FlowStep {
    if (s === "when") return "time";
    if (s === "action") return "detail";
    if ((s === "time" || s === "detail") && steps().includes("location") && !pickedLoc) return "location";
    return "review";
  }

  function back(): void {
    if (fromReview && step !== "review") {
      go("review");
      return;
    }
    const b = stepBefore(steps(), step as FlowStep);
    go(b ?? "list");
  }

  function tile(opts: { name: string; hint: string; pressed: boolean; onClick: () => void; glyph?: string }): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pw-tile";
    b.setAttribute("aria-pressed", String(opts.pressed));
    if (opts.glyph) {
      const g = document.createElement("div");
      g.className = "pw-thumb pw-thumb--style";
      g.textContent = opts.glyph;
      b.append(g);
    }
    const t = document.createElement("div");
    t.className = "pw-tile-text";
    const n = document.createElement("span");
    n.className = "pw-tile-name";
    n.textContent = opts.name;
    const h = document.createElement("span");
    h.className = "pw-tile-hint";
    h.textContent = opts.hint;
    t.append(n, h);
    b.append(t);
    b.addEventListener("click", opts.onClick);
    return b;
  }

  function list(...children: HTMLElement[]): HTMLElement {
    const d = document.createElement("div");
    d.className = "pw-list";
    d.append(...children);
    return d;
  }

  function empty(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "pw-empty";
    p.textContent = text;
    return p;
  }

  // -- the rule list ----------------------------------------------------------

  function listStep(): HTMLElement[] {
    const c = client();
    const parts = headline(
      "Lamp schedule",
      "Rules the lamp runs on its own clock, even with this phone away: wake up at 07:00, fade down at sunset.",
    );
    if (!c || !deviceHasSchedule(c.welcome)) {
      parts.push(
        empty(
          c
            ? "This lamp's firmware doesn't support schedules yet. Update it from the device sheet."
            : "Connect a lamp to see its schedule.",
        ),
      );
      return parts;
    }
    if (!sched) {
      parts.push(empty(loadError || "Reading the lamp's schedule…"));
      return parts;
    }
    const status = document.createElement("div");
    status.className = "sc-status";
    status.dataset["warn"] = String(!sched.clockValid && sched.count > 0);
    let text = scheduleStatus(sched, clock?.tz ?? "", Date.now(), effectName);
    const skip = skipLabel(sched.lastSkip);
    if (skip && sched.lastSkippedId) {
      const r = sched.rules.find((x) => x.id === sched!.lastSkippedId);
      text += ` · Last ${skip}${r ? ` (${whenLabel(r)})` : ""}`;
    }
    status.textContent = text;
    parts.push(status);

    const rows = document.createElement("div");
    rows.className = "pw-list";
    const sorted = [...sched.rules].sort((a, b) => sortKey(a) - sortKey(b));
    for (const r of sorted) rows.append(ruleRow(r));
    if (sorted.length === 0) rows.append(empty("No rules yet. Add one to start."));
    parts.push(rows);

    if (sched.rules.some((r) => r.when !== "time")) {
      const loc = document.createElement("div");
      loc.className = "pw-summary";
      const t = document.createElement("div");
      t.className = "pw-summary-title";
      t.textContent = "Location for sunrise and sunset";
      const v = document.createElement("div");
      v.className = "pw-summary-val";
      v.textContent =
        clock?.hasLocation
          ? `${locationLabel(clock.latE4, clock.lonE4)} (rounded, stored on the lamp)`
          : sched.hasLocation
            ? "Stored on the lamp"
            : "Not set: sun rules won't run until the lamp knows roughly where it is.";
      loc.append(
        t,
        v,
        Button({
          label: sched.hasLocation ? "Update from this phone" : "Set from this phone",
          variant: "quiet",
          disabled: busy,
          onClick: () => void updateLocation(),
        }),
      );
      parts.push(loc);
    }

    const full = sched.capacity > 0 && sched.count >= sched.capacity;
    const f = document.createElement("div");
    f.className = "pw-footer";
    f.append(
      Button({
        label: full ? `Schedule full (${sched.capacity} rules)` : "Add a rule",
        icon: "plus",
        variant: "primary",
        disabled: busy || full,
        onClick: () => begin(null),
      }),
    );
    parts.push(f);
    return parts;
  }

  /** Rules sort by their time of day; sun rules by a rough 06:00 / 18:00. */
  function sortKey(r: ScheduleRule): number {
    if (r.when === "time") return r.minuteOfDay;
    return (r.when === "sunrise" ? 360 : 1080) + r.offsetMin;
  }

  function ruleRow(r: ScheduleRule): HTMLElement {
    const row = document.createElement("div");
    row.className = "sc-rule";
    row.dataset["enabled"] = String(r.enabled);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "sc-rule-open";
    open.setAttribute("aria-label", `Edit: ${ruleSummary(r, effectName)}`);
    const n = document.createElement("span");
    n.className = "pw-tile-name";
    n.textContent = r.label ? `${r.label} · ${whenLabel(r)}` : whenLabel(r);
    const h = document.createElement("span");
    h.className = "pw-tile-hint";
    h.textContent = `${daysLabel(r.daysMask)} · ${actionLabel(r.action, effectName)}`;
    open.append(n, h);
    open.addEventListener("click", () => begin(r));
    const sw = Switch({
      on: r.enabled,
      label: `Rule ${whenLabel(r)} ${r.enabled ? "on" : "off"}`,
      onChange: (on) => void setEnabled(r, on, sw),
    });
    sw.el.disabled = busy;
    row.append(open, sw.el);
    return row;
  }

  // -- steps ------------------------------------------------------------------

  function whenStep(): HTMLElement[] {
    const parts = [stepLine(), ...headline("When should it run?")];
    const pick = (when: ScheduleRule["when"]) => () => {
      if (draft.when !== when) {
        draft.when = when;
        if (when !== "time") draft.offsetMin = 0;
      }
      render();
    };
    parts.push(
      list(
        tile({ name: "At a time of day", hint: "07:00, 22:30…", pressed: draft.when === "time", glyph: "◷", onClick: pick("time") }),
        tile({
          name: "At sunrise",
          hint: "Follows the seasons, with an offset if you like.",
          pressed: draft.when === "sunrise",
          glyph: "◓",
          onClick: pick("sunrise"),
        }),
        tile({
          name: "At sunset",
          hint: "Lights up as it gets dark, all year.",
          pressed: draft.when === "sunset",
          glyph: "◒",
          onClick: pick("sunset"),
        }),
      ),
    );
    parts.push(footer(next(), back));
    return parts;
  }

  function timeStep(): HTMLElement[] {
    if (draft.when === "time") {
      const parts = [stepLine(), ...headline("What time?", "The lamp's local time, in its own time zone.")];
      const input = document.createElement("input");
      input.type = "time";
      input.className = "sc-time-input";
      input.value = hhmm(draft.minuteOfDay);
      input.setAttribute("aria-label", "Time of day");
      input.addEventListener("input", () => {
        const m = /^(\d{1,2}):(\d{2})/.exec(input.value);
        if (m) draft.minuteOfDay = Math.min(1439, Number(m[1]) * 60 + Number(m[2]));
      });
      parts.push(input, footer(next(), back));
      return parts;
    }
    const ev = draft.when === "sunrise" ? "sunrise" : "sunset";
    const parts = [
      stepLine(),
      ...headline(`Exactly at ${ev}, or before or after?`, "Drag left for before, right for after."),
    ];
    const card = document.createElement("div");
    card.className = "pw-summary";
    const slider = Slider({
      label: "Offset",
      min: -180,
      max: 180,
      step: 5,
      value: Math.max(-180, Math.min(180, draft.offsetMin)),
      format: (v) => whenLabel({ when: draft.when, minuteOfDay: 0, offsetMin: v }),
      onInput: (v) => (draft.offsetMin = v),
    });
    card.append(slider.el);
    parts.push(card, footer(next(), back));
    return parts;
  }

  function daysStep(): HTMLElement[] {
    const parts = [stepLine(), ...headline("Which days?", "Days on the lamp's own calendar.")];
    const preset = daysPreset(draft.daysMask);
    const set = (mask: number) => () => {
      draft.daysMask = mask;
      render();
    };
    parts.push(
      list(
        tile({ name: "Every day", hint: "All week.", pressed: preset === "every", onClick: set(0) }),
        tile({ name: "Weekdays", hint: "Monday to Friday.", pressed: preset === "weekdays", onClick: set(WEEKDAYS_MASK) }),
        tile({ name: "Weekends", hint: "Saturday and Sunday.", pressed: preset === "weekends", onClick: set(WEEKENDS_MASK) }),
        tile({
          name: "Pick days",
          hint: preset === "custom" ? daysLabel(draft.daysMask) : "Choose the days below.",
          pressed: preset === "custom",
          onClick: () => {
            // Start from a pickable set (Monday) unless already custom.
            if (daysPreset(draft.daysMask) !== "custom") draft.daysMask = 0b0000010;
            render();
          },
        }),
      ),
    );
    if (preset === "custom") {
      const grid = document.createElement("div");
      grid.className = "sc-days";
      for (const d of [1, 2, 3, 4, 5, 6, 0]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sc-day";
        b.textContent = dayShort(d).slice(0, 2);
        b.setAttribute("aria-label", DAY_NAMES[d] ?? "");
        const on = ((draft.daysMask & 0x7f) === 0 ? 0x7f : draft.daysMask) & (1 << d);
        b.setAttribute("aria-pressed", String(Boolean(on)));
        b.addEventListener("click", () => {
          draft.daysMask = toggleDay(draft.daysMask, d);
          // Picking every day by hand is just "every day".
          render();
        });
        grid.append(b);
      }
      parts.push(grid);
    }
    parts.push(footer(next(), back));
    return parts;
  }

  function actionStep(): HTMLElement[] {
    const parts = [stepLine(), ...headline("What should the lamp do?")];
    const a = draft.action;
    const pick = (k: RuleActionKind | "power_on" | "power_off") => () => {
      draft.action = actionFor(k, draft.action);
      render();
    };
    parts.push(
      list(
        tile({
          name: "Turn on",
          hint: "With its on transition, or a fade you pick.",
          glyph: "⏻",
          pressed: a?.kind === "power" && a.on,
          onClick: pick("power_on"),
        }),
        tile({
          name: "Turn off",
          hint: "With its off transition, or a fade you pick.",
          glyph: "○",
          pressed: a?.kind === "power" && !a.on,
          onClick: pick("power_off"),
        }),
        tile({
          name: "Change brightness",
          hint: "A slow ramp up or down: a sunrise wake-up, an evening dim.",
          glyph: "◐",
          pressed: a?.kind === "brightness",
          onClick: pick("brightness"),
        }),
        tile({
          name: "Switch effect",
          hint: "Crossfade to an effect stored on the lamp.",
          glyph: "✦",
          pressed: a?.kind === "effect",
          onClick: pick("effect"),
        }),
        tile({
          name: "Fire a trigger",
          hint: "Pokes the running effect (an effect that listens for a named trigger).",
          glyph: "⚡",
          pressed: a?.kind === "trigger",
          onClick: pick("trigger"),
        }),
      ),
    );
    parts.push(footer(next("Next", !a), back));
    return parts;
  }

  function fadeSlider(label: string, ms: number, onInput: (ms: number) => void, zeroText: string): HTMLElement {
    // 0..10 min in 1 s steps up to a minute, coarser after (the slider runs in seconds).
    return Slider({
      label,
      min: 0,
      max: MAX_FADE_MS / 1000,
      step: 1,
      value: Math.round(ms / 1000),
      format: (v) => (v === 0 ? zeroText : secondsLabel(v * 1000)),
      onInput: (v) => onInput(Math.round(v) * 1000),
    }).el;
  }

  function detailStep(): HTMLElement[] {
    const a = draft.action;
    const parts: HTMLElement[] = [stepLine()];
    const card = document.createElement("div");
    card.className = "pw-summary";
    let nextBtn = next("Next", !detailComplete(a));
    if (a?.kind === "power") {
      parts.push(...headline(a.on ? "How should it turn on?" : "How should it turn off?"));
      card.append(
        fadeSlider("Fade", a.durationMs, (v) => (a.durationMs = v), "The lamp's own transition"),
      );
      parts.push(card);
    } else if (a?.kind === "brightness") {
      parts.push(...headline("Which brightness, and how slowly?"));
      card.append(
        Slider({
          label: "Brightness",
          min: 0,
          max: 100,
          step: 1,
          value: Math.round(a.level * 100),
          format: (v) => `${v}%`,
          onInput: (v) => (a.level = v / 100),
        }).el,
        fadeSlider("Ramp", a.rampMs, (v) => (a.rampMs = v), "At once"),
      );
      parts.push(card);
    } else if (a?.kind === "effect") {
      parts.push(
        ...headline("Which effect?", "Effects stored on this lamp, so the rule runs even with this phone away."),
      );
      const l = document.createElement("div");
      l.className = "pw-list";
      if (stored === null) l.append(empty("Reading the lamp's stored effects…"));
      else if (stored.length === 0) {
        l.append(
          empty("No effects are stored on this lamp yet. Store one from the effect editor (Save to lamp), then come back."),
        );
      } else {
        for (const e of stored) {
          l.append(
            tile({
              name: e.name || libNames.get(e.effectId) || e.effectId,
              hint: a.effectId === e.effectId ? "Selected" : "Stored on the lamp",
              pressed: a.effectId === e.effectId,
              onClick: () => {
                a.effectId = e.effectId;
                render();
              },
            }),
          );
        }
      }
      card.append(fadeSlider("Crossfade", a.crossfadeMs, (v) => (a.crossfadeMs = v), "Cut (no fade)"));
      parts.push(l, card);
    } else if (a?.kind === "trigger") {
      parts.push(
        ...headline(
          "Which trigger?",
          "The name an effect listens for (uniform trigger <name>;). It fires once; a missed one isn't replayed.",
        ),
      );
      const f = Field({
        label: "Trigger name",
        value: a.name,
        placeholder: "alarm",
        onInput: (v) => {
          a.name = v.trim();
          nextBtn.disabled = busy || !detailComplete(a);
        },
      });
      card.append(f.el);
      parts.push(card);
    }
    parts.push(footer(nextBtn, back));
    return parts;
  }

  function locationStep(): HTMLElement[] {
    const ev = draft.when === "sunrise" ? "sunrise" : "sunset";
    const parts = [
      stepLine(),
      ...headline(`The lamp needs to know when ${ev} is`, "Sunrise and sunset depend on where the lamp is."),
    ];
    const box = document.createElement("div");
    box.className = "sc-loc";
    const ul = document.createElement("ul");
    for (const t of [
      "Splanc asks this phone for its location once, now.",
      "It is rounded to 0.1° (about 10 km) before it leaves the phone.",
      "Only the lamp stores it. No map or location service is used.",
      "You can update it later from the Schedule screen.",
    ]) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.append(li);
    }
    box.append(ul);
    if (pickedLoc) {
      const p = document.createElement("div");
      p.className = "pw-summary-val";
      p.textContent = `Got it: ${locationLabel(pickedLoc.latE4, pickedLoc.lonE4)}`;
      box.append(p);
    }
    parts.push(box);
    const use = Button({
      label: busy ? "Asking for the location…" : pickedLoc ? "Next" : "Use this phone's location",
      variant: "primary",
      disabled: busy,
      onClick: () => {
        if (pickedLoc) go("review");
        else void pickLocation();
      },
    });
    parts.push(footer(use, back));
    return parts;
  }

  function reviewRow(title: string, value: string, change: FlowStep): HTMLElement {
    const row = document.createElement("div");
    row.className = "pw-summary sc-review-row";
    const t = document.createElement("div");
    t.className = "pw-tile-text";
    const n = document.createElement("span");
    n.className = "pw-tile-name";
    n.textContent = title;
    const h = document.createElement("span");
    h.className = "pw-tile-hint";
    h.textContent = value;
    t.append(n, h);
    row.append(t, Button({ label: `Change ${title.toLowerCase()}`, variant: "quiet", disabled: busy, onClick: () => go(change) }));
    return row;
  }

  function reviewStep(): HTMLElement[] {
    const parts = [stepLine(), ...headline(editing ? "Edit the rule" : "Check and save")];
    const sum = document.createElement("div");
    sum.className = "sc-status";
    sum.textContent = ruleSummary(draft, effectName);
    parts.push(
      sum,
      reviewRow("Time", whenLabel(draft), editing ? "when" : "time"),
      reviewRow("Days", daysLabel(draft.daysMask), "days"),
      reviewRow("Action", actionLabel(draft.action, effectName), editing ? "action" : "detail"),
    );
    const name = Field({
      label: "Name (optional)",
      value: draft.label,
      placeholder: draft.when === "time" ? "e.g. Wake up" : "e.g. Evening",
      onInput: (v) => (draft.label = clampLabel(v)),
    });
    name.input.maxLength = 24;
    parts.push(name.el);
    if (draft.when !== "time" && !lampHasLocation()) {
      parts.push(empty("This lamp has no location yet, so this rule won't run until one is set."));
    }
    const save = Button({
      label: busy ? "Saving…" : "Save",
      variant: "primary",
      disabled: busy || !detailComplete(draft.action),
      onClick: () => void saveDraft(),
    });
    parts.push(footer(save, () => go("list"), "Cancel"));
    if (editing) {
      const d = document.createElement("div");
      d.className = "sc-danger";
      d.append(
        Button({ label: "Delete this rule", icon: "trash", variant: "danger", disabled: busy, onClick: () => void del() }),
      );
      parts.push(d);
    }
    return parts;
  }

  // -- actions ----------------------------------------------------------------

  function go(s: Step): void {
    step = s;
    if (s === "review") fromReview = true;
    render();
    el.scrollIntoView?.({ block: "start" });
  }

  function begin(r: ScheduleRule | null): void {
    pickedLoc = null;
    fromReview = false;
    if (r) {
      editing = true;
      draft = { ...r, action: r.action ? { ...r.action } : null };
      go("review");
    } else {
      editing = false;
      draft = newRule(nextFreeId(sched?.rules ?? []));
      go("when");
    }
    void loadStored();
  }

  async function refresh(): Promise<void> {
    const c = client();
    if (!c || !deviceHasSchedule(c.welcome)) {
      render();
      return;
    }
    try {
      const [s, k] = await Promise.all([readSchedule(c), c.getClock().catch(() => null)]);
      sched = s;
      if (k) clock = k;
      loadError = "";
      // Effect rules show the stored effect's name.
      if (s.rules.some((r) => r.action?.kind === "effect")) void loadStored().then(render);
    } catch (e) {
      loadError = `Couldn't read the schedule: ${e instanceof Error ? e.message : String(e)}`;
    }
    render();
  }

  async function loadStored(): Promise<void> {
    const c = client();
    if (!c || stored !== null) return;
    try {
      stored = (await c.listStoredEffects()).effects ?? [];
    } catch {
      stored = [];
    }
    if (step === "detail") render();
  }

  async function pickLocation(): Promise<boolean> {
    busy = true;
    render();
    try {
      const p = await phonePosition();
      const req = locationRequest(p.lat, p.lon);
      pickedLoc = { latE4: req.latE4 ?? 0, lonE4: req.lonE4 ?? 0 };
      return true;
    } catch (e) {
      toast(`No location: ${e instanceof Error ? e.message : String(e)}`, { error: true });
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  async function sendLocation(): Promise<void> {
    const c = client();
    if (!c || !pickedLoc) return;
    clock = await c.setClockConfig(pickedLoc);
    pickedLoc = null;
  }

  async function updateLocation(): Promise<void> {
    const ok = await confirmDialog({
      title: "Use this phone's location?",
      message:
        "The lamp uses it for sunrise and sunset rules. It is rounded to 0.1° (about 10 km) and stored only on the lamp.",
      confirmLabel: "Use my location",
    });
    if (!ok || !(await pickLocation())) return;
    busy = true;
    render();
    try {
      await sendLocation();
      toast("Location saved on the lamp");
      await refresh();
    } catch (e) {
      toast(`Couldn't save the location: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function saveDraft(): Promise<void> {
    const c = client();
    if (!c) {
      toast("Connect the lamp first", { error: true });
      return;
    }
    busy = true;
    render();
    try {
      // The location first (D-565: sent only when a sun rule is created, after the
      // prompt), so the rule's first next-fire already has it.
      if (draft.when !== "time" && pickedLoc) await sendLocation();
      draft.label = clampLabel(draft.label);
      await saveRule(c, draft);
      toast(editing ? "Rule saved" : "Rule added");
      step = "list";
      await refresh();
    } catch (e) {
      toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function del(): Promise<void> {
    const c = client();
    if (!c) return;
    const ok = await confirmDialog({
      title: "Delete this rule?",
      message: ruleSummary(draft, effectName),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    busy = true;
    render();
    try {
      const st = await c.deleteSchedule({ id: draft.id });
      const why = scheduleResultError(st.result);
      if (why && st.result !== "not_found") throw new Error(why);
      toast("Rule deleted");
      step = "list";
      await refresh();
    } catch (e) {
      toast(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function setEnabled(r: ScheduleRule, on: boolean, sw: { set: (on: boolean) => void }): Promise<void> {
    const c = client();
    if (!c) return;
    try {
      await saveRule(c, { ...r, enabled: on });
      await refresh();
    } catch (e) {
      sw.set(r.enabled);
      toast(`Couldn't ${on ? "enable" : "pause"} the rule: ${e instanceof Error ? e.message : String(e)}`, {
        error: true,
      });
    }
  }

  function render(): void {
    let parts: HTMLElement[];
    switch (step) {
      case "when":
        parts = whenStep();
        break;
      case "time":
        parts = timeStep();
        break;
      case "days":
        parts = daysStep();
        break;
      case "action":
        parts = actionStep();
        break;
      case "detail":
        parts = detailStep();
        break;
      case "location":
        parts = locationStep();
        break;
      case "review":
        parts = reviewStep();
        break;
      default:
        parts = listStep();
    }
    el.replaceChildren(...parts);
  }

  render();

  return {
    el,
    onMount: () => {
      void effectStore.list({ sort: "name" }).then((l) => {
        for (const e of l) libNames.set(e.id, e.name);
        render();
      });
      // (Re)bind to whichever client is connected: a deep link mounts before the
      // connection is up, and a reconnect brings a new session.
      const bind = (): void => {
        const c = client();
        if (c === bound) return;
        bound = c;
        sched = null;
        stored = null;
        if (step !== "list") step = "list";
        void refresh();
      };
      unsubApp = appState.subscribe(bind);
      bind();
    },
    onUnmount: () => {
      unsubApp?.();
    },
  };
}
