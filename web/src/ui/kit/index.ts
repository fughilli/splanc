/**
 * Shared UI kit (design doc §2.5 / §7.2) — plain DOM factories, no framework.
 * Each factory returns a live HTMLElement (plus a small handle where a control
 * needs imperative updates). Styling lives in tokens.css; these apply the
 * `k-*` classes and wire events.
 */

import { icon, type IconName } from "./icons";
import { attachDiffractionBackdrop, type DiffractionHandle } from "./diffractionBackdrop";

export { icon, installIconSprite, type IconName } from "./icons";

// -- Button ------------------------------------------------------------------

export interface ButtonOpts {
  label: string;
  icon?: IconName;
  variant?: "primary" | "quiet" | "danger";
  block?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function Button(opts: ButtonOpts): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "k-btn";
  if (opts.variant === "quiet") b.classList.add("k-btn--quiet");
  else if (opts.variant === "danger") b.classList.add("k-btn--danger");
  if (opts.block) b.classList.add("k-btn--block");
  if (opts.icon) b.appendChild(icon(opts.icon));
  const span = document.createElement("span");
  span.textContent = opts.label;
  b.appendChild(span);
  b.disabled = opts.disabled ?? false;
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

// -- IconButton --------------------------------------------------------------

export function IconButton(
  name: IconName,
  opts: { title?: string; onClick?: () => void; className?: string } = {},
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = opts.className ? `k-iconbtn ${opts.className}` : "k-iconbtn";
  if (opts.title) {
    b.title = opts.title;
    b.setAttribute("aria-label", opts.title);
  }
  b.appendChild(icon(name));
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

// -- ActionGrid --------------------------------------------------------------

export interface ActionItem {
  label: string;
  icon: IconName;
  variant?: "danger";
  onClick: () => void;
}

/** A compact grid of icon+label action tiles — for context ("⋯") menus, where a
 * stack of full-width buttons is unwieldy. */
export function ActionGrid(items: ActionItem[]): HTMLDivElement {
  const grid = document.createElement("div");
  grid.className = "k-actiongrid";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "k-actiontile" + (it.variant === "danger" ? " k-actiontile--danger" : "");
    b.append(icon(it.icon));
    const s = document.createElement("span");
    s.textContent = it.label;
    b.appendChild(s);
    b.addEventListener("click", it.onClick);
    grid.appendChild(b);
  }
  return grid;
}

// -- Card --------------------------------------------------------------------

export function Card(...children: (Node | string)[]): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "k-card";
  d.append(...children);
  return d;
}

// -- Field -------------------------------------------------------------------

export interface FieldHandle {
  el: HTMLLabelElement;
  input: HTMLInputElement;
}

export function Field(opts: {
  label: string;
  type?: string;
  value?: string;
  placeholder?: string;
  onInput?: (v: string) => void;
}): FieldHandle {
  const label = document.createElement("label");
  label.className = "k-field";
  const cap = document.createElement("span");
  cap.className = "k-field-label";
  cap.textContent = opts.label;
  const input = document.createElement("input");
  input.type = opts.type ?? "text";
  input.value = opts.value ?? "";
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.onInput) input.addEventListener("input", () => opts.onInput?.(input.value));
  label.append(cap, input);
  return { el: label, input };
}

// -- Slider ------------------------------------------------------------------

export interface SliderHandle {
  el: HTMLElement;
  input: HTMLInputElement;
  setValueText: (t: string) => void;
}

export function Slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput?: (v: number) => void;
  /** Fired on the native `change` event (drag release / commit), after the last
   * `input`. Use this for effects that are disruptive to apply continuously
   * (e.g. reflowing the whole UI) so the value is only committed once the user
   * settles. The numeric readout still previews live via `input`. */
  onChange?: (v: number) => void;
}): SliderHandle {
  const wrap = document.createElement("div");
  wrap.className = "k-slider";
  const head = document.createElement("div");
  head.className = "k-slider-head";
  const name = document.createElement("span");
  name.textContent = opts.label;
  const val = document.createElement("span");
  val.className = "k-slider-val";
  const fmt = opts.format ?? ((v: number) => String(v));
  val.textContent = fmt(opts.value);
  head.append(name, val);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    val.textContent = fmt(v);
    opts.onInput?.(v);
  });
  if (opts.onChange) {
    input.addEventListener("change", () => opts.onChange?.(parseFloat(input.value)));
  }
  wrap.append(head, input);
  return { el: wrap, input, setValueText: (t) => (val.textContent = t) };
}

