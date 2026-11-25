/**
 * The FX editor's Watch pane (D-541 PR 11; host preview only, D-550): the
 * expressions you added from the code ("Add to Watch" on a selection), each
 * with its type, class (Const / Frame / Led / Dynamic) and current value, a
 * per-frame time plot of the selected one, and pause / step / scrub of the
 * host preview.
 *
 * {@link WatchController} owns the watch VM (a second FxPreview on the
 * compiler's host watch build, synced from the live preview's state + arena
 * and fed the same inputs, so watching never perturbs the preview — feedback
 * buffers included) and the frame log scrub replays. The editor calls
 * `liveFrame()` after each live preview frame and asks `paused` before
 * advancing; everything else goes through {@link WatchHost}.
 *
 * Seams for PR 12 (watch viz): `onFrame` hands every frame's per-LED values
 * (for MapView overlays) and `selected` names the watch a view should show;
 * vec2/vec3 trajectories and the mat4 gizmo read the same history.
 */

import { icon, IconButton, toast } from "../../ui/kit";
import { FxPreview, type LedTopology } from "../../fx/preview";
import {
  CLASS_HINT,
  CLASS_LABEL,
  NOT_AN_EXPRESSION,
  WatchHistory,
  WatchSession,
  componentNames,
  fmtNum,
  formatValue,
  ledSummary,
  plotRange,
  relocate,
  watchRanges,
  type WatchCompile,
  type WatchExpr,
  type WatchFrame,
  type WatchInfo,
  type WatchSample,
} from "../../fx/watch";

/** What the controller needs from the editor. */
export interface WatchHost {
  compileWatch(src: string, ranges: Uint32Array): Promise<WatchCompile>;
  /** The live preview and its inputs right now (null while there is none). */
  live(): { preview: FxPreview; ledCount: number; positions: Float32Array } | null;
  uniforms(): { slot: number; value: number[] }[];
  topology(): LedTopology | null;
  /** Show these colours instead of the live frame (a scrubbed frame); null = live. */
  showColors(colors: Uint8Array | null): void;
  /** Advance the paused live preview by one frame (it then calls liveFrame). */
  stepLive(): void;
  /** The pause state changed (the editor freezes / resumes its clock). */
  pausedChanged(paused: boolean): void;
  /** Select `start..end` in the code (a row was tapped). */
  selectCode(start: number, end: number): void;
}

/** Frames of history (the plot width and the scrub range): 10 s at 60 fps. */
export const HISTORY_FRAMES = 600;

/** Plot series colours (dark chart palette slots 1-4, validated adjacent). */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"];

export class WatchController {
  readonly node: HTMLElement;
  /** The watch the plot shows (PR 12's views follow it too). */
  selected = 0;
  /** Every frame's values, for later views (PR 12 MapView overlays). */
  onFrame: ((f: WatchFrame, infos: readonly WatchInfo[]) => void) | null = null;

  private exprs: WatchExpr[] = [];
  private infos: WatchInfo[] = [];
  private nextId = 1;
  private src = "";
  private vm: FxPreview | null = null;
  private session: WatchSession | null = null;
  private readonly history = new WatchHistory(HISTORY_FRAMES);
  private last: WatchFrame | null = null;
  /** The frame shown while paused (a scrubbed one), else null. */
  private shown: WatchFrame | null = null;
  private probe = 0;
  private isPaused = false;
  private building = 0;
  private disposed = false;
  private hover: number | null = null;

  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly stepBtn: HTMLButtonElement;
  private readonly scrub: HTMLInputElement;
  private readonly clock: HTMLElement;
  private readonly probeIn: HTMLInputElement;
  private readonly plotWrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly readout: HTMLElement;
  private plotDirty = true;

