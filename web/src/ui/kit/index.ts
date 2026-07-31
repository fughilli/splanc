/**
 * Shared UI kit (design doc §2.5 / §7.2) — plain DOM factories, no framework.
 * Each factory returns a live HTMLElement (plus a small handle where a control
 * needs imperative updates). Styling lives in tokens.css; these apply the
 * `k-*` classes and wire events.
 */

import { icon, type IconName } from "./icons";

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
  opts: { title?: string; onClick?: () => void } = {},
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "k-iconbtn";
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

  const pop = document.createElement("div");
  pop.className = "k-helptip-pop";
  if (opts.align === "left") pop.classList.add("k-helptip-pop--left");
  pop.hidden = true;
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
  function onDocClick(ev: MouseEvent): void {
    if (!el.contains(ev.target as Node)) close();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "Escape") close();
  }
  function openPop(): void {
    open = true;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    el.classList.add("k-helptip--open");
    setTimeout(() => {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    }, 0);
  }
  function close(): void {
    open = false;
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    el.classList.remove("k-helptip--open");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  }
  btn.addEventListener("click", () => (open ? close() : openPop()));

  el.append(btn, pop);
  return { el, close };
}
