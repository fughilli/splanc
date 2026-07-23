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
 *  • WIDE (>= 720px): an EDGE-DOCK workspace. ONE pane is the CENTER and fills
 *    the remaining space; every other pane is docked to an edge (left / right /
 *    top / bottom) as a resizable strip butting flush against the center:
 *
 *        ┌──────────────── top ────────────────┐
 *        │ left │      CENTER      │   right    │
 *        └────────────── bottom ───────────────┘
 *
 *    Each edge holds one or more panes; when more than one lands on the same
 *    edge they are TABBED (a strip of pane tabs picks the visible one). Hairline
 *    dividers between the center and each occupied edge drag to resize the strip.
 *    Each pane header carries a ⋯-style relocate menu (dock to an edge, or make
 *    it the center) plus a hide toggle. The arrangement (dock of each pane, the
 *    center pane, edge sizes, active tab per edge, hidden set) persists to
 *    localStorage under a versioned key and survives reloads.
 */

import { icon } from "../../ui/kit/icons";

/** Where a pane can live: docked to an edge, or the single center pane. */
export type Dock = "left" | "right" | "top" | "bottom" | "center";
const EDGES: Exclude<Dock, "center">[] = ["left", "right", "top", "bottom"];
const DOCKS: Dock[] = ["center", "left", "right", "top", "bottom"];
const DOCK_LABEL: Record<Dock, string> = {
  center: "Center",
  left: "Dock left",
  right: "Dock right",
  top: "Dock top",
  bottom: "Dock bottom",
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
  /** Which pane is the center (fills the remaining space). */
  center: string;
  /** Ordered pane ids docked at each edge (tabbed when more than one). */
  docks: Record<Exclude<Dock, "center">, string[]>;
  /** Active (front) pane id per edge when tabbed. */
  active: Record<Exclude<Dock, "center">, string | null>;
  /** Edge strip sizes as fractions of the workspace (0..1). */
  edgeSizes: Record<Exclude<Dock, "center">, number>;
  split: number; // narrow: code-height fraction 0..1
  hidden: string[];
  activeTab: string | null; // narrow overflow active pane id (or null = collapsed)
}

const STORAGE_KEY = "fxedit.layout.v2";

// Pane size bounds (fractions of the workspace). Kept intentionally permissive
// so panes can be dragged very small (content crops via overflow:hidden) — the
// dividers track the pointer 1:1 because the center track takes the *remaining*
// fraction (see wideCols/wideRows), not a fixed 1fr.
const MIN_EDGE = 0.04;
const MAX_EDGE = 0.92;
const MIN_CENTER = 0.04;
const MIN_SPLIT = 0.06;
const MAX_SPLIT = 0.94;
const NARROW_QUERY = "(max-width: 719px)";

/** Default WIDE arrangement: Code is the center; Uniforms + Preview dock right;
 * Chat / Diagnostics / Disassembly dock bottom (disasm hidden by default). */
function defaultLayout(): Persisted {
  return {
    v: 2,
    center: "code",
    docks: {
      left: [],
      right: ["uniforms", "preview"],
      top: [],
      bottom: ["diagnostics", "chat", "disasm"],
    },
    active: { left: null, right: "uniforms", top: null, bottom: "diagnostics" },
    edgeSizes: { left: 0.24, right: 0.3, top: 0.25, bottom: 0.32 },
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
    if (p.v !== 2 || !p.docks) return defaultLayout();
    const def = defaultLayout();
    return {
      v: 2,
      center: typeof p.center === "string" ? p.center : def.center,
      docks: {
        left: p.docks.left ?? [],
        right: p.docks.right ?? [],
        top: p.docks.top ?? [],
        bottom: p.docks.bottom ?? [],
      },
      active: {
        left: p.active?.left ?? null,
        right: p.active?.right ?? null,
        top: p.active?.top ?? null,
        bottom: p.active?.bottom ?? null,
      },
      edgeSizes: {
        left: p.edgeSizes?.left ?? def.edgeSizes.left,
        right: p.edgeSizes?.right ?? def.edgeSizes.right,
        top: p.edgeSizes?.top ?? def.edgeSizes.top,
        bottom: p.edgeSizes?.bottom ?? def.edgeSizes.bottom,
      },
      split: typeof p.split === "number" ? p.split : def.split,
      hidden: p.hidden ?? def.hidden,
      activeTab: p.activeTab ?? def.activeTab,
    };
  } catch {
    return defaultLayout();
  }
}