// -- Chip --------------------------------------------------------------------

export function Chip(opts: {
  label: string;
  on?: boolean;
  icon?: IconName;
  onClick?: () => void;
}): HTMLButtonElement {
  const c = document.createElement("button");
  c.type = "button";
  c.className = "k-chip";
  if (opts.on) c.classList.add("k-chip--on");
  if (opts.icon) c.appendChild(icon(opts.icon));
  const span = document.createElement("span");
  span.textContent = opts.label;
  c.appendChild(span);
  if (opts.onClick) c.addEventListener("click", opts.onClick);
  return c;
}

// -- StatusPill --------------------------------------------------------------

export type PillState = "connected" | "connecting" | "offline" | "error";

export interface PillHandle {
  el: HTMLButtonElement;
  set: (state: PillState, text: string) => void;
}

export function StatusPill(onClick?: () => void): PillHandle {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "k-pill";
  b.dataset["state"] = "offline";
  const dot = document.createElement("span");
  dot.className = "k-pill-dot";
  const label = document.createElement("span");
  label.textContent = "offline";
  b.append(dot, label);
  if (onClick) b.addEventListener("click", onClick);
  return {
    el: b,
    set: (state, text) => {
      b.dataset["state"] = state;
      label.textContent = text;
    },
  };
}

// -- EmptyState --------------------------------------------------------------

export function EmptyState(opts: {
  icon?: IconName;
  title: string;
  action?: HTMLElement | undefined;
}): HTMLElement {
  const d = document.createElement("div");
  d.className = "k-empty";
  if (opts.icon) d.appendChild(icon(opts.icon));
  const t = document.createElement("div");
  t.textContent = opts.title;
  d.appendChild(t);
  if (opts.action) d.appendChild(opts.action);
  return d;
}

// -- Sheet (bottom sheet / modal) --------------------------------------------

export interface SheetHandle {
  body: HTMLElement;
  close: () => void;
}

/** Open a bottom sheet. Returns a handle whose `body` you populate; the sheet
 * animates in immediately and closes on scrim tap / the ✕ button / handle. */
export function Sheet(title: string, opts: { onClose?: () => void } = {}): SheetHandle {
  const scrim = document.createElement("div");
  scrim.className = "k-sheet-scrim";
  const sheet = document.createElement("div");
  sheet.className = "k-sheet";
  const head = document.createElement("div");
  head.className = "k-sheet-head";
  const h = document.createElement("h2");
  h.textContent = title;
  const x = IconButton("close", { title: "Close", onClick: () => close() });
  head.append(h, x);
  const body = document.createElement("div");
  sheet.append(head, body);
  document.body.append(scrim, sheet);
  requestAnimationFrame(() => {
    scrim.classList.add("k-sheet--in");
    sheet.classList.add("k-sheet--in");
  });
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    opts.onClose?.();
    scrim.classList.remove("k-sheet--in");
    sheet.classList.remove("k-sheet--in");
    setTimeout(() => {
      scrim.remove();
      sheet.remove();
    }, 320);
  }
  scrim.addEventListener("click", () => close());
  return { body, close };
}

// -- Confirm dialog ----------------------------------------------------------

/**
 * A centered modal confirmation in the app design language — a replacement for
 * the browser's `confirm()`. Dims + blurs the app behind it, animates in like a
 * Sheet, and resolves `true` (confirmed) / `false` (cancelled, scrim tap, ✕-less
 * Escape). Set `danger` for destructive actions (red confirm button). Set
 * `trippy` (FUG-127) to melt the flat blur into an animated diffraction warp —
 * used by the Acid Mode entry prompt.
 */
