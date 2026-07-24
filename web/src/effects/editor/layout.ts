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
 *  • NARROW (< 720px): a vertical TOP / CENTER / BOTTOM dock stack — the phone
 *    analogue of the wide edge docks, but vertical-only and with its own
 *    arrangement. Each region holds one or more panes (TABBED when more than one)
 *    and is separated from its neighbours by a draggable divider. Panes drag
 *    freely between the three regions (long-press a tab or header); by default
 *    Code fills the center and everything else is a tab group in the bottom.
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

/** NARROW is a vertical stack of three tab-grouped regions (top over center over
 * bottom). Panes drag freely between them — the phone analogue of the wide docks,
 * but vertical-only and independent of the wide arrangement. */
type NRegion = "top" | "center" | "bottom";
const NREGIONS: NRegion[] = ["top", "center", "bottom"];
const NREGION_LABEL: Record<NRegion, string> = {
  top: "Move to top",
  center: "Move to center",
  bottom: "Move to bottom",
};
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
  hidden: string[];
  /** NARROW: which vertical region each pane lives in. */
  ndock: Record<string, NRegion>;
  /** NARROW: front (active) pane id per region when a region is tab-grouped. */
  nactive: Record<NRegion, string | null>;
  /** NARROW: region size weights (normalized across the *present* regions). */
  nsize: Record<NRegion, number>;
}

const STORAGE_KEY = "fxedit.layout.v2";

// Pane size bounds (fractions of the workspace). Kept intentionally permissive
// so panes can be dragged very small (content crops via overflow:hidden) — the
// dividers track the pointer 1:1 because the center track takes the *remaining*
// fraction (see wideCols/wideRows), not a fixed 1fr.
const MIN_EDGE = 0.04;
const MAX_EDGE = 0.92;
const MIN_CENTER = 0.04;
const MIN_NREG = 0.08; // narrow region minimum height fraction
const NARROW_QUERY = "(max-width: 719px)";

