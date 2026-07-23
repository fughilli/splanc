/**
 * FxLayout — the responsive, composable workspace for the effect editor.
 *
 * The editor's sub-views ("panes") are STABLE DOM nodes created once by the
 * screen (the code textarea+backdrop, the MapView canvas, the uniform panel,
 * the chat log, diagnostics, disassembly). This module never recreates those
 * nodes — it only RE-PARENTS them between containers when the layout changes,
 * so the code editor keeps its caret/scroll, the completion mirror stays
 * co-located, and MapView keeps drawing to the same canvas.
 *
 * Two modes, chosen by viewport width (a matchMedia at 720px):
 *
 *  • NARROW (< 720px): Code + Uniforms are the primary, always-visible views,
 *    stacked with a draggable split divider (code gets the majority). The other
 *    panes (Preview, Diagnostics, Disassembly, Chat) live in an overflow tab
 *    strip — a "Views" segmented switcher that shows exactly one secondary pane
 *    at a time (tap the active tab again to collapse it).
 *
 *  • WIDE (>= 720px): an N-up workspace of five regions —
 *        ┌──────────────── top ────────────────┐
 *        │ left │      center      │   right    │
 *        └────────────── bottom ───────────────┘
 *    Each region holds an ordered list of panes stacked vertically. Draggable
 *    dividers resize the columns (left|center|right) and the top/bottom rows.
 *    Each pane header has a ⋯-style relocate menu (snap to a region) and a
 *    hide toggle. The arrangement (which panes are where + split sizes + hidden
 *    set) persists to localStorage under a versioned key and survives reloads.
 */

import { icon } from "../../ui/kit/icons";

export type Region = "top" | "left" | "center" | "right" | "bottom";
const REGIONS: Region[] = ["top", "left", "center", "right", "bottom"];
const REGION_LABEL: Record<Region, string> = {
  top: "Top",
  left: "Left",
  center: "Center",
  right: "Right",
  bottom: "Bottom",
};

export interface PaneSpec {
  id: string;
  title: string;
  /** Primary panes are always visible on narrow (code / uniforms). */
  primary?: boolean;
  /** The STABLE content node — re-parented, never recreated. */
  node: HTMLElement;
}

interface Persisted {
  v: number;
  slots: Record<Region, string[]>;
  colSizes: [number, number, number]; // fractions for left|center|right
  rowSizes: [number, number]; // fractions for top | bottom (of a nominal budget)
  split: number; // narrow: code-height fraction 0..1
  hidden: string[];
  activeTab: string | null; // narrow overflow active pane id (or null = collapsed)
}

const STORAGE_KEY = "fxedit.layout.v1";
const NARROW_QUERY = "(max-width: 719px)";

/** Default WIDE arrangement: Code on the left; Uniforms + Preview stacked on
 * the right; Chat / Diagnostics / Disassembly as secondary panes in center. */
function defaultLayout(): Persisted {
  return {
    v: 1,
    slots: {
      top: [],
      left: ["code"],
      center: ["chat", "diagnostics", "disasm"],
      right: ["uniforms", "preview"],
      bottom: [],
    },
    colSizes: [0.42, 0.3, 0.28],
    rowSizes: [0, 0], // top/bottom empty by default
    split: 0.62,
    hidden: ["disasm"],
    activeTab: "preview",
  };
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLayout();
    const p = JSON.parse(raw) as Partial<Persisted>;
    if (p.v !== 1 || !p.slots) return defaultLayout();
    const def = defaultLayout();
    return {
      v: 1,
      slots: {
        top: p.slots.top ?? [],
        left: p.slots.left ?? [],
        center: p.slots.center ?? [],
        right: p.slots.right ?? [],
        bottom: p.slots.bottom ?? [],
      },
      colSizes: p.colSizes ?? def.colSizes,
      rowSizes: p.rowSizes ?? def.rowSizes,
      split: typeof p.split === "number" ? p.split : def.split,
      hidden: p.hidden ?? def.hidden,
      activeTab: p.activeTab ?? def.activeTab,
    };
  } catch {
    return defaultLayout();
  }
}

