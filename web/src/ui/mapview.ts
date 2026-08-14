/**
 * M8 — result preview: a dependency-free 3D scatter of the reconstructed map
 * on a 2D canvas (depth-sorted painter's algorithm, colored by confidence).
 * A preview, not a CAD viewer — Sim Studio is the real inspection tool.
 *
 * Interactive (CAD-style, no inertia, mirroring Sim Studio's conventions):
 * one pointer drags to orbit, two-finger drag pans, pinch or wheel zooms,
 * mouse pan via shift/middle/right drag. Auto-orbits slowly until the first
 * interaction. Works both as the post-solve result browser and as the live
 * in-capture inset (`update()` swaps maps without resetting the camera).
 */

import type { OutputMap, Topology, Vec3 } from "@ledmapper/protocol";
import type { TopologyDebug, TopologyStage } from "../topology/extract";
import { applySimilarity, fitSimilarity, type Similarity } from "../geom/fit";
import { renderSettings } from "../store/appearance";

/** Which diagnostic overlays to draw over the topology (all off by default —
 * MapView pays no cost until a layer is switched on from the Debug section). */
export interface DebugOverlayFlags {
  coincident: boolean;
  edges: boolean;
  chords: boolean;
}

export interface TruthPoint {
  id: number;
  xyz: Vec3;
}

export class MapView {
  private raf = 0;
  private yaw = 0;
  private pitch = 0.35;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private autoOrbit = true;
  private ac: AbortController | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();

  // Backing-store sizing: the canvas is drawn in CSS-pixel units and the 2D
  // context is scaled by the device pixel ratio, so the backing store matches
  // the on-screen size at full resolution (crisp in wide/desktop layouts, not
  // an upscaled fixed-size buffer). Kept in sync via a ResizeObserver.
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private resizeObs: ResizeObserver | null = null;

  // Ground-truth overlay: truth points are aligned to the solve via a
  // similarity fit (truth is only meaningful up to scale/rotation/translation)
  // and rendered with per-point delta vectors + magnitudes.
  private truth: TruthPoint[] | null = null;
  private fit: Similarity | null = null;
  private fitForMap: OutputMap | null = null;

  // Solved camera trajectory (visual-inertial solves) — same frame as the
  // LEDs; rendered as a polyline when toggled on.
  private trajectory: Vec3[] | null = null;
  showTrajectory = false;
  /** Toggle a graduated ground grid (Y=0 plane) and a world coordinate triad.
   * Seeded in the constructor from the Appearance defaults (see below) so a
   * default of "on" makes new views *start* with the overlay, while per-view
   * toggles can still turn it back off. */
  showGrid = false;
  showTriad = false;
  /** Draw the solver-stats footer + interaction hint. Off for small decorative
   * previews (e.g. Settings' appearance preview) where the numbers are noise. */
  showStats = true;
  /** Tight, pose-aware framing: scale to the LEDs' projected extent in the
   * current orbit pose (rather than the conservative 3D bounding sphere) so the
   * fixture fills the frame. Used for thumbnails; see useThumbnailFraming(). */
  fitTight = false;

  // Extracted topology overlay: the segment polylines drawn over the LEDs, for
  // live preview while tuning the extraction (topology/extract.ts).
  private topology: Topology | null = null;

  // Diagnostic overlay (topology/extract.ts debug report): (near-)coincident LED
  // pairs, the raw graph edges, and loop-chords — drawn only for the enabled
  // flags. Null (the default) draws nothing extra, so normal topology rendering
  // is untouched unless the user opts in from the Debug section.
  private debug: TopologyDebug | null = null;
  private debugFlags: DebugOverlayFlags = { coincident: false, edges: false, chords: false };

  // Pipeline-stage inspector: when set, the overlay draws THIS stage's graph
  // (nodes/edges/segments/branch points) INSTEAD of the final topology, so the
  // Debug "stage" scrubber can step through k-NN → MST → … → dissolve.
  private stage: TopologyStage | null = null;