/** Default WIDE arrangement: Code is the center; Uniforms + Preview dock right;
 * Chat / Diagnostics / Disassembly dock bottom (disasm hidden by default).
 * Default NARROW arrangement: Code fills the center region; everything else is a
 * tab group in the bottom region (Uniforms fronted; disasm hidden). */
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
    hidden: ["disasm"],
    ndock: {
      code: "center",
      uniforms: "bottom",
      preview: "bottom",
      diagnostics: "bottom",
      chat: "bottom",
      disasm: "bottom",
    },
    nactive: { top: null, center: "code", bottom: "uniforms" },
    nsize: { top: 0.28, center: 0.52, bottom: 0.34 },
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
      hidden: p.hidden ?? def.hidden,
      // Narrow fields are new; fold defaults under any stored overrides. Values
      // are sanitized in reconcileState (every pane ends up in exactly one
      // region and each region fronts a visible pane).
      ndock:
        p.ndock && typeof p.ndock === "object" ? { ...def.ndock, ...p.ndock } : def.ndock,
      nactive: {
        top: p.nactive?.top ?? def.nactive.top,
        center: p.nactive?.center ?? def.nactive.center,
        bottom: p.nactive?.bottom ?? def.nactive.bottom,
      },
      nsize: {
        top: p.nsize?.top ?? def.nsize.top,
        center: p.nsize?.center ?? def.nsize.center,
        bottom: p.nsize?.bottom ?? def.nsize.bottom,
      },
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

    // Narrow: every pane must live in exactly one region; drop unknown ids.
    for (const id of Object.keys(this.state.ndock)) {
      if (!this.panes.has(id)) delete this.state.ndock[id];
    }
    for (const id of this.order) {
      const r = this.state.ndock[id];
      if (r !== "top" && r !== "center" && r !== "bottom") {
        this.state.ndock[id] = this.panes.get(id)!.primary ? "center" : "bottom";
      }
    }
    for (const r of NREGIONS) this.healNActive(r);
  }

  private healActive(edge: Exclude<Dock, "center">): void {
    const vis = this.visibleAt(edge);
    const cur = this.state.active[edge];
    if (!cur || !vis.includes(cur)) this.state.active[edge] = vis[0] ?? null;
  }

  private healNActive(r: NRegion): void {
    const vis = this.nvisibleAt(r);
    const cur = this.state.nactive[r];
    if (!cur || !vis.includes(cur)) this.state.nactive[r] = vis[0] ?? null;
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
    // On narrow, showing a pane fronts it within its region.
    if (on && this.mql.matches) {
      const r = this.state.ndock[id];
      if (r) this.state.nactive[r] = id;
    }
    // On wide, showing a docked pane fronts it on its edge.
    if (on && !this.mql.matches) {
      const e = EDGES.find((edge) => this.state.docks[edge].includes(id));
      if (e) this.state.active[e] = id;
    }
    for (const e of EDGES) this.healActive(e);
    for (const r of NREGIONS) this.healNActive(r);
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

  /** NARROW: move a pane into a vertical region and front it there. */
  relocateNarrow(id: string, region: NRegion): void {
    this.state.ndock[id] = region;
    if (!this.state.hidden.includes(id)) this.state.nactive[region] = id;
    for (const r of NREGIONS) this.healNActive(r);
    this.persist();
    this.render();
  }

  /** Restore the built-in default arrangement (both wide and narrow) and forget
   * any persisted customization. */
  resetLayout(): void {
    this.state = defaultLayout();
    this.reconcileState();
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

  /** NARROW: visible panes in a region, in stable declaration order. */
  private nvisibleAt(r: NRegion): string[] {
    return this.order.filter((id) => this.state.ndock[id] === r && this.isVisible(id));
  }

  /** NARROW: the region's front pane (stored active if visible, else the first). */
  private nActiveOf(r: NRegion): string | null {
    const vis = this.nvisibleAt(r);
    const cur = this.state.nactive[r];
    return cur && vis.includes(cur) ? cur : (vis[0] ?? null);
  }

  private nfrac(r: NRegion): number {
    return clamp(this.state.nsize[r] || 0.33, MIN_NREG, 1);
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
        this.attachDragHandle(btn, id); // long-press → drag to re-dock
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

  // ---- NARROW: vertical top / center / bottom dock stack ------------------

  private renderNarrow(): void {
    const present = NREGIONS.filter((r) => this.nvisibleAt(r).length > 0);
    const stack = document.createElement("div");
    stack.className = "fxlayout-nstack";
    stack.style.gridTemplateRows = this.nRows(present);

    present.forEach((r, i) => {
      if (i > 0) stack.appendChild(this.nDivider(present[i - 1]!, r, stack, present));
      stack.appendChild(this.renderNRegion(r));
    });
    this.root.appendChild(stack);
  }

  /** grid-template-rows for the present regions (fr shares) + dividers between. */
  private nRows(present: NRegion[]): string {
    const sum = present.reduce((s, r) => s + this.nfrac(r), 0) || 1;
    const rows: string[] = [];
    present.forEach((r, i) => {
      if (i > 0) rows.push("var(--fxdiv)");
      rows.push(`${this.nfrac(r) / sum}fr`);
    });
    return rows.join(" ");
  }

  /** A narrow region: an optional tab bar (when >1 pane) over the fronted pane. */
  private renderNRegion(r: NRegion): HTMLElement {
    const cell = document.createElement("div");
    cell.className = `fxlayout-nregion fxlayout-nregion--${r}`;
    const vis = this.nvisibleAt(r);
    if (vis.length > 1) {
      const tabs = document.createElement("div");
      tabs.className = "fxlayout-tabs";
      const activeId = this.nActiveOf(r);
      for (const id of vis) {
        const spec = this.panes.get(id)!;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fxlayout-tab" + (id === activeId ? " fxlayout-tab--active" : "");
        btn.textContent = spec.title;
        btn.addEventListener("click", () => {
          this.state.nactive[r] = id;
          this.persist();
          this.render();
        });
        this.attachDragHandle(btn, id); // long-press → drag to another region
        tabs.appendChild(btn);
      }
      cell.appendChild(tabs);
    }
    const activeId = this.nActiveOf(r);
    if (activeId) cell.appendChild(this.wrapped(activeId, true));
    return cell;
  }

  private nDivider(above: NRegion, below: NRegion, stack: HTMLElement, present: NRegion[]): HTMLElement {
    const d = document.createElement("div");
    d.className = "fxlayout-divider fxlayout-divider--h";
    d.setAttribute("role", "separator");
    d.addEventListener("pointerdown", (e) => this.startNRegionDrag(e, above, below, stack, present));
    return d;
  }

  /** Drag the boundary between two adjacent regions, keeping every other region
   * fixed (only the pair's split changes — like the wide edge dividers). */
  private startNRegionDrag(
    e: PointerEvent,
    above: NRegion,
    below: NRegion,
    stack: HTMLElement,
    present: NRegion[],
  ): void {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const rect = stack.getBoundingClientRect();
    const sum = present.reduce((s, r) => s + this.nfrac(r), 0) || 1;
    // Weight above the boundary that stays fixed during this drag.
    let before = 0;
    for (const r of present) {
      if (r === above) break;
      before += this.nfrac(r);
    }
    const pairTotal = this.nfrac(above) + this.nfrac(below);
    const move = (ev: PointerEvent) => {
      const pos = clamp((ev.clientY - rect.top) / Math.max(1, rect.height), 0, 1) * sum;
      const a = clamp(pos - before, MIN_NREG, pairTotal - MIN_NREG);
      this.state.nsize[above] = a;
      this.state.nsize[below] = pairTotal - a;
      stack.style.gridTemplateRows = this.nRows(present);
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
    const narrow = this.mql.matches;
    const pop = document.createElement("div");
    pop.className = "fxlayout-relo";
    const title = document.createElement("div");
    title.className = "fxlayout-relo-title";
    title.textContent = "Move pane";
    pop.appendChild(title);
    const item = (label: string, on: boolean, onClick: () => void): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fxlayout-relo-item" + (on ? " fxlayout-relo-item--cur" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        this.closeRelocate();
        onClick();
      });
      pop.appendChild(b);
    };
    if (narrow) {
      const cur = this.state.ndock[id];
      for (const r of NREGIONS) item(NREGION_LABEL[r], r === cur, () => this.relocateNarrow(id, r));
    } else {
      const cur = this.dockOf(id);
      for (const d of DOCKS) item(DOCK_LABEL[d], d === cur, () => this.relocate(id, d));
    }
    // Keep at least one pane on screen (wide: the center must stay).
    const canHide = narrow
      ? this.order.filter((x) => this.isVisible(x)).length > 1
      : this.state.center !== id;
    if (canHide) {
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

  // -- drag a pane handle (tab / header) to a new dock ----------------------

  /** Make `el` a long-press drag handle for pane `id`: after a hold it picks the
   * pane up and dragging over the workspace re-docks it — into an edge on wide,
   * or a top/center/bottom region on narrow. A quick tap is left alone (so a tab
   * still switches), and the click that would follow a drag is suppressed. */
  attachDragHandle(el: HTMLElement, id: string): void {
    el.classList.add("fxlayout-draghandle");
    let timer: number | null = null;
    let sx = 0;
    let sy = 0;
    let dragged = false;
    const clear = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button > 0) return; // primary button / touch only
      sx = e.clientX;
      sy = e.clientY;
      dragged = false;
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        dragged = true;
        this.startPaneDrag(e, id, el);
      }, 380);
    });
    el.addEventListener("pointermove", (e) => {
      if (timer !== null && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) clear();
    });
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    // Swallow the click a completed long-press drag would otherwise fire.
    el.addEventListener(
      "click",
      (e) => {
        if (dragged) {
          e.preventDefault();
          e.stopImmediatePropagation();
          dragged = false;
        }
      },
      true,
    );
  }

  private startPaneDrag(e: PointerEvent, id: string, handle: HTMLElement): void {
    const narrow = this.mql.matches;
    const rect = this.root.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.className = "fxlayout-dropzones";
    const zones = new Map<string, HTMLElement>();
    // Narrow drops into a vertical top/center/bottom region; wide into an edge or
    // the center. Each entry: [zone key, label, absolute CSS box].
    const defs: [string, string, Record<string, string>][] = narrow
      ? [
          ["top", "Top", { left: "0", top: "0", width: "100%", height: "33%" }],
          ["center", "Center", { left: "0", top: "33%", width: "100%", height: "34%" }],
          ["bottom", "Bottom", { left: "0", bottom: "0", width: "100%", height: "33%" }],
        ]
      : [
          ["left", "Left", { left: "0", top: "0", width: "24%", height: "100%" }],
          ["right", "Right", { right: "0", top: "0", width: "24%", height: "100%" }],
          ["top", "Top", { left: "24%", top: "0", width: "52%", height: "24%" }],
          ["bottom", "Bottom", { left: "24%", bottom: "0", width: "52%", height: "24%" }],
          ["center", "Center", { left: "24%", top: "24%", width: "52%", height: "52%" }],
        ];
    for (const [zone, label, css] of defs) {
      const z = document.createElement("div");
      z.className = "fxlayout-dropzone";
      Object.assign(z.style, css);
      const s = document.createElement("span");
      s.textContent = label;
      z.appendChild(s);
      overlay.appendChild(z);
      zones.set(zone, z);
    }
    this.root.appendChild(overlay);
    handle.classList.add("fxlayout-draghandle--active");

    const zoneFor = (x: number, y: number): string => {
      const fx = (x - rect.left) / Math.max(1, rect.width);
      const fy = (y - rect.top) / Math.max(1, rect.height);
      if (narrow) {
        if (fy < 0.34) return "top";
        if (fy > 0.66) return "bottom";
        return "center";
      }
      if (fx < 0.24) return "left";
      if (fx > 0.76) return "right";
      if (fy < 0.24) return "top";
      if (fy > 0.76) return "bottom";
      return "center";
    };
    let zone = zoneFor(e.clientX, e.clientY);
    const highlight = (d: string): void => {
      for (const [k, z] of zones) z.classList.toggle("fxlayout-dropzone--on", k === d);
    };
    highlight(zone);

    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    const move = (ev: PointerEvent): void => {
      zone = zoneFor(ev.clientX, ev.clientY);
      highlight(zone);
    };
    const end = (ev: PointerEvent): void => {
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      overlay.remove();
      handle.classList.remove("fxlayout-draghandle--active");
      // relocate*/re-render only when the pane actually changes home.
      if (narrow) {
        if (zone !== this.state.ndock[id]) this.relocateNarrow(id, zone as NRegion);
      } else if (zone !== this.dockOf(id)) {
        this.relocate(id, zone as Dock);
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
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
    // The header title is also a long-press drag handle (for the center pane and
    // single-pane edges, which have no tab strip).
    this.owner.attachDragHandle(title, spec.id);

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