interface Opts {
  /** The editor header row (name + ⋯ menu + compile chip live here). Re-parented
   * to the top of the workspace on every render so it stays visible. */
  header: HTMLElement;
  /** The effect-name field row, kept alongside the header. */
  nameEl: HTMLElement;
  panes: PaneSpec[];
  /** Called after any relayout (DOM re-parent) or viewport resize, so the screen
   * can recompute the MapView canvas backing store. */
  onRelayout: () => void;
}

export class FxLayout {
  readonly root: HTMLElement;
  private readonly panes = new Map<string, PaneSpec>();
  private readonly order: string[];
  private state: Persisted;
  private readonly opts: Opts;
  private readonly mql: MediaQueryList;
  private readonly onMedia: () => void;
  private readonly onWinResize: () => void;
  private mounted = false;
  private resizeTimer: number | null = null;

  // Reusable pane-wrapper nodes (one per pane id, stable across relayouts).
  private readonly wrappers = new Map<string, PaneWrap>();
  private openRelocate: (() => void) | null = null;

  constructor(opts: Opts) {
    this.opts = opts;
    this.order = opts.panes.map((p) => p.id);
    for (const p of opts.panes) this.panes.set(p.id, p);
    this.state = loadPersisted();
    this.reconcileState();

    this.root = document.createElement("div");
    this.root.className = "fxlayout";

    for (const p of opts.panes) this.wrappers.set(p.id, new PaneWrap(this, p));

    this.mql = window.matchMedia(NARROW_QUERY);
    this.onMedia = () => this.render();
    this.onWinResize = () => {
      if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.opts.onRelayout(), 80);
    };
  }

  /** Ensure every known pane appears in exactly one slot and every slot id is
   * known — guards against stale/partial persisted layouts. */
  private reconcileState(): void {
    const seen = new Set<string>();
    for (const r of REGIONS) {
      this.state.slots[r] = this.state.slots[r].filter((id) => {
        if (!this.panes.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    for (const id of this.order) {
      if (!seen.has(id)) {
        // Missing pane → put it somewhere sensible.
        const spec = this.panes.get(id)!;
        const target: Region = spec.primary ? (id === "code" ? "left" : "right") : "center";
        this.state.slots[target].push(id);
        seen.add(id);
      }
    }
    this.state.hidden = this.state.hidden.filter((id) => this.panes.has(id));
  }

  mount(): void {
    this.mounted = true;
    this.mql.addEventListener("change", this.onMedia);
    window.addEventListener("resize", this.onWinResize);
    this.render();
  }

  unmount(): void {
    this.mounted = false;
    this.mql.removeEventListener("change", this.onMedia);
    window.removeEventListener("resize", this.onWinResize);
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.closeRelocate();
  }

  isVisible(id: string): boolean {
    return !this.state.hidden.includes(id);
  }

  setVisible(id: string, on: boolean): void {
    const has = this.state.hidden.includes(id);
    if (on && has) this.state.hidden = this.state.hidden.filter((x) => x !== id);
    else if (!on && !has) this.state.hidden.push(id);
    else return;
    // On narrow, showing a secondary pane also makes it the active tab.
    if (on && this.mql.matches) {
      const spec = this.panes.get(id);
      if (spec && !spec.primary) this.state.activeTab = id;
    }
    this.persist();
    this.render();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage full / disabled — the layout still works this session */
    }
  }

  /** Move a pane to a region (wide) — appended to that region's stack. */
  relocate(id: string, region: Region): void {
    for (const r of REGIONS) {
      this.state.slots[r] = this.state.slots[r].filter((x) => x !== id);
    }
    this.state.slots[region].push(id);
    this.persist();
    this.render();
  }

  regionOf(id: string): Region {
    for (const r of REGIONS) if (this.state.slots[r].includes(id)) return r;
    return "center";
  }

  // -- rendering ------------------------------------------------------------

  private render(): void {
    if (!this.mounted) return;
    this.closeRelocate();
    this.root.replaceChildren();
    const narrow = this.mql.matches;
    this.root.classList.toggle("fxlayout--narrow", narrow);
    this.root.classList.toggle("fxlayout--wide", !narrow);
    if (narrow) this.renderNarrow();
    else this.renderWide();
    // Panes moved DOM parents — recompute canvas + notify the screen.
    requestAnimationFrame(() => this.opts.onRelayout());
  }

  /** Detach a pane's content into its wrapper body and return the wrapper. */
  private wrapped(id: string, showControls: boolean): HTMLElement {
    const w = this.wrappers.get(id)!;
    w.setControlsVisible(showControls);
    w.syncHideLabel(this.isVisible(id));
    return w.attach();
  }

  private renderWide(): void {
    // Header on top, then the grid.
    this.root.append(this.opts.header, this.opts.nameEl);

    const grid = document.createElement("div");
    grid.className = "fxlayout-grid";

    const hasTop = this.visibleIn("top").length > 0;
    const hasBottom = this.visibleIn("bottom").length > 0;
    // Row template includes explicit divider tracks so the grid track count
    // matches the appended children (slot / divider / mid / divider / slot).
    grid.style.gridTemplateRows = this.gridRowTemplate();

    if (hasTop) {
      grid.appendChild(this.renderSlot("top"));
      grid.appendChild(this.divider("row-top"));
    }

    // Middle row: left | center | right with column dividers.
    const mid = document.createElement("div");
    mid.className = "fxlayout-midrow";
    const cols = (["left", "center", "right"] as Region[]).filter(
      (r) => this.visibleIn(r).length > 0,
    );
    mid.style.gridTemplateColumns = this.midColTemplate(cols);
    cols.forEach((r, i) => {
      mid.appendChild(this.renderSlot(r));
      if (i < cols.length - 1) mid.appendChild(this.divider(`col-${r}`));
    });
    grid.appendChild(mid);

    if (hasBottom) {
      grid.appendChild(this.divider("row-bottom"));
      grid.appendChild(this.renderSlot("bottom"));
    }

    this.root.appendChild(grid);
  }

  private midColTemplate(cols: Region[]): string {
    const idx: Record<string, number> = { left: 0, center: 1, right: 2 };
    const parts: string[] = [];
    cols.forEach((r, i) => {
      const f = Math.max(0.12, this.state.colSizes[idx[r]!] ?? 0.33);
      parts.push(`${f}fr`);
      if (i < cols.length - 1) parts.push("var(--fxdiv)");
    });
    return parts.join(" ");
  }

  private visibleIn(region: Region): string[] {
    return this.state.slots[region].filter((id) => this.isVisible(id));
  }

  private renderSlot(region: Region): HTMLElement {
    const slot = document.createElement("div");
    slot.className = `fxlayout-slot fxlayout-slot--${region}`;
    for (const id of this.visibleIn(region)) {
      slot.appendChild(this.wrapped(id, true));
    }
    return slot;
  }

  private divider(kind: string): HTMLElement {
    const d = document.createElement("div");
    const horizontal = kind.startsWith("col-");
    d.className = "fxlayout-divider " + (horizontal ? "fxlayout-divider--v" : "fxlayout-divider--h");
    d.setAttribute("role", "separator");
    d.addEventListener("pointerdown", (e) => this.startDividerDrag(e, kind, horizontal));
    return d;
  }

  private startDividerDrag(e: PointerEvent, kind: string, horizontal: boolean): void {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const container = horizontal
      ? (target.parentElement as HTMLElement) // .fxlayout-midrow
      : (target.parentElement as HTMLElement); // .fxlayout-grid
    target.setPointerCapture(e.pointerId);
    const rect = container.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;

    const move = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
      const frac = clamp(pos / Math.max(1, total), 0.12, 0.88);
      this.applyDivider(kind, frac);
      this.opts.onRelayout();
    };
    const up = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      this.persist();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  /** Update the relevant size fraction and re-apply the grid template in place
   * (no full re-render — panes keep their DOM parents while dragging). */
  private applyDivider(kind: string, frac: number): void {
    const grid = this.root.querySelector(".fxlayout-grid") as HTMLElement | null;
    const mid = this.root.querySelector(".fxlayout-midrow") as HTMLElement | null;
    if (kind === "row-top") {
      // frac is the top's share of the whole grid height.
      this.state.rowSizes[0] = frac;
      if (grid) grid.style.gridTemplateRows = this.gridRowTemplate();
    } else if (kind === "row-bottom") {
      this.state.rowSizes[1] = 1 - frac;
      if (grid) grid.style.gridTemplateRows = this.gridRowTemplate();
    } else if (kind.startsWith("col-")) {
      const cols = (["left", "center", "right"] as Region[]).filter(
        (r) => this.visibleIn(r).length > 0,
      );
      const idx: Record<string, number> = { left: 0, center: 1, right: 2 };
      const which = kind.slice(4) as Region; // the col to the LEFT of the divider
      const pos = cols.indexOf(which);
      const next = cols[pos + 1];
      if (next) {
        // Redistribute only within this adjacent pair; other columns keep their
        // fractions. `frac` is the divider's position across the whole midrow —
        // convert it to a share of the pair's combined span so the drag tracks
        // the pointer regardless of how many columns precede the pair.
        const a = this.state.colSizes[idx[which]!]!;
        const b = this.state.colSizes[idx[next]!]!;
        const pair = a + b;
        const before = cols.slice(0, pos).reduce((s, r) => s + this.state.colSizes[idx[r]!]!, 0);
        const totalF = cols.reduce((s, r) => s + this.state.colSizes[idx[r]!]!, 0);
        const local = clamp((frac * totalF - before) / pair, 0.15, 0.85);
        this.state.colSizes[idx[which]!] = pair * local;
        this.state.colSizes[idx[next]!] = pair * (1 - local);
      }
      if (mid) mid.style.gridTemplateColumns = this.midColTemplate(cols);
    }
  }

  private gridRowTemplate(): string {
    const hasTop = this.visibleIn("top").length > 0;
    const hasBottom = this.visibleIn("bottom").length > 0;
    const rows: string[] = [];
    if (hasTop) rows.push(`${Math.max(0.08, this.state.rowSizes[0] || 0.22)}fr`, "var(--fxdiv)");
    rows.push("1fr");
    if (hasBottom) rows.push("var(--fxdiv)", `${Math.max(0.08, this.state.rowSizes[1] || 0.22)}fr`);
    return rows.join(" ");
  }

  private renderNarrow(): void {
    this.root.append(this.opts.header, this.opts.nameEl);

    // Primary split: code over uniforms with a draggable divider.
    const split = document.createElement("div");
    split.className = "fxlayout-nsplit";
    const codeShare = clamp(this.state.split, 0.25, 0.85);
    split.style.gridTemplateRows = `${codeShare}fr var(--fxdiv) ${1 - codeShare}fr`;

    const codeCell = document.createElement("div");
    codeCell.className = "fxlayout-ncell";
    codeCell.appendChild(this.wrapped("code", false));

    const uniCell = document.createElement("div");
    uniCell.className = "fxlayout-ncell";
    uniCell.appendChild(this.wrapped("uniforms", false));

    const div = document.createElement("div");
    div.className = "fxlayout-divider fxlayout-divider--h";
    div.setAttribute("role", "separator");
    div.addEventListener("pointerdown", (e) => this.startNarrowSplitDrag(e, split));

    split.append(codeCell, div, uniCell);
    this.root.appendChild(split);

    // Overflow "Views" tab strip for the secondary panes.
    const secondary = this.order.filter((id) => !this.panes.get(id)!.primary);
    const strip = document.createElement("div");
    strip.className = "fxlayout-tabs";
    for (const id of secondary) {
      const spec = this.panes.get(id)!;
      const active = this.state.activeTab === id;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fxlayout-tab" + (active ? " fxlayout-tab--active" : "");
      btn.textContent = spec.title;
      btn.addEventListener("click", () => {
        // Tap active → collapse; else activate (and mark visible).
        this.state.activeTab = active ? null : id;
        if (this.state.activeTab && this.state.hidden.includes(id)) {
          this.state.hidden = this.state.hidden.filter((x) => x !== id);
        }
        this.persist();
        this.render();
      });
      strip.appendChild(btn);
    }
    this.root.appendChild(strip);

    // The one active secondary pane (if any).
    const activeId = this.state.activeTab;
    if (activeId && secondary.includes(activeId)) {
      const sheet = document.createElement("div");
      sheet.className = "fxlayout-nsheet";
      sheet.appendChild(this.wrapped(activeId, false));
      this.root.appendChild(sheet);
    }
  }

  private startNarrowSplitDrag(e: PointerEvent, split: HTMLElement): void {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const rect = split.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const frac = clamp((ev.clientY - rect.top) / Math.max(1, rect.height), 0.25, 0.85);
      this.state.split = frac;
      split.style.gridTemplateRows = `${frac}fr var(--fxdiv) ${1 - frac}fr`;
      this.opts.onRelayout();
    };
    const up = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      this.persist();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  // -- relocate popover (shared, one at a time) -----------------------------

  showRelocate(anchor: HTMLElement, id: string): void {
    this.closeRelocate();
    const pop = document.createElement("div");
    pop.className = "fxlayout-relo";
    const cur = this.regionOf(id);
    const title = document.createElement("div");
    title.className = "fxlayout-relo-title";
    title.textContent = "Move to";
    pop.appendChild(title);
    for (const r of REGIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fxlayout-relo-item" + (r === cur ? " fxlayout-relo-item--cur" : "");
      b.textContent = REGION_LABEL[r];
      b.addEventListener("click", () => {
        this.closeRelocate();
        this.relocate(id, r);
      });
      pop.appendChild(b);
    }
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "fxlayout-relo-item fxlayout-relo-hide";
    hide.textContent = "Hide pane";
    hide.addEventListener("click", () => {
      this.closeRelocate();
      this.setVisible(id, false);
    });
    pop.appendChild(hide);

    anchor.parentElement?.appendChild(pop);
    const onDoc = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node) && ev.target !== anchor) this.closeRelocate();
    };
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    this.openRelocate = () => {
      document.removeEventListener("click", onDoc);
      pop.remove();
    };
  }

  private closeRelocate(): void {
    this.openRelocate?.();
    this.openRelocate = null;
  }
}