  constructor(private readonly host: WatchHost) {
    this.node = document.createElement("div");
    this.node.className = "fxwatch";

    const bar = document.createElement("div");
    bar.className = "fxwatch-bar";
    this.pauseBtn = IconButton("pause", { title: "Pause the preview", onClick: () => this.setPaused(!this.isPaused) });
    this.pauseBtn.classList.add("fxwatch-btn");
    this.stepBtn = IconButton("step", { title: "Step one frame", onClick: () => this.step() });
    this.stepBtn.classList.add("fxwatch-btn");
    this.stepBtn.disabled = true;
    this.scrub = document.createElement("input");
    this.scrub.type = "range";
    this.scrub.className = "fxwatch-scrub";
    this.scrub.min = "0";
    this.scrub.max = "0";
    this.scrub.step = "1";
    this.scrub.disabled = true;
    this.scrub.setAttribute("aria-label", "Scrub the recorded frames");
    this.scrub.addEventListener("input", () => this.seek(Number(this.scrub.value)));
    this.clock = document.createElement("span");
    this.clock.className = "fxwatch-clock";
    this.clock.textContent = "live";
    const probeLabel = document.createElement("label");
    probeLabel.className = "fxwatch-probe";
    probeLabel.textContent = "LED";
    this.probeIn = document.createElement("input");
    this.probeIn.type = "number";
    this.probeIn.min = "0";
    this.probeIn.step = "1";
    this.probeIn.value = "0";
    this.probeIn.inputMode = "numeric";
    this.probeIn.setAttribute("aria-label", "LED whose per-LED values are shown");
    this.probeIn.addEventListener("input", () => {
      this.probe = Math.max(0, Math.floor(Number(this.probeIn.value) || 0));
      this.history.clear();
      this.plotDirty = true;
      this.renderValues();
    });
    probeLabel.append(this.probeIn);
    bar.append(this.pauseBtn, this.stepBtn, this.scrub, this.clock, probeLabel);

    this.empty = document.createElement("p");
    this.empty.className = "fxwatch-empty";
    this.empty.textContent =
      "Select an expression in the code and choose Add to Watch (right-click it, or the chip under a selection on a phone). " +
      "Values come from the preview on this device, not from the lamp.";
    this.list = document.createElement("div");
    this.list.className = "fxwatch-list";
    this.list.setAttribute("role", "list");

    this.plotWrap = document.createElement("div");
    this.plotWrap.className = "fxwatch-plot";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "fxwatch-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.addEventListener("pointermove", (e) => this.onPlotPointer(e));
    this.canvas.addEventListener("pointerdown", (e) => this.onPlotPointer(e));
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.plotDirty = true;
      this.renderReadout();
    });
    this.legend = document.createElement("div");
    this.legend.className = "fxwatch-legend";
    this.readout = document.createElement("div");
    this.readout.className = "fxwatch-readout";
    this.plotWrap.append(this.legend, this.canvas, this.readout);

    // List and plot side by side when the pane is wide (CSS container query).
    const body = document.createElement("div");
    body.className = "fxwatch-body";
    const col = document.createElement("div");
    col.className = "fxwatch-col";
    col.append(this.empty, this.list);
    body.append(col, this.plotWrap);
    this.node.append(bar, body);
    this.render();
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** The watched expressions (for tests and the AI context). */
  watches(): readonly { expr: WatchExpr; info: WatchInfo | undefined }[] {
    return this.exprs.map((expr, i) => ({ expr, info: this.infos[i] }));
  }

  // -- adding / removing ----------------------------------------------------

  /** Add `src.slice(start, end)` (the code as it is now). Resolves false, with a
   * toast, when it can't be watched. */
  async add(src: string, start: number, end: number): Promise<boolean> {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(src[a] ?? "")) a++;
    while (b > a && /\s/.test(src[b - 1] ?? "")) b--;
    const text = src.slice(a, b);
    if (text.length === 0) {
      toast(NOT_AN_EXPRESSION, { error: true });
      return false;
    }
    if (this.exprs.some((e) => e.start === a && e.end === b && e.text === text)) {
      toast("Already watched");
      return true;
    }
    const probe = await this.host.compileWatch(src, watchRanges([{ start: a, end: b }]));
    if (this.disposed) return false;
    if (!probe.result.ok) {
      toast("Fix the compile errors first, then add the watch", { error: true });
      return false;
    }
    const err = probe.watches[0]?.error ?? NOT_AN_EXPRESSION;
    if (probe.watches[0]?.error !== null) {
      toast(err, { error: true });
      return false;
    }
    this.exprs.push({ id: this.nextId++, text, start: a, end: b });
    this.selected = this.exprs.length - 1;
    // Built against the source the live preview runs; an edit not compiled yet
    // is picked up by the next compile (which relocates the watch).
    this.history.clear();
    await this.rebuild();
    return true;
  }

  remove(id: number): void {
    const i = this.exprs.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.exprs.splice(i, 1);
    this.infos.splice(i, 1);
    if (this.selected >= this.exprs.length) this.selected = Math.max(0, this.exprs.length - 1);
    this.history.clear();
    void this.rebuild();
  }

  // -- the editor's hooks ---------------------------------------------------

  /** A clean compile of `src` replaced the live preview (it restarts fresh):
   * re-find the watches in the new source and rebuild the watch VM. */
  compiled(src: string): void {
    this.src = src;
    for (const e of this.exprs) {
      const r = relocate(src, e);
      if (r) {
        e.start = r.start;
        e.end = r.end;
      }
    }
    this.history.clear();
    void this.rebuild();
  }

  /** A uniform moved (the live preview got the same value). */
  setUniform(slot: number, value: number[]): void {
    this.session?.setUniform(slot, value);
  }

  setTopology(t: LedTopology): void {
    this.vm?.setTopology(t);
  }

  setTexture(texIndex: number, w: number, h: number, rgba: Uint8Array, ledCount: number): void {
    this.vm?.setTexture(texIndex, w, h, rgba, ledCount);
  }

  /** The live preview just ran frame `frame`: run the same frame on the watch
   * VM (only while there is something to watch or the pane is on screen). */
  liveFrame(time: number, dt: number, frame: number, ledCount: number, positions: Float32Array): void {
    if (!this.session || !this.active()) return;
    const f = this.session.frame(time, dt, frame, ledCount, positions);
    this.last = f;
    this.shown = null;
    this.history.push(this.sample(f));
    this.plotDirty = true;
    this.onFrame?.(f, this.infos);
    this.renderValues();
    this.renderTransport();
  }

  /** Per animation frame (cheap when nothing changed): redraw the plot. */
  draw(): void {
    if (!this.plotDirty || !this.node.isConnected) return;
    this.plotDirty = false;
    this.drawPlot();
  }

  dispose(): void {
    this.disposed = true;
    this.vm?.dispose();
    this.vm = null;
    this.session = null;
  }

  // -- pause / step / scrub -------------------------------------------------

  setPaused(p: boolean): void {
    if (p === this.isPaused) return;
    this.isPaused = p;
    if (!p) {
      // Back to live: the session replays to its head on the next frame.
      this.shown = null;
      this.host.showColors(null);
    }
    this.host.pausedChanged(p);
    this.renderTransport();
  }

  /** One frame forward: through the log while scrubbed back, else live. */
  step(): void {
    if (!this.isPaused) this.setPaused(true);
    const s = this.session;
    const cur = s?.currentFrame();
    if (s && cur !== null && cur !== undefined && !s.atHead()) {
      const f = s.seek(cur + 1);
      if (f) this.show(f, s.atHead());
      return;
    }
    this.host.stepLive();
  }

  /** Show logged frame `frame` (paused). */
  seek(frame: number): void {
    const s = this.session;
    if (!s) return;
    if (!this.isPaused) this.setPaused(true);
    const f = s.seek(frame);
    if (f) this.show(f, s.atHead());
  }

  private show(f: WatchFrame, atHead: boolean): void {
    this.shown = atHead ? null : f;
    this.host.showColors(atHead ? null : f.colors);
    if (atHead) this.last = f;
    this.plotDirty = true;
    this.onFrame?.(f, this.infos);
    this.renderValues();
    this.renderTransport();
  }

  // -- internals --------------------------------------------------------------

  private active(): boolean {
    // A hidden pane (a background tab) has an empty box.
    return this.exprs.length > 0 || (this.node.isConnected && this.node.getBoundingClientRect().width > 0);
  }

  /** (Re)build the watch VM for the current watches and sync it from the live
   * preview. Starts even with no watches, for pause / scrub of the preview. */
  async rebuild(): Promise<void> {
    const seq = ++this.building;
    const src = this.src;
    if (src === "") return;
    const ranges: { start: number; end: number }[] = [];
    for (const e of this.exprs) ranges.push(relocate(src, e) ?? { start: 0, end: 0 });
    const w = await this.host.compileWatch(src, watchRanges(ranges));
    if (seq !== this.building || this.disposed) return;
    if (!w.result.ok) {
      this.infos = this.exprs.map(() => blankInfo("the effect doesn't compile"));
      this.render();
      return;
    }
    let vm: FxPreview;
    try {
      vm = await FxPreview.create(w.result.bytecode);
    } catch (e) {
      console.warn("watch VM unavailable:", e);
      return;
    }
    if (seq !== this.building || this.disposed) {
      vm.dispose();
      return;
    }
    if (!vm.canWatch) {
      vm.dispose();
      this.infos = this.exprs.map(() => blankInfo("this preview build can't watch values"));
      this.render();
      return;
    }
    this.infos = this.exprs.map((_, i) => w.watches[i] ?? blankInfo(NOT_AN_EXPRESSION));
    const live = this.host.live();
    const topo = this.host.topology();
    if (topo) vm.setTopology(topo);
    this.vm?.dispose();
    this.vm = vm;
    const session = new WatchSession(vm, this.infos, { maxFrames: HISTORY_FRAMES });
    const uniforms = this.host.uniforms().map(({ slot, value }) => [slot, value] as [number, number[]]);
    session.syncFrom(
      live ? { state: live.preview.state(), arena: live.preview.arena() } : { state: new Uint32Array(0), arena: new Uint8Array(0) },
      uniforms,
    );
    this.session = session;
    this.last = null;
    this.shown = null;
    // (While paused the values appear with the next step.)
    this.render();
  }

  private sample(f: WatchFrame): WatchSample {
    const s: WatchSample = { frame: f.frame, time: f.time, values: [], min: [], max: [] };
    f.values.forEach((v, i) => {
      const info = this.infos[i];
      if (v.frame) {
        s.values.push(v.frame);
        s.min.push(null);
        s.max.push(null);
      } else if (v.leds && info) {
        const sum = ledSummary(v.leds, info.width, this.probe);
        s.values.push(sum.value);
        s.min.push(sum.min);
        s.max.push(sum.max);
      } else {
        s.values.push(null);
        s.min.push(null);
        s.max.push(null);
      }
    });
    return s;
  }

  private render(): void {
    this.empty.hidden = this.exprs.length > 0;
    this.plotWrap.hidden = this.exprs.length === 0;
    this.list.replaceChildren(
      ...this.exprs.map((e, i) => {
        const info = this.infos[i];
        const row = document.createElement("div");
        row.className = "fxwatch-row";
        row.setAttribute("role", "listitem");
        if (i === this.selected) row.classList.add("is-selected");
        const main = document.createElement("button");
        main.type = "button";
        main.className = "fxwatch-main";
        main.title = "Plot this watch and select it in the code";
        main.addEventListener("click", () => {
          this.selected = i;
          this.plotDirty = true;
          this.render();
          const r = relocate(this.src, e);
          if (r) this.host.selectCode(r.start, r.end);
        });
        const expr = document.createElement("code");
        expr.className = "fxwatch-expr";
        expr.textContent = e.text;
        const meta = document.createElement("span");
        meta.className = "fxwatch-meta";
        if (info && info.error === null) {
          const ty = document.createElement("span");
          ty.className = "fxwatch-tag";
          ty.textContent = info.ty;
          const cls = document.createElement("span");
          cls.className = `fxwatch-tag fxwatch-class fxwatch-class--${info.class ?? "const"}`;
          cls.textContent = CLASS_LABEL[info.class ?? "const"];
          cls.title = CLASS_HINT[info.class ?? "const"];
          const where = document.createElement("span");
          where.className = "fxwatch-where";
          where.textContent = `${info.func}() · line ${info.line}`;
          meta.append(ty, cls, where);
        } else {
          const er = document.createElement("span");
          er.className = "fxwatch-err";
          er.textContent = info?.error ?? "building…";
          meta.append(er);
        }
        const val = document.createElement("span");
        val.className = "fxwatch-value";
        val.dataset.watch = String(i);
        main.append(expr, meta, val);
        const rm = IconButton("close", { title: `Stop watching ${e.text}`, onClick: () => this.remove(e.id) });
        rm.classList.add("fxwatch-rm");
        row.append(main, rm);
        return row;
      }),
    );
    this.plotDirty = true;
    this.renderValues();
    this.renderTransport();
  }

  private renderValues(): void {
    const f = this.shown ?? this.last;
    for (const el of this.list.querySelectorAll<HTMLElement>(".fxwatch-value")) {
      const i = Number(el.dataset.watch);
      const info = this.infos[i];
      const v = f?.values[i];
      if (!info || info.error !== null || !v) {
        el.textContent = "";
        continue;
      }
      if (v.frame) {
        el.textContent = formatValue(info.ty, v.frame);
      } else if (v.leds) {
        const n = info.width > 0 ? v.leds.length / info.width : 0;
        const sum = ledSummary(v.leds, info.width, this.probe);
        const range = info.width === 1 ? ` · all LEDs ${fmtNum(sum.min[0] ?? 0)} … ${fmtNum(sum.max[0] ?? 0)}` : "";
        el.textContent = `LED ${Math.min(this.probe, Math.max(0, n - 1))}: ${formatValue(info.ty, sum.value)}${range}`;
      } else {
        el.textContent = "not run yet";
      }
    }
    this.renderReadout();
  }

  private renderTransport(): void {
    this.pauseBtn.replaceChildren(icon(this.isPaused ? "play" : "pause"));
    const t = this.isPaused ? "Resume the preview" : "Pause the preview";
    this.pauseBtn.title = t;
    this.pauseBtn.setAttribute("aria-label", t);
    this.pauseBtn.setAttribute("aria-pressed", String(this.isPaused));
    this.stepBtn.disabled = !this.isPaused;
    const s = this.session;
    const first = s?.firstFrame() ?? null;
    const lastF = s?.lastFrame() ?? null;
    const cur = s?.currentFrame() ?? null;
    if (first !== null && lastF !== null) {
      this.scrub.min = String(first);
      this.scrub.max = String(lastF);
      this.scrub.value = String(cur ?? lastF);
    }
    this.scrub.disabled = !this.isPaused || first === null || first === lastF;
    const f = this.shown ?? this.last;
    if (!this.isPaused) this.clock.textContent = "live";
    else if (f) this.clock.textContent = `frame ${f.frame} · ${f.time.toFixed(2)} s`;
    else this.clock.textContent = "paused";
  }

  private renderReadout(): void {
    const info = this.infos[this.selected];
    if (!info || info.error !== null) {
      this.readout.textContent = "";
      return;
    }
    const s = this.hover !== null ? this.history.find(this.hover) : this.history.find((this.shown ?? this.last)?.frame ?? -1);
    const v = s?.values[this.selected];
    this.readout.textContent = s && v ? `frame ${s.frame} · ${s.time.toFixed(2)} s · ${formatValue(info.ty, v)}` : "";
  }

  private onPlotPointer(e: PointerEvent): void {
    const n = this.history.length;
    if (n === 0) return;
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const span = plotSpan(n);
    const i = Math.max(0, Math.min(n - 1, Math.round(x * (span - 1)) - (span - n)));
    const s = this.history.at(i);
    if (!s) return;
    this.hover = s.frame;
    // Pressing on the plot while paused scrubs to that frame.
    if (this.isPaused && (e.type === "pointerdown" || e.buttons === 1)) this.seek(s.frame);
    this.plotDirty = true;
    this.renderReadout();
  }

  private drawPlot(): void {
    const info = this.infos[this.selected];
    const cv = this.canvas;
    const w = Math.max(1, cv.clientWidth);
    const h = Math.max(1, cv.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(this.node);
    const prop = (n: string, d: string): string =>
      (typeof css.getPropertyValue === "function" ? css.getPropertyValue(n).trim() : "") || d;
    const ink = prop("--text-dim", "#9a9aa2");
    const grid = prop("--border", "#2a2a33");
    this.legend.replaceChildren();
    if (!info || info.error !== null) return;
    const sel = this.selected;
    const comps = Math.min(4, info.width);
    const names = componentNames(info.ty, info.width);
    const perLed = info.store === "led";
    const { lo, hi } = plotRange(this.history, sel, { band: perLed });
    g.font = "11px ui-monospace, monospace";
    const ticks = [lo, (lo + hi) / 2, hi];
    const padL = Math.ceil(Math.max(...ticks.map((v) => g.measureText(fmtTick(v, hi - lo)).width))) + 12;
    const padR = 8;
    const padT = 8;
    const padB = 16;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const n = this.history.length;
    const span = plotSpan(n);
    const off = span - n;
    const X = (k: number): number => padL + (k / (span - 1)) * pw;
    const Y = (v: number): number => padT + (1 - (v - lo) / (hi - lo)) * ph;
    // Recessive grid + axis labels.
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.fillStyle = ink;
    g.font = "11px ui-monospace, monospace";
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(w - padR, y);
      g.stroke();
      g.fillText(fmtTick(v, hi - lo), padL - 6, Math.min(Math.max(y, padT + 6), h - padB - 6));
    }
    if (lo < 0 && hi > 0) {
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(padL, Math.round(Y(0)) + 0.5);
      g.lineTo(w - padR, Math.round(Y(0)) + 0.5);
      g.stroke();
      g.setLineDash([]);
    }
    // Per-LED: the all-LED min..max band (component 0 only, quiet).
    if (perLed && info.width === 1) {
      g.fillStyle = `${SERIES[0]}33`;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const v = this.history.at(i)?.max[sel]?.[0];
        if (v !== undefined) g.lineTo(X(off + i), Y(v));
      }
      for (let i = n - 1; i >= 0; i--) {
        const v = this.history.at(i)?.min[sel]?.[0];
        if (v !== undefined) g.lineTo(X(off + i), Y(v));
      }
      g.closePath();
      g.fill();
    }
    g.lineWidth = 2;
    g.lineJoin = "round";
    for (let c = 0; c < comps; c++) {
      g.strokeStyle = SERIES[c] ?? SERIES[0]!;
      g.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = this.history.at(i)?.values[sel]?.[c];
        if (v === undefined || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        if (started) g.lineTo(X(off + i), Y(v));
        else g.moveTo(X(off + i), Y(v));
        started = true;
      }
      g.stroke();
    }
    // Cursor: the scrubbed (or hovered) frame.
    const mark = this.hover ?? (this.isPaused ? (this.shown ?? this.last)?.frame : undefined);
    if (mark !== undefined && mark !== null) {
      for (let i = 0; i < n; i++) {
        if (this.history.at(i)?.frame !== mark) continue;
        const x = Math.round(X(off + i)) + 0.5;
        g.strokeStyle = ink;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, padT);
        g.lineTo(x, h - padB);
        g.stroke();
        for (let c = 0; c < comps; c++) {
          const v = this.history.at(i)?.values[sel]?.[c];
          if (v === undefined) continue;
          g.fillStyle = SERIES[c] ?? SERIES[0]!;
          g.beginPath();
          g.arc(x, Y(v), 4, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    g.fillStyle = ink;
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    const first = this.history.at(0);
    const lastS = this.history.last();
    if (first && lastS) g.fillText(`last ${(lastS.time - first.time).toFixed(1)} s · ${n} frames`, padL, h - 3);
    // Legend: the expression, then a swatch per component (identity is never colour alone).
    const title = document.createElement("code");
    title.className = "fxwatch-legend-title";
    title.textContent = this.exprs[sel]?.text ?? "";
    this.legend.append(title);
    for (let c = 0; c < comps; c++) {
      const it = document.createElement("span");
      it.className = "fxwatch-legend-item";
      const sw = document.createElement("i");
      sw.style.background = SERIES[c] ?? SERIES[0]!;
      it.append(sw, document.createTextNode(names[c] || (perLed ? `LED ${this.probe}` : "value")));
      this.legend.append(it);
    }
    if (perLed && info.width === 1) {
      const it = document.createElement("span");
      it.className = "fxwatch-legend-item";
      const sw = document.createElement("i");
      sw.className = "is-band";
      sw.style.background = `${SERIES[0]}55`;
      it.append(sw, document.createTextNode("all LEDs (min…max)"));
      this.legend.append(it);
    }
    if (info.width > 4) {
      const more = document.createElement("span");
      more.className = "fxwatch-legend-item";
      more.textContent = `first 4 of ${info.width}`;
      this.legend.append(more);
    }
    this.canvas.setAttribute("aria-label", `Plot of ${this.exprs[sel]?.text ?? ""} over the last ${n} frames`);
  }
}

/** Frames across the plot: grows with the history, up to its capacity. */
function plotSpan(n: number): number {
  return Math.min(HISTORY_FRAMES, Math.max(n, 120));
}

/** An axis label: 3 significant digits relative to the visible range. */
function fmtTick(v: number, range: number): string {
  if (Math.abs(v) < range * 1e-6) return "0";
  const digits = Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(Math.max(range, 1e-12)))));
  return Number(v.toFixed(digits)).toString();
}

function blankInfo(error: string): WatchInfo {
  return { error, ty: "", width: 0, decode: "", class: null, func: "", store: "none", state_slot: -1, buffers: [], line: 0, col: 0 };
}