interface Opts {
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

  /** Ensure every known pane appears in exactly one dock/center and every id is
   * known — guards against stale/partial persisted layouts. */
  private reconcileState(): void {
    const seen = new Set<string>();
    // Center must be a known pane.
    if (this.panes.has(this.state.center)) seen.add(this.state.center);
    else this.state.center = "";
    for (const e of EDGES) {
      this.state.docks[e] = this.state.docks[e].filter((id) => {
        if (!this.panes.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    // Any pane not placed yet → dock somewhere sensible (or become center if
    // none exists yet).
    for (const id of this.order) {
      if (seen.has(id)) continue;
      if (!this.state.center) {
        this.state.center = id;
      } else {
        const spec = this.panes.get(id)!;
        const target: Exclude<Dock, "center"> = spec.primary ? "right" : "bottom";
        this.state.docks[target].push(id);
      }
      seen.add(id);
    }
    if (!this.state.center) this.state.center = this.order[0] ?? "";
    // Heal active-tab pointers so each occupied edge fronts a visible pane.
    for (const e of EDGES) this.healActive(e);
    this.state.hidden = this.state.hidden.filter((id) => this.panes.has(id));
  }

  private healActive(edge: Exclude<Dock, "center">): void {
    const vis = this.visibleAt(edge);
    const cur = this.state.active[edge];
    if (!cur || !vis.includes(cur)) this.state.active[edge] = vis[0] ?? null;
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
    // On wide, showing a docked pane fronts it on its edge.
    if (on && !this.mql.matches) {
      const e = EDGES.find((edge) => this.state.docks[edge].includes(id));
      if (e) this.state.active[e] = id;
    }
    for (const e of EDGES) this.healActive(e);
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

  /** Snap a pane to a dock (edge) or make it the center. */
  relocate(id: string, dock: Dock): void {
    if (dock === "center") {
      // Displace the current center to the pane's former edge (or right).
      const from = this.edgeOf(id);
      const prevCenter = this.state.center;
      this.removeFromEdges(id);
      this.state.center = id;
      if (prevCenter && prevCenter !== id) {
        const home = from ?? "right";
        this.state.docks[home].push(prevCenter);
        this.state.active[home] = prevCenter;
      }
    } else {
      if (this.state.center === id) {
        // Moving the center away — promote another pane to center so the
        // workspace always has one. Prefer a docked pane; else keep as-is.
        const replacement = this.firstDockedOther(id);
        if (!replacement) return; // can't leave center empty
        this.removeFromEdges(replacement);
        this.state.center = replacement;
      } else {
        this.removeFromEdges(id);
      }
      this.state.docks[dock].push(id);
      this.state.active[dock] = id;
    }
    for (const e of EDGES) this.healActive(e);
    this.persist();
    this.render();
  }

  private firstDockedOther(exclude: string): string | null {
    for (const e of EDGES) {
      for (const id of this.state.docks[e]) if (id !== exclude) return id;
    }
    return null;
  }

  private removeFromEdges(id: string): void {
    for (const e of EDGES) {
      this.state.docks[e] = this.state.docks[e].filter((x) => x !== id);
    }
  }

  private edgeOf(id: string): Exclude<Dock, "center"> | null {
    return EDGES.find((e) => this.state.docks[e].includes(id)) ?? null;
  }

  dockOf(id: string): Dock {
    if (this.state.center === id) return "center";
    return this.edgeOf(id) ?? "center";
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
    w.setHeaderVisible(true);
    return w.attach();
  }

  private visibleAt(edge: Exclude<Dock, "center">): string[] {
    return this.state.docks[edge].filter((id) => this.isVisible(id));
  }

  // ---- WIDE: edge-dock ----------------------------------------------------

  private renderWide(): void {
    const grid = document.createElement("div");
    grid.className = "fxlayout-dock";

    const hasL = this.visibleAt("left").length > 0;
    const hasR = this.visibleAt("right").length > 0;
    const hasT = this.visibleAt("top").length > 0;
    const hasB = this.visibleAt("bottom").length > 0;

    // Track templates (center takes the remaining fraction — see wideCols).
    grid.style.gridTemplateColumns = this.wideCols();
    grid.style.gridTemplateRows = this.wideRows();

    // Compute grid line indices for the center cell.
    const colStart = hasL ? 3 : 1;
    const rowStart = hasT ? 3 : 1;

    // Top/bottom strips span the FULL width so they butt the outer edges.
    const totalCols = (hasL ? 2 : 0) + 1 + (hasR ? 2 : 0);
    if (hasT) {
      const strip = this.renderEdge("top");
      strip.style.gridColumn = `1 / ${totalCols + 1}`;
      strip.style.gridRow = "1";
      grid.appendChild(strip);
      grid.appendChild(this.dockDivider("top", `1 / ${totalCols + 1}`, "2"));
    }
    if (hasL) {
      const strip = this.renderEdge("left");
      strip.style.gridColumn = "1";
      strip.style.gridRow = `${rowStart}`;
      grid.appendChild(strip);
      grid.appendChild(this.dockDivider("left", "2", `${rowStart}`));
    }

    // Center.
    if (this.state.center) {
      const c = document.createElement("div");
      c.className = "fxlayout-center";
      c.style.gridColumn = `${colStart}`;
      c.style.gridRow = `${rowStart}`;
      c.appendChild(this.wrapped(this.state.center, true));
      grid.appendChild(c);
    }

    if (hasR) {
      const divCol = colStart + 1;
      grid.appendChild(this.dockDivider("right", `${divCol}`, `${rowStart}`));
      const strip = this.renderEdge("right");
      strip.style.gridColumn = `${divCol + 1}`;
      strip.style.gridRow = `${rowStart}`;
      grid.appendChild(strip);
    }
    if (hasB) {
      const divRow = rowStart + 1;
      grid.appendChild(this.dockDivider("bottom", `1 / ${totalCols + 1}`, `${divRow}`));
      const strip = this.renderEdge("bottom");
      strip.style.gridColumn = `1 / ${totalCols + 1}`;
      strip.style.gridRow = `${divRow + 1}`;
      grid.appendChild(strip);
    }

    this.root.appendChild(grid);
  }

  private frac(edge: Exclude<Dock, "center">): number {
    return clamp(this.state.edgeSizes[edge] || 0.28, MIN_EDGE, MAX_EDGE);
  }

  /** An edge strip: an optional tab bar (when >1 pane) over the fronted pane. */
  private renderEdge(edge: Exclude<Dock, "center">): HTMLElement {
    const strip = document.createElement("div");
    strip.className = `fxlayout-edge fxlayout-edge--${edge}`;
    const vis = this.visibleAt(edge);
    if (vis.length > 1) {
      const tabs = document.createElement("div");
      tabs.className = "fxlayout-edgetabs";
      const activeId = this.state.active[edge] ?? vis[0]!;
      for (const id of vis) {
        const spec = this.panes.get(id)!;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fxlayout-edgetab" + (id === activeId ? " fxlayout-edgetab--active" : "");
        btn.textContent = spec.title;
        btn.addEventListener("click", () => {
          this.state.active[edge] = id;
          this.persist();
          this.render();
        });
        tabs.appendChild(btn);
      }
      strip.appendChild(tabs);
    }
    const activeId = vis.length > 1 ? (this.state.active[edge] ?? vis[0]!) : vis[0];
    if (activeId) strip.appendChild(this.wrapped(activeId, true));
    return strip;
  }

  private dockDivider(edge: Exclude<Dock, "center">, col: string, row: string): HTMLElement {
    const horizontal = edge === "left" || edge === "right"; // drag along X
    const d = document.createElement("div");
    d.className =
      "fxlayout-divider " + (horizontal ? "fxlayout-divider--v" : "fxlayout-divider--h");
    d.style.gridColumn = col;
    d.style.gridRow = row;
    d.setAttribute("role", "separator");
    d.addEventListener("pointerdown", (e) => this.startEdgeDrag(e, edge, horizontal));
    return d;
  }

  private startEdgeDrag(
    e: PointerEvent,
    edge: Exclude<Dock, "center">,
    horizontal: boolean,
  ): void {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const grid = this.root.querySelector(".fxlayout-dock") as HTMLElement | null;
    if (!grid) return;
    target.setPointerCapture(e.pointerId);
    const rect = grid.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;

    const move = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
      // For right/bottom edges the strip is measured from the far side.
      const raw = pos / Math.max(1, total);
      const f =
        edge === "left" || edge === "top"
          ? raw
          : 1 - raw;
      this.state.edgeSizes[edge] = clamp(f, MIN_EDGE, MAX_EDGE);
      grid.style.gridTemplateColumns = this.wideCols();
      grid.style.gridTemplateRows = this.wideRows();
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

  private wideCols(): string {
    const hasL = this.visibleAt("left").length > 0;
    const hasR = this.visibleAt("right").length > 0;
    const l = hasL ? this.frac("left") : 0;
    const r = hasR ? this.frac("right") : 0;
    // Center takes what's left, so an edge fraction == its share of the width and
    // its divider sits under the pointer (no fr rescaling).
    const c = Math.max(MIN_CENTER, 1 - l - r);
    const cols: string[] = [];
    if (hasL) cols.push(`${l}fr`, "var(--fxdiv)");
    cols.push(`${c}fr`);
    if (hasR) cols.push("var(--fxdiv)", `${r}fr`);
    return cols.join(" ");
  }
  private wideRows(): string {
    const hasT = this.visibleAt("top").length > 0;
    const hasB = this.visibleAt("bottom").length > 0;
    const t = hasT ? this.frac("top") : 0;
    const b = hasB ? this.frac("bottom") : 0;
    const c = Math.max(MIN_CENTER, 1 - t - b);
    const rows: string[] = [];
    if (hasT) rows.push(`${t}fr`, "var(--fxdiv)");
    rows.push(`${c}fr`);
    if (hasB) rows.push("var(--fxdiv)", `${b}fr`);
    return rows.join(" ");
  }

  // ---- NARROW: code/uniforms split + overflow tabs ------------------------

  private renderNarrow(): void {
    // Primary split: code over uniforms with a draggable divider.
    const split = document.createElement("div");
    split.className = "fxlayout-nsplit";
    const codeShare = clamp(this.state.split, MIN_SPLIT, MAX_SPLIT);
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
      const frac = clamp((ev.clientY - rect.top) / Math.max(1, rect.height), MIN_SPLIT, MAX_SPLIT);
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
    const cur = this.dockOf(id);
    const title = document.createElement("div");
    title.className = "fxlayout-relo-title";
    title.textContent = "Move pane";
    pop.appendChild(title);
    for (const d of DOCKS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fxlayout-relo-item" + (d === cur ? " fxlayout-relo-item--cur" : "");
      b.textContent = DOCK_LABEL[d];
      b.addEventListener("click", () => {
        this.closeRelocate();
        this.relocate(id, d);
      });
      pop.appendChild(b);
    }
    // The center pane can't be hidden (the workspace must keep one).
    if (this.state.center !== id) {
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "fxlayout-relo-item fxlayout-relo-hide";
      hide.textContent = "Hide pane";
      hide.addEventListener("click", () => {
        this.closeRelocate();
        this.setVisible(id, false);
      });
      pop.appendChild(hide);
    }

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
  private readonly head: HTMLElement;
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

    this.head = document.createElement("div");
    this.head.className = "fxpane-head";
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

    this.head.append(title, this.controls);
    this.body = document.createElement("div");
    this.body.className = "fxpane-body";
    this.body.appendChild(spec.node);
    this.el.append(this.head, this.body);
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

  setHeaderVisible(on: boolean): void {
    this.head.style.display = on ? "" : "none";
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