/** A reusable pane wrapper: a header (title + relocate + hide) over the pane's
 * STABLE content node. Created once per pane; `attach()` moves the content node
 * back into this wrapper's body (it may currently live in a different wrapper's
 * body after a prior render — but there is exactly one wrapper per id, so the
 * node is simply re-parented into the DOM tree the wrapper is placed in). */
class PaneWrap {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly reloBtn: HTMLButtonElement;
  private readonly hideBtn: HTMLButtonElement;
  private readonly controls: HTMLElement;

  constructor(
    private readonly owner: FxLayout,
    private readonly spec: PaneSpec,
  ) {
    this.el = document.createElement("section");
    this.el.className = "fxpane";
    this.el.dataset.pane = spec.id;

    const head = document.createElement("div");
    head.className = "fxpane-head";
    const title = document.createElement("span");
    title.className = "fxpane-title";
    title.textContent = spec.title;

    this.controls = document.createElement("div");
    this.controls.className = "fxpane-ctl";
    this.reloBtn = iconBtn("move", "Move pane", (ev) => {
      ev.stopPropagation();
      this.owner.showRelocate(this.reloBtn, this.spec.id);
    });
    this.hideBtn = iconBtn("close", "Hide pane", (ev) => {
      ev.stopPropagation();
      this.owner.setVisible(this.spec.id, false);
    });
    this.controls.append(this.reloBtn, this.hideBtn);

    head.append(title, this.controls);
    this.body = document.createElement("div");
    this.body.className = "fxpane-body";
    this.body.appendChild(spec.node);
    this.el.append(head, this.body);
  }

  attach(): HTMLElement {
    // The stable content node lives in this.body already; nothing to re-parent
    // at the node level. The wrapper element itself is what gets appended into
    // the target slot by the caller.
    if (this.spec.node.parentElement !== this.body) this.body.appendChild(this.spec.node);
    return this.el;
  }

  setControlsVisible(on: boolean): void {
    this.controls.style.display = on ? "" : "none";
  }

  syncHideLabel(_visible: boolean): void {
    /* reserved for future stateful label; hide button is symmetric today */
  }
}

function iconBtn(name: "move" | "close", title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fxpane-btn";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.appendChild(icon(name));
  b.addEventListener("click", onClick);
  return b;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