  // Per-LED effect colours (flat RGB, aligned to map.leds order). When set, the
  // LEDs render as glowing lights on black instead of confidence shading — the
  // effects-simulator workspace pushes a fresh frame here each animation tick.
  private ledColors: Uint8Array | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private map: OutputMap,
  ) {
    // The Appearance grid/triad/stats settings are *defaults*: they seed the
    // initial per-view state at construction, after which this.showGrid/
    // showTriad/showStats own the decision (so a per-view toggle can turn an
    // on-by-default overlay off — e.g. Acid Mode forces showStats off).
    const rs = renderSettings();
    this.showGrid = rs.showGrid;
    this.showTriad = rs.showTriad;
    this.showStats = rs.showStats;
  }

  /** Swap in a newer map (live preview) without resetting the camera. */
  update(map: OutputMap): void {
    this.map = map;
  }

  /** Configure this view as a Maps-tab thumbnail: strip the diagnostic overlays
   * (grid, world triad, solver-stats footer) *regardless* of the Appearance
   * defaults the constructor seeded, and frame tight so the fixture fills the
   * snapshot. A thumbnail is a decorative "what does this map look like" icon,
   * not an inspection tool, so the overlays are pure noise at 128px. Returns
   * `this` for chaining (see mapStore.renderThumbnail). */
  useThumbnailFraming(): this {
    this.showGrid = false;
    this.showTriad = false;
    this.showStats = false;
    this.fitTight = true;
    return this;
  }

  /** Set (or clear) the ground-truth layout to compare against. */
  setTruth(points: TruthPoint[] | null): void {
    this.truth = points;
    this.fitForMap = null;
  }

  /** Set (or clear) the solved camera path (drawn when showTrajectory). */
  setTrajectory(path: Vec3[] | null): void {
    this.trajectory = path && path.length >= 2 ? path : null;
  }

  /** Set (or clear) the extracted topology to overlay (segment polylines). */
  setTopology(topology: Topology | null): void {
    this.topology = topology;
  }

  /** Set (or clear) per-LED effect colours (flat RGB, one triple per LED in
   * map.leds order). Non-null switches the scatter into "light" rendering. */
  setLedColors(colors: Uint8Array | null): void {
    this.ledColors = colors;
  }

  /** Set (or clear) the topology-diagnostics overlay + which layers to draw.
   * Pass `debug = null` to remove it entirely; the enabled `flags` decide which
   * of coincident pairs / graph edges / loop-chords appear. */
  setDebugOverlay(debug: TopologyDebug | null, flags?: Partial<DebugOverlayFlags>): void {
    this.debug = debug;
    if (flags) this.debugFlags = { ...this.debugFlags, ...flags };
  }

  /** Show a single pipeline stage's graph instead of the final topology (Debug
   * "stage" scrubber). Pass `null` to return to the normal topology overlay. */
  setStage(stage: TopologyStage | null): void {
    this.stage = stage;
  }

  get hasTrajectory(): boolean {
    return this.trajectory !== null;
  }

  /** Re-fit the truth→solve similarity when the map instance changed. */
  private ensureFit(): void {
    if (this.truth === null || this.fitForMap === this.map) return;
    const byId = new Map(this.map.leds.map((l) => [l.id, l.xyz]));
    const src: Vec3[] = [];
    const dst: Vec3[] = [];
    for (const t of this.truth) {
      const s = byId.get(t.id);
      if (s !== undefined) {
        src.push(t.xyz);
        dst.push(s);
      }
    }
    this.fit = src.length >= 3 ? fitSimilarity(src, dst) : null;
    this.fitForMap = this.map;
  }

  start(): void {
    this.stop();
    this.attach();
    this.resizeToDisplay();
    // Track the element's displayed size so the backing store always matches it
    // (wide layouts, splitter drags, orientation changes, DPR shifts on zoom).
    this.resizeObs = new ResizeObserver(() => this.resizeToDisplay());
    this.resizeObs.observe(this.canvas);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.autoOrbit) this.yaw += 0.005;
      this.draw();
    };
    loop();
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ac?.abort();
    this.ac = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.pointers.clear();
  }

  /** Match the canvas backing store to its CSS display size × devicePixelRatio.
   * Draw code works in CSS px (the context is scaled by dpr in `draw`). */
  private resizeToDisplay(): void {
    const c = this.canvas;
    const cssW = c.clientWidth;
    const cssH = c.clientHeight;
    if (cssW === 0 || cssH === 0) return; // not laid out yet
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5); // cap for fill-rate
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
  }

  // -- input ------------------------------------------------------------

  private attach(): void {
    this.ac = new AbortController();
    const opts = { signal: this.ac.signal };
    const c = this.canvas;
    c.style.touchAction = "none"; // keep pinch/drag out of the browser's hands

    c.addEventListener(
      "pointerdown",
      (e) => {
        c.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.autoOrbit = false;
        e.preventDefault();
      },
      opts,
    );

    c.addEventListener(
      "pointermove",
      (e) => {
        const prev = this.pointers.get(e.pointerId);
        if (!prev) return;
        const cur = { x: e.clientX, y: e.clientY };
        // Draw space is CSS px (the context is dpr-scaled), so pointer deltas —
        // also CSS px — map 1:1 for panning.
        const s = 1;

        if (this.pointers.size === 1) {
          const dx = cur.x - prev.x;
          const dy = cur.y - prev.y;
          const mousePan = e.pointerType === "mouse" && ((e.buttons & 6) !== 0 || e.shiftKey);
          if (mousePan) {
            this.panX += dx * s;
            this.panY += dy * s;
          } else {
            this.yaw += dx * 0.008;
            this.pitch = clamp(this.pitch + dy * 0.008, -1.55, 1.55);
          }
        } else if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.entries()].map(([id, p]) => ({
            prev: p,
            cur: id === e.pointerId ? cur : p,
          }));
          // Centroid delta → pan; distance ratio → zoom (both anchored on
          // this event's pointer only, so each move applies once).
          this.panX += ((a!.cur.x + b!.cur.x - a!.prev.x - b!.prev.x) / 2) * s;
          this.panY += ((a!.cur.y + b!.cur.y - a!.prev.y - b!.prev.y) / 2) * s;
          const dPrev = Math.hypot(a!.prev.x - b!.prev.x, a!.prev.y - b!.prev.y);
          const dCur = Math.hypot(a!.cur.x - b!.cur.x, a!.cur.y - b!.cur.y);
          if (dPrev > 1e-3) this.zoom = clamp(this.zoom * (dCur / dPrev), 0.05, 40);
        }
        this.pointers.set(e.pointerId, cur);
        e.preventDefault();
      },
      opts,
    );

    const drop = (e: PointerEvent) => this.pointers.delete(e.pointerId);
    c.addEventListener("pointerup", drop, opts);
    c.addEventListener("pointercancel", drop, opts);

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.autoOrbit = false;
        this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0015), 0.05, 40);
      },
      { signal: this.ac.signal, passive: false },
    );
    // Right-drag pans; keep the context menu off the viewport.
    c.addEventListener("contextmenu", (e) => e.preventDefault(), opts);
  }

  // -- rendering ----------------------------------------------------------

  private draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    // Draw in CSS px; scale the context by dpr so the backing store renders at
    // full device resolution. Fall back to raw canvas px before first layout.
    const laidOut = this.cssW > 0 && this.cssH > 0;
    const dpr = laidOut ? this.dpr : 1;
    const w = laidOut ? this.cssW : this.canvas.width;
    const h = laidOut ? this.cssH : this.canvas.height;
    // Live appearance knobs (Settings ▸ Appearance) — read each frame so a
    // change re-themes every open viewport immediately. Grid/triad are seeded
    // from the defaults at construction, then owned by the per-view toggles.
    const rs = renderSettings();
    const showGrid = this.showGrid;
    const showTriad = this.showTriad;
    const ledScale = rs.ledSize;
    const glow = rs.glow;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = rs.viewBg;
    ctx.fillRect(0, 0, w, h);
    const leds = this.map.leds;
    if (leds.length === 0) {
      ctx.fillStyle = "#888";
      ctx.font = "14px system-ui";
      ctx.fillText("no LEDs solved", 16, 24);
      return;
    }

    // Center + scale to fit (the camera path, when shown, is part of the
    // scene bounds — it extends meters beyond the fixture).
    const boundPts: Vec3[] = leds.map((l) => l.xyz);
    if (this.showTrajectory && this.trajectory !== null) boundPts.push(...this.trajectory);
    let cx = 0, cy = 0, cz = 0;
    for (const p of boundPts) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    cx /= boundPts.length;
    cy /= boundPts.length;
    cz /= boundPts.length;
    let maxR = 1e-6;
    for (const p of boundPts) {
      const r = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
      if (r > maxR) maxR = r;
    }

    const sinA = Math.sin(this.yaw);
    const cosA = Math.cos(this.yaw);
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);

    // Framing radius. The default fit uses the 3D bounding-sphere radius (maxR),
    // which is rotation-invariant and stable while orbiting but leaves margin —
    // it reserves room for the fixture's deepest axis even when that axis points
    // at the camera. Thumbnails instead fit the *projected* extent in this pose
    // (dropping the depth axis) so the fixture fills the frame — a real
    // zoom-to-fit. maxR itself is left untouched: the grid/triad sizing below
    // still keys off the world-space radius.
    let fitR = maxR;
    if (this.fitTight) {
      let pr = 1e-6;
      for (const l of leds) {
        const x = l.xyz[0] - cx;
        const y = l.xyz[1] - cy;
        const z = l.xyz[2] - cz;
        const rx = x * cosA + z * sinA;
        const rz = -x * sinA + z * cosA;
        const ty = y * cosP - rz * sinP;
        const r = Math.hypot(rx, ty);
        if (r > pr) pr = r;
      }
      fitR = pr;
    }
    // Fill fraction of the min viewport dimension. A touch more of the frame for
    // the tight thumbnail fit (which already sheds the depth-axis margin).
    const fill = this.fitTight ? 0.46 : 0.42;
    const scale = ((Math.min(w, h) * fill) / fitR) * this.zoom;
    // Orbit about the +Y (up) axis, then pitch about the view's x axis.
    const proj = (p: Vec3): { sx: number; sy: number; depth: number } => {
      const x = p[0] - cx;
      const y = p[1] - cy;
      const z = p[2] - cz;
      const rx = x * cosA + z * sinA;
      const rz = -x * sinA + z * cosA;
      const ty = y * cosP - rz * sinP;
      const tz = y * sinP + rz * cosP;
      return {
        sx: w / 2 + rx * scale + this.panX,
        sy: h / 2 - ty * scale + this.panY,
        depth: tz,
      };
    };
    // Project a world point given as (x,y,z) — cast keeps the tuple type happy.
    const pw = (x: number, y: number, z: number): { sx: number; sy: number; depth: number } =>
      proj([x, y, z] as unknown as Vec3);

    // -- reference grid on the ground (Y=0) plane, with graduations ---------
    if (showGrid) {
      const step = niceStep(maxR / 4); // ~8 divisions across the fixture
      const n = Math.max(2, Math.ceil((maxR * 1.4) / step));
      const ext = n * step;
      ctx.lineWidth = 1;
      for (let i = -n; i <= n; i++) {
        const t = i * step;
        ctx.strokeStyle = i === 0 ? "rgb(255 255 255 / 0.28)" : "rgb(255 255 255 / 0.08)";
        let a = pw(t, 0, -ext);
        let b = pw(t, 0, ext);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
        a = pw(-ext, 0, t);
        b = pw(ext, 0, t);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
      // Graduation labels along the X (z=0) and Z (x=0) axes.
      ctx.font = "10px system-ui";
      ctx.fillStyle = "rgb(255 255 255 / 0.4)";
      for (let i = -n; i <= n; i++) {
        if (i === 0) continue;
        const t = i * step;
        const lx = pw(t, 0, 0);
        ctx.fillText(fmtMeters(t), lx.sx + 2, lx.sy - 2);
        const lz = pw(0, 0, t);
        ctx.fillText(fmtMeters(t), lz.sx + 2, lz.sy - 2);
      }
      ctx.fillStyle = "rgb(255 255 255 / 0.5)";
      ctx.fillText(`grid ${fmtMeters(step)}`, 12, 34);
    }

    // -- camera trajectory (under everything else: it is context, not data) --
    if (this.showTrajectory && this.trajectory !== null) {
      ctx.beginPath();
      for (let i = 0; i < this.trajectory.length; i++) {
        const s = proj(this.trajectory[i]!);
        if (i === 0) ctx.moveTo(s.sx, s.sy);
        else ctx.lineTo(s.sx, s.sy);
      }
      ctx.strokeStyle = "rgb(80 200 255 / 0.55)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Walk direction: hollow ring at the start, filled dot at the end.
      const first = proj(this.trajectory[0]!);
      const last = proj(this.trajectory[this.trajectory.length - 1]!);
      ctx.beginPath();
      ctx.arc(first.sx, first.sy, 4, 0, Math.PI * 2);
      ctx.strokeStyle = "rgb(80 200 255 / 0.8)";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(last.sx, last.sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(80 200 255 / 0.9)";
      ctx.fill();
    }

    const pts = leds.map((l, i) => ({ ...proj(l.xyz), led: l, idx: i }));
    pts.sort((a, b) => a.depth - b.depth);

    // -- ground truth: aligned points, delta vectors, magnitudes -----------
    this.ensureFit();
    let deltaSummary = "";
    if (this.truth !== null && this.fit !== null) {
      const byId = new Map(this.map.leds.map((l) => [l.id, l.xyz]));
      interface Pair {
        ts: { sx: number; sy: number };
        ss: { sx: number; sy: number } | null;
        distM: number;
      }
      const pairs: Pair[] = [];
      const dists: number[] = [];
      ctx.lineWidth = 1;
      for (const t of this.truth) {
        const tw = applySimilarity(this.fit, t.xyz);
        const ts = proj(tw);
        const solved = byId.get(t.id);
        if (solved === undefined) {
          // Unsolved LED: dim hollow marker shows what's missing.
          ctx.beginPath();
          ctx.arc(ts.sx, ts.sy, 4, 0, Math.PI * 2);
          ctx.strokeStyle = "rgb(255 255 255 / 0.25)";
          ctx.stroke();
          continue;
        }
        const distM = Math.hypot(tw[0] - solved[0], tw[1] - solved[1], tw[2] - solved[2]);
        pairs.push({ ts, ss: proj(solved), distM });
        dists.push(distM);
      }

      // Delta vectors truth → solved, then truth markers on top.
      ctx.strokeStyle = "rgb(255 160 40 / 0.9)";
      for (const p of pairs) {
        if (!p.ss) continue;
        ctx.beginPath();
        ctx.moveTo(p.ts.sx, p.ts.sy);
        ctx.lineTo(p.ss.sx, p.ss.sy);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgb(255 255 255 / 0.85)";
      for (const p of pairs) {
        ctx.beginPath();
        ctx.arc(p.ts.sx, p.ts.sy, 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Magnitude labels: all of them for small fixtures, the worst ones
      // for big fixtures (labels would otherwise shingle).
      const labeled =
        pairs.length <= 16 ? pairs : [...pairs].sort((a, b) => b.distM - a.distM).slice(0, 8);
      ctx.font = "11px system-ui";
      ctx.fillStyle = "rgb(255 200 120 / 0.95)";
      for (const p of labeled) {
        if (!p.ss) continue;
        const mm = p.distM * 1000;
        const label = mm >= 100 ? `${(mm / 10).toFixed(0)}cm` : `${mm.toFixed(mm < 10 ? 1 : 0)}mm`;
        ctx.fillText(label, (p.ts.sx + p.ss.sx) / 2 + 5, (p.ts.sy + p.ss.sy) / 2 - 4);
      }

      if (dists.length > 0) {
        const rms = Math.sqrt(dists.reduce((a, d) => a + d * d, 0) / dists.length) * 1000;
        const max = Math.max(...dists) * 1000;
        deltaSummary = ` · Δtruth rms ${rms.toFixed(1)}mm max ${max.toFixed(1)}mm (${dists.length} pts)`;
      }
    } else if (this.truth !== null) {
      deltaSummary = " · Δtruth: needs ≥3 solved ids";
    }

    if (this.ledColors !== null) {
      // Effect mode: LEDs as glowing lights. A soft additive halo sells the
      // "light" look; the core dot carries the true colour.
      const col = this.ledColors;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const p of pts) {
        const o = p.idx * 3;
        const r = col[o] ?? 0;
        const g = col[o + 1] ?? 0;
        const b = col[o + 2] ?? 0;
        const bright = (r + g + b) / 3;
        if (bright > 6 && glow > 0) {
          const rad = (6 + bright / 10) * ledScale;
          const halo = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad);
          halo.addColorStop(0, `rgb(${r} ${g} ${b} / ${Math.min(1, 0.55 * glow).toFixed(3)})`);
          halo.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      for (const p of pts) {
        const o = p.idx * 3;
        const r = col[o] ?? 0;
        const g = col[o + 1] ?? 0;
        const b = col[o + 2] ?? 0;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 2.2 * ledScale, 0, Math.PI * 2);
        // Unlit LEDs stay a faint grey so the fixture shape is always visible.
        ctx.fillStyle = r + g + b < 12 ? "rgb(60 60 68)" : `rgb(${r} ${g} ${b})`;
        ctx.fill();
      }
    } else {
      for (const p of pts) {
        const c = p.led.confidence;
        const r = (2.5 + 2 * c) * ledScale;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        // Confidence: green (high) -> amber -> red (low).
        const hue = Math.round(c * 120);
        ctx.fillStyle = `hsl(${hue} 90% 50%)`;
        ctx.fill();
      }
    }

    // -- pipeline-stage inspector: draw the selected stage's graph (edges +
    //    nodes for early stages, polylines + junctions for late ones) and skip
    //    the normal topology overlay so the two don't overlap.
    if (this.stage !== null) {
      const st = this.stage;
      // Graph edges: thin cyan lines.
      ctx.strokeStyle = "rgb(80 220 255 / 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const e of st.edges) {
        const a = proj(e.a);
        const b = proj(e.b);
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
      }
      ctx.stroke();
      // Graph nodes (deduped): small yellow dots (a self-crossing shows one dot
      // where two strand parts merged).
      ctx.fillStyle = "rgb(255 210 90 / 0.9)";
      for (const nd of st.nodes) {
        const p = proj(nd);
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Segment polylines (later stages): brighter cyan with vertex rings.
      ctx.strokeStyle = "rgb(80 220 255 / 0.95)";
      ctx.lineWidth = 2;
      ctx.fillStyle = "rgb(80 220 255 / 0.95)";
      for (const seg of st.segments) {
        if (seg.polyline.length < 2) continue;
        ctx.beginPath();
        seg.polyline.forEach((v, i) => {
          const p = proj(v);
          if (i === 0) ctx.moveTo(p.sx, p.sy);
          else ctx.lineTo(p.sx, p.sy);
        });
        ctx.stroke();
        for (const v of seg.polyline) {
          const p = proj(v);
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Branch points: magenta rings.
      ctx.strokeStyle = "rgb(255 90 220 / 0.95)";
      ctx.lineWidth = 2;
      for (const bp of st.branchPoints) {
        const p = proj(bp);
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Stage name, top-left under the hint line.
      ctx.fillStyle = "rgb(255 210 90 / 0.95)";
      ctx.font = "bold 12px system-ui";
      ctx.fillText(`stage: ${st.name}`, 12, 36);
    }

    // -- topology overlay: the extracted skeleton polylines over the LEDs -----
    if (this.stage === null && this.topology !== null) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgb(80 220 255 / 0.9)";
      for (const seg of this.topology.segments) {
        if (seg.polyline.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < seg.polyline.length; i++) {
          const s = proj(seg.polyline[i]!);
          if (i === 0) ctx.moveTo(s.sx, s.sy);
          else ctx.lineTo(s.sx, s.sy);
        }
        ctx.stroke();
        // Small ring at each polyline vertex (the decimated waypoints).
        ctx.fillStyle = "rgb(80 220 255 / 0.9)";
        for (const v of seg.polyline) {
          const s = proj(v);
          ctx.beginPath();
          ctx.arc(s.sx, s.sy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Junctions (branch points) as distinct magenta rings.
      ctx.strokeStyle = "rgb(255 90 220 / 0.95)";
      ctx.lineWidth = 2;
      for (const bp of this.topology.branchPoints) {
        const s = proj(bp.xyz);
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // -- diagnostics overlay: raw graph edges, loop-chords, coincident pairs --
    // Drawn over the skeleton, under the triad. Each layer is independent and
    // only present when its flag is on (see setDebugOverlay).
    if (this.debug !== null) {
      const dbg = this.debug;
      const f = this.debugFlags;
      // Raw connectivity: thin faint grey lines a→b (the whole kept graph).
      if (f.edges) {
        ctx.strokeStyle = "rgb(200 210 230 / 0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const e of dbg.edges) {
          const a = proj(e.a);
          const b = proj(e.b);
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
        }
        ctx.stroke();
      }
      // Loop-chords: thick orange — the candidate false bridges.
      if (f.chords) {
        ctx.strokeStyle = "rgb(255 140 40 / 0.95)";
        ctx.lineWidth = 3;
        for (const e of dbg.edges) {
          if (!e.chord) continue;
          const a = proj(e.a);
          const b = proj(e.b);
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        }
      }
      // Coincident pairs: a bright warning marker at each pair's midpoint, plus
      // a short connector, sized so an overlapping pair is still eyeball-able.
      if (f.coincident) {
        ctx.lineWidth = 1.5;
        for (const c of dbg.coincident) {
          const a = proj(c.a);
          const b = proj(c.b);
          const mx = (a.sx + b.sx) / 2;
          const my = (a.sy + b.sy) / 2;
          ctx.strokeStyle = "rgb(242 85 90 / 0.9)";
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
          // Diamond marker (distinct from the round LED/junction dots).
          const r = 7;
          ctx.beginPath();
          ctx.moveTo(mx, my - r);
          ctx.lineTo(mx + r, my);
          ctx.lineTo(mx, my + r);
          ctx.lineTo(mx - r, my);
          ctx.closePath();
          ctx.fillStyle = "rgb(242 85 90 / 0.35)";
          ctx.fill();
          ctx.strokeStyle = "rgb(255 120 120 / 0.95)";
          ctx.stroke();
        }
      }
    }

    // -- world coordinate triad (X red, Y green, Z blue), on top -----------
    if (showTriad) {
      const L = niceStep(maxR / 2) * 2;
      const O = pw(0, 0, 0);
      const axes: [number, number, number, string, string][] = [
        [L, 0, 0, "rgb(255 90 90 / 0.95)", "X"],
        [0, L, 0, "rgb(120 230 120 / 0.95)", "Y"],
        [0, 0, L, "rgb(90 160 255 / 0.95)", "Z"],
      ];
      ctx.lineWidth = 2;
      ctx.font = "bold 11px system-ui";
      for (const [x, y, z, color, label] of axes) {
        const e = pw(x, y, z);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(O.sx, O.sy);
        ctx.lineTo(e.sx, e.sy);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(e.sx, e.sy, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(label, e.sx + 3, e.sy - 3);
      }
    }

    if (this.showStats) {
      ctx.fillStyle = "#aaa";
      ctx.font = "12px system-ui";
      // stats is optional on OutputMap — the reprojection solve summary is only
      // present on solver output, not on synthetic or imported-without-stats
      // maps — so fold the rms/parallax fragment in only when it exists.
      // (Without this guard draw() throws every animation frame, flooding the
      // console; see FUG-56.)
      const s = this.map.stats;
      const solveSummary = s
        ? ` · rms ${s.rmsReprojPxGlobal.toFixed(2)} px · median parallax ${s.medianParallaxDeg.toFixed(1)}°`
        : "";
      ctx.fillText(
        `${leds.length}/${this.map.ledCount} solved${solveSummary}${deltaSummary}`,
        12,
        h - 12,
      );
      ctx.fillStyle = "#666";
      ctx.fillText("drag orbit · 2-finger pan · pinch/scroll zoom", 12, 18);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Round up to a "nice" 1/2/5×10^k step for grid graduations. */
function niceStep(x: number): number {
  if (!(x > 0) || !isFinite(x)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  const m = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return m * p;
}

/** Compact meter/cm/mm label for a signed length. */
function fmtMeters(m: number): string {
  const a = Math.abs(m);
  if (a < 0.01) return `${Math.round(m * 1000)}mm`;
  if (a < 1) return `${(m * 100).toFixed(a < 0.1 ? 1 : 0)}cm`;
  return `${m.toFixed(a < 10 ? 1 : 0)}m`;
}