export function confirmDialog(opts: {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  trippy?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = opts.trippy ? "k-confirm-scrim k-confirm-scrim--trippy" : "k-confirm-scrim";
    let diffraction: DiffractionHandle | null = null;
    const dialog = document.createElement("div");
    // `trippy` gives the dialog a blur→crisp materialize (see .k-confirm--trippy),
    // to match the Acid Mode diffraction backdrop it opens over.
    dialog.className = opts.trippy ? "k-confirm k-confirm--trippy" : "k-confirm";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    if (opts.title) {
      const h = document.createElement("h2");
      h.className = "k-confirm-title";
      h.textContent = opts.title;
      dialog.appendChild(h);
    }
    const msg = document.createElement("p");
    msg.className = "k-confirm-msg";
    msg.textContent = opts.message;
    dialog.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "k-confirm-actions";
    const cancelBtn = Button({
      label: opts.cancelLabel ?? "Cancel",
      variant: "quiet",
      onClick: () => done(false),
    });
    const confirmBtn = Button({
      label: opts.confirmLabel ?? "Confirm",
      variant: opts.danger ? "danger" : "primary",
      onClick: () => done(true),
    });
    actions.append(cancelBtn, confirmBtn);
    dialog.appendChild(actions);

    document.body.append(scrim, dialog);
    // Force the pre-`--in` styles (opacity 0, blurred/scaled ghost) to resolve as
    // the transition baseline BEFORE flipping to `--in`. Without this, the append
    // and the class-add coalesce into a single style pass and the browser paints
    // the dialog straight in its final state — the entrance transition never fires
    // and it "pops". Reading layout flushes the baseline.
    void dialog.offsetHeight;
    requestAnimationFrame(() => {
      scrim.classList.add("k-confirm--in");
      dialog.classList.add("k-confirm--in");
      confirmBtn.focus();
      if (opts.trippy) diffraction = attachDiffractionBackdrop(scrim);
    });

    let closed = false;
    function done(result: boolean): void {
      if (closed) return;
      closed = true;
      diffraction?.detach();
      document.removeEventListener("keydown", onKey);
      scrim.classList.remove("k-confirm--in");
      dialog.classList.remove("k-confirm--in");
      setTimeout(() => {
        scrim.remove();
        dialog.remove();
      }, 200);
      resolve(result);
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") done(false);
    }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", () => done(false));
  });
}

// -- Toast -------------------------------------------------------------------

let toastHost: HTMLElement | null = null;
function ensureToastHost(): HTMLElement {
  if (toastHost === null) {
    toastHost = document.createElement("div");
    toastHost.className = "k-toast-host";
    document.body.append(toastHost);
  }
  return toastHost;
}

export function toast(message: string, opts: { error?: boolean; ms?: number } = {}): void {
  const host = ensureToastHost();
  const t = document.createElement("div");
  t.className = "k-toast";
  if (opts.error) t.classList.add("k-toast--err");
  t.textContent = message;
  host.append(t);
  requestAnimationFrame(() => t.classList.add("k-toast--in"));
  setTimeout(() => {
    t.classList.remove("k-toast--in");
    setTimeout(() => t.remove(), 160);
  }, opts.ms ?? 2600);
}

// -- HelpTip -----------------------------------------------------------------

export interface HelpTipHandle {
  el: HTMLElement;
  /** Reveal the popover (e.g. to start expanded). No-op if already open. */
  open: () => void;
  close: () => void;
}

/**
 * A floating help affordance: a small “?” trigger that reveals a popover bubble
 * with explanatory text and an optional action. This is the shared pattern for
 * inline help across the app — a light, dismissible tooltip rather than a card
 * baked into the content flow. The caller positions `el` (e.g. an absolute/
 * fixed corner) via a wrapper class; the popover anchors to the trigger.
 */
