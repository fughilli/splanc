/**
 * Editor selection actions (D-541 PR 6, owner answer D-551): things you can do
 * with the word under the caret or the selected code. On desktop they appear in
 * a right-click menu; on a phone a floating chip appears under a selection made
 * by touch, clear of the native callout (which sits above the selection).
 *
 * The first action is "Go to docs"; Watch ("Add to Watch") will register here
 * too, so each action decides for itself whether it applies.
 */

import { icon, type IconName } from "../../ui/kit";

/** What an action sees: the source, the selection (or caret when equal), the
 * selected text and the documented term there (null when nothing is). */
export interface SelectionContext {
  src: string;
  start: number;
  end: number;
  text: string;
  term: string | null;
}

export interface SelectionAction {
  id: string;
  icon: IconName;
  /** The label for this context, e.g. "Docs: sin". */
  label: (ctx: SelectionContext) => string;
  /** Whether the action applies (e.g. Go to docs needs a documented term). */
  available: (ctx: SelectionContext) => boolean;
  run: (ctx: SelectionContext) => void;
}

/** The actions that apply in `ctx`, in registration order. */
export function availableActions(actions: readonly SelectionAction[], ctx: SelectionContext): SelectionAction[] {
  return actions.filter((a) => a.available(ctx));
}

/** A pixel position inside the code wrapper for a source offset (the top of
 * its line), and the line height. */
export type CaretPixelFn = (offset: number) => { left: number; top: number; lineH: number };

interface Opts {
  code: HTMLTextAreaElement;
  /** The positioned wrapper the chip is placed in (same box as the textarea). */
  wrap: HTMLElement;
  caretPixel: CaretPixelFn;
  /** Builds the context for the current selection. */
  context: () => SelectionContext;
  actions: () => readonly SelectionAction[];
}

/** Gap between the selection's last line and the chip: room for the touch
 * selection handles. */
const CHIP_GAP_PX = 30;

/**
 * Wires the right-click menu and the touch chip to a code textarea. Mouse
 * right-click with a documented word opens our menu (Shift+right-click, or a
 * spot with nothing to act on, keeps the browser's own menu); a touch selection
 * shows the chip once the selection settles.
 */
export class SelectionActions {
  private readonly opts: Opts;
  private readonly chip: HTMLDivElement;
  private menu: HTMLDivElement | null = null;
  private lastPointer = "mouse";
  private chipTimer: number | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(opts: Opts) {
    this.opts = opts;
    this.chip = document.createElement("div");
    this.chip.className = "fxsel-chip";
    this.chip.setAttribute("role", "toolbar");
    this.chip.setAttribute("aria-label", "Selection actions");
    this.chip.style.display = "none";
    opts.wrap.appendChild(this.chip);

    const { code } = opts;
    this.on(code, "pointerdown", (ev) => {
      this.lastPointer = (ev as PointerEvent).pointerType || "mouse";
    });
    this.on(code, "touchstart", () => {
      this.lastPointer = "touch";
    });
    this.on(code, "contextmenu", (ev) => this.onContextMenu(ev as MouseEvent));
    this.on(code, "input", () => this.hideChip());
    this.on(code, "scroll", () => {
      this.hideChip();
      this.closeMenu();
    });
    this.on(code, "blur", () => {
      // Let a tap on the chip land before it goes away.
      window.setTimeout(() => {
        if (document.activeElement !== code) this.hideChip();
      }, 200);
    });
    this.on(document, "selectionchange", () => this.onSelectionChange());
  }

  private on(t: EventTarget, type: string, fn: (ev: Event) => void): void {
    t.addEventListener(type, fn);
    this.cleanups.push(() => t.removeEventListener(type, fn));
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    if (this.chipTimer !== null) clearTimeout(this.chipTimer);
    this.closeMenu();
    this.chip.remove();
  }

  // ---- touch chip -----------------------------------------------------------

  private onSelectionChange(): void {
    const { code } = this.opts;
    if (document.activeElement !== code || this.lastPointer === "mouse") return;
    if (this.chipTimer !== null) clearTimeout(this.chipTimer);
    if (code.selectionStart === code.selectionEnd) {
      this.hideChip();
      return;
    }
    // Wait for the handles to settle so the chip doesn't chase a drag.
    this.chipTimer = window.setTimeout(() => {
      this.chipTimer = null;
      this.showChip();
    }, 280);
  }