export function HelpTip(opts: {
  title?: string;
  body: string | Node;
  action?: { label: string; icon?: IconName; onClick: () => void };
  label?: string; // aria-label for the trigger
  align?: "left" | "right"; // which edge the popover aligns to (default right)
  // Which vertical direction the popover opens (default "down"). Use "up" when
  // the trigger sits near the bottom of the viewport so the bubble stays in
  // bounds (e.g. the first-run tour hint anchored above the tab bar).
  direction?: "up" | "down";
  defaultOpen?: boolean; // start expanded (e.g. a first-run hint) instead of collapsed
  // Fired when the USER dismisses an open tip (outside press / Escape / tapping
  // the trigger) — NOT on a programmatic `close()` (teardown, the action button).
  // Lets a first-run hint record that it's been acknowledged.
  onDismiss?: () => void;
}): HelpTipHandle {
  const el = document.createElement("div");
  el.className = "k-helptip";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "k-helptip-btn";
  const lbl = opts.label ?? "Help";
  btn.title = lbl;
  btn.setAttribute("aria-label", lbl);
  btn.setAttribute("aria-expanded", "false");
  btn.appendChild(icon("help"));

  // Visibility is driven entirely by the `.k-helptip--open` class on `el` (see
  // tokens.css) rather than the `hidden` attribute: the popover's own
  // `display: flex` would override `[hidden]`, so toggling `hidden` could never
  // dismiss it. Class-based state also lets the bubble animate in/out.
  const pop = document.createElement("div");
  pop.className = "k-helptip-pop";
  if (opts.align === "left") pop.classList.add("k-helptip-pop--left");
  if (opts.direction === "up") pop.classList.add("k-helptip-pop--up");
  if (opts.title) {
    const t = document.createElement("div");
    t.className = "k-helptip-title";
    t.textContent = opts.title;
    pop.appendChild(t);
  }
  const body = document.createElement("div");
  body.className = "k-helptip-body";
  if (typeof opts.body === "string") body.textContent = opts.body;
  else body.appendChild(opts.body);
  pop.appendChild(body);
  if (opts.action) {
    const a = opts.action;
    const btnOpts: ButtonOpts = {
      label: a.label,
      variant: "primary",
      onClick: () => {
        close();
        a.onClick();
      },
    };
    if (a.icon) btnOpts.icon = a.icon;
    pop.appendChild(Button(btnOpts));
  }

  let open = false;
  // Dismiss on any press outside the tip. Registered in the CAPTURE phase so a
  // stray `stopPropagation()` on an in-app control (effect rows, editor panes,
  // the layout drag handles all do this) can't swallow the press before it
  // reaches us — a bubble-phase listener here would leave the tip stuck open.
  // `pointerdown` (not `click`) makes the dismissal feel immediate.
  function onDocPointer(ev: Event): void {
    if (!el.contains(ev.target as Node)) dismiss();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      dismiss();
      btn.focus();
    }
  }
  function openPop(): void {
    if (open) return;
    open = true;
    btn.setAttribute("aria-expanded", "true");
    el.classList.add("k-helptip--open");
    // Defer registration so the very press that opened the tip doesn't also
    // count as an outside press and close it again.
    setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointer, true);
      document.addEventListener("keydown", onKey);
    }, 0);
  }
  function close(): void {
    if (!open) return;
    open = false;
    btn.setAttribute("aria-expanded", "false");
    el.classList.remove("k-helptip--open");
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey);
  }
  // User-initiated close (vs. the programmatic `close()` used for teardown / the
  // action button): collapse, then notify so a first-run hint can be recorded.
  function dismiss(): void {
    if (!open) return;
    close();
    opts.onDismiss?.();
  }
  btn.addEventListener("click", () => (open ? dismiss() : openPop()));

  el.append(btn, pop);
  // Start expanded when asked (e.g. a first-run hint that should be seen without
  // a click). The wrapper carries `.k-helptip--open` from the outset, so it
  // mounts already-open; the outside-press/Escape dismissal then applies as usual.
  if (opts.defaultOpen) openPop();
  return { el, open: openPop, close };
}