  private showChip(): void {
    const { code, wrap } = this.opts;
    if (code.selectionStart === code.selectionEnd) return this.hideChip();
    const ctx = this.opts.context();
    const acts = availableActions(this.opts.actions(), ctx);
    if (acts.length === 0) return this.hideChip();
    this.chip.replaceChildren(
      ...acts.map((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "fxsel-chip-btn";
        b.append(icon(a.icon));
        const span = document.createElement("span");
        span.textContent = a.label(ctx);
        b.append(span);
        // Keep the textarea's focus and selection while tapping.
        b.addEventListener("pointerdown", (ev) => ev.preventDefault());
        b.addEventListener("click", () => {
          this.hideChip();
          a.run(ctx);
        });
        return b;
      }),
    );
    this.chip.style.display = "";
    // Below the selection's last line, clear of the handles; flipped above the
    // first line when it would leave the pane.
    const endPx = this.opts.caretPixel(Math.max(code.selectionStart, code.selectionEnd));
    const startPx = this.opts.caretPixel(Math.min(code.selectionStart, code.selectionEnd));
    const h = this.chip.offsetHeight;
    const w = this.chip.offsetWidth;
    let top = endPx.top + endPx.lineH + CHIP_GAP_PX;
    if (top + h > wrap.clientHeight - 4) top = Math.max(4, startPx.top - h - CHIP_GAP_PX);
    const left = Math.max(8, Math.min(endPx.left - w / 2, wrap.clientWidth - w - 8));
    this.chip.style.top = `${top}px`;
    this.chip.style.left = `${left}px`;
  }

  hideChip(): void {
    if (this.chip.style.display === "none") return;
    this.chip.style.display = "none";
  }

  // ---- desktop context menu -------------------------------------------------

  private onContextMenu(ev: MouseEvent): void {
    // Touch long-press also fires contextmenu (Android): the chip covers touch.
    if (this.lastPointer === "touch" || ev.shiftKey) return;
    const ctx = this.opts.context();
    const acts = availableActions(this.opts.actions(), ctx);
    if (acts.length === 0) return; // nothing to offer: keep the browser's menu
    ev.preventDefault();
    this.openMenu(ev.clientX, ev.clientY, ctx, acts);
  }

  private openMenu(x: number, y: number, ctx: SelectionContext, acts: SelectionAction[]): void {
    this.closeMenu();
    const { code } = this.opts;
    const menu = document.createElement("div");
    menu.className = "fxsel-menu";
    menu.setAttribute("role", "menu");
    const item = (label: string, ic: IconName | null, run: () => void): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fxsel-menu-item";
      b.setAttribute("role", "menuitem");
      if (ic) b.append(icon(ic));
      const span = document.createElement("span");
      span.textContent = label;
      b.append(span);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        this.closeMenu();
        run();
      });
      menu.append(b);
    };
    for (const a of acts) item(a.label(ctx), a.icon, () => a.run(ctx));
    const sep = document.createElement("div");
    sep.className = "fxsel-menu-sep";
    menu.append(sep);
    if (ctx.start !== ctx.end) {
      item("Cut", null, () => {
        code.focus();
        document.execCommand("cut");
      });
      item("Copy", null, () => {
        code.focus();
        document.execCommand("copy");
      });
    }
    item("Paste", null, () => {
      code.focus();
      void navigator.clipboard
        ?.readText()
        .then((t) => {
          if (t) document.execCommand("insertText", false, t);
        })
        .catch(() => undefined);
    });
    const hint = document.createElement("div");
    hint.className = "fxsel-menu-hint";
    hint.textContent = "Shift+right-click for the browser menu";
    menu.append(hint);
    document.body.append(menu);
    // Keep it on screen.
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    this.menu = menu;
    const onDown = (e: Event): void => {
      if (!menu.contains(e.target as Node)) this.closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") this.closeMenu();
    };
    // Deferred so the opening right-click doesn't close it.
    window.setTimeout(() => {
      if (this.menu !== menu) return;
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", this.closeMenuBound);
    }, 0);
    this.menuCleanup = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", this.closeMenuBound);
    };
    (menu.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  private menuCleanup: (() => void) | null = null;
  private readonly closeMenuBound = (): void => this.closeMenu();

  closeMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = null;
    this.menu?.remove();
    this.menu = null;
  }
}
