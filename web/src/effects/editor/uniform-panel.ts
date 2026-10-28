/**
 * Auto uniform panel (docs/design/effects-compiler.md §"live uniform panel"):
 * renders one control per manifest uniform (slider/color/toggle/dropdown; a
 * ranged vector gets one slider per component, a mat3/mat4 an N×N number grid)
 * and holds the live values. Preview and device consume the SAME values — dragging a
 * control fires `onChange(slot, value[])` with the exact numbers both sinks use.
 *
 * On recompile the panel is RECONCILED against the new manifest: a uniform with
 * the same name+width+ui keeps its current live value; new ones appear at their
 * default; removed ones drop out. So tweaking the script while a slider sits at
 * 0.7 doesn't reset that slider.
 */

import type { FxUiKind, FxUniform } from "../../fx/preview";
import { reassembleUniformValues } from "../../net/uniformWire";
import { clampUniformValue, componentRanges, isRangedVector, matIndex, matrixDim } from "../uniformValues";

interface Slot {
  uniform: FxUniform;
  value: number[];
}

/** Stable identity key for reconciliation: same name+width+ui => keep value. */
function keyOf(u: FxUniform): string {
  return `${u.name}|${u.width}|${JSON.stringify(u.ui)}|${JSON.stringify([u.mins, u.maxs])}`;
}

export class UniformPanel {
  private slots: Slot[] = [];
  // Per-slot DOM refreshers registered during render(), so an EXTERNAL source
  // (MIDI) can move a control in place without a full re-render (which would
  // fight a learn UI and thrash the DOM at MIDI event rates). Keyed by slot.
  private setters = new Map<number, (value: number[]) => void>();

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (slot: number, value: number[]) => void,
  ) {}

  /** Current live values, keyed by manifest slot. */
  values(): { slot: number; value: number[] }[] {
    return this.slots.map((s) => ({ slot: s.uniform.slot, value: s.value.slice() }));
  }

  /**
   * Apply a value from an EXTERNAL driver (MIDI) to a slot: update the stored
   * value, move the on-screen control to match, and fan the change out via
   * onChange (so preview + device track it — the same seam a manual drag uses).
   * No-ops for an unknown slot. Does not re-render.
   */
  applyExternal(slot: number, value: number[]): void {
    const s = this.slots.find((x) => x.uniform.slot === slot);
    if (s === undefined) return;
    s.value = value.slice();
    this.setters.get(slot)?.(s.value);
    this.onChange(slot, s.value);
  }

  /** Overwrite live values (e.g. from device getEffectUniforms hydration). The
   * device reports a wide uniform (mat3/mat4) as consecutive ≤4-float slot
   * chunks: those are reassembled against the manifest first. */
  hydrate(values: { slot: number; value: number[] }[]): void {
    for (const v of reassembleUniformValues(
      values,
      this.slots.map((x) => x.uniform),
    )) {
      const s = this.slots.find((x) => x.uniform.slot === v.slot);
      if (s) s.value = v.value.slice();
    }
    this.render();
  }

  /** Reconcile against a new manifest, preserving live values where possible. */
  setManifest(uniforms: FxUniform[]): void {
    const prev = new Map(this.slots.map((s) => [keyOf(s.uniform), s.value]));
    this.slots = uniforms.map((u) => ({
      uniform: u,
      value: (prev.get(keyOf(u)) ?? u.default).slice(),
    }));
    this.render();
  }

  private set(slotIndex: number, value: number[]): void {
    const s = this.slots[slotIndex];
    if (s === undefined) return;
    s.value = value;
    this.onChange(s.uniform.slot, value);
  }

  private render(): void {
    this.root.replaceChildren();
    this.setters.clear();
    if (this.slots.length === 0) {
      const p = document.createElement("p");
      p.className = "muted upanel-empty";
      p.textContent = "No uniforms declared.";
      this.root.appendChild(p);
      return;
    }
    // A single 3-column grid (name · control · value) so every control type —
    // slider, color, toggle, dropdown — is the same width and lines up.
    const grid = document.createElement("div");
    grid.className = "upanel-grid";
    this.slots.forEach((s, i) => {
      if (isRangedVector(s.uniform)) this.vectorRows(grid, s, i);
      else this.row(grid, s, i);
    });
    this.root.appendChild(grid);
  }

  /** Append one uniform's three grid cells (name, control, value). The row is a
   * `display:contents` label so clicking the name targets the control. */
  private row(grid: HTMLElement, s: Slot, i: number): void {
    const row = document.createElement(s.uniform.ui.kind === "matrix" ? "div" : "label");
    row.className = "upanel-row";

    const name = document.createElement("span");
    name.className = "upanel-name";
    name.textContent = s.uniform.name;
    name.title = s.uniform.name;

    if (s.uniform.ui.kind === "matrix") {
      // The N×N grid spans the control + value columns.
      row.append(name, this.matrix(s, i));
      grid.appendChild(row);
      return;
    }

    const ctrl = document.createElement("span");
    ctrl.className = "upanel-ctrl";
    const value = document.createElement("span");
    value.className = "upanel-val";

    this.fill(ctrl, value, s, i);
    row.append(name, ctrl, value);
    grid.appendChild(row);
  }

  /** A ranged vector (`uniform vec3 p : -1 .. 1`): one slider row per
   * component (`p.x`, `p.y`, …), each with its own (possibly signed,
   * per-component) range. Never a colour picker. */
  private vectorRows(grid: HTMLElement, s: Slot, i: number): void {
    const u = s.uniform;
    const ui = u.ui as Extract<FxUiKind, { kind: "slider" }>;
    const ranges = componentRanges(u);
    const movers: ((v: number) => void)[] = [];
    for (let c = 0; c < u.width; c++) {
      const row = document.createElement("label");
      row.className = "upanel-row";
      const name = document.createElement("span");
      name.className = "upanel-name";
      name.textContent = `${u.name}.${COMPONENT[c] ?? c}`;
      name.title = name.textContent;
      const ctrl = document.createElement("span");
      ctrl.className = "upanel-ctrl";
      const value = document.createElement("span");
      value.className = "upanel-val";
      const r = ranges?.[c] ?? { min: ui.min, max: ui.max };
      movers.push(
        this.sliderPair(ctrl, value, r.min, r.max, ui.step, () => s.value[c] ?? r.min, (v) => {
          const next = s.value.slice();
          next[c] = v;
          this.set(i, clampUniformValue(u, next));
        }),
      );
      row.append(name, ctrl, value);
      grid.appendChild(row);
    }
    this.setters.set(u.slot, (v) => movers.forEach((m, c) => m(v[c] ?? 0)));
  }

  /** A mat3/mat4 as an N×N grid of number fields, shown row by row like a
   * written matrix; storage is column-major (GLSL): element (row r, col c) is
   * value[c*N + r]. A typed entry is clamped to the declared range. */
  private matrix(s: Slot, i: number): HTMLElement {
    const u = s.uniform;
    const n = matrixDim(u) ?? Math.max(1, Math.round(Math.sqrt(u.width)));
    const ranges = componentRanges(u);
    const box = document.createElement("span");
    box.className = "upanel-mat";
    box.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    const cells: HTMLInputElement[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const k = matIndex(r, c, n);
        const rg = ranges?.[k];
        const el = document.createElement("input");
        el.type = "number";
        el.className = "upanel-num";
        el.step = "any";
        if (rg) {
          el.min = String(rg.min);
          el.max = String(rg.max);
        }
        el.title = `${u.name}[${c}][${r}] (row ${r}, column ${c})`;
        el.value = fmtNum(s.value[k] ?? 0);
        el.addEventListener("change", () => {
          const next = s.value.slice();
          const typed = parseFloat(el.value);
          next[k] = Number.isFinite(typed) ? typed : (s.value[k] ?? 0);
          const v = clampUniformValue(u, next);
          el.value = fmtNum(v[k] ?? 0);
          this.set(i, v);
        });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            el.blur();
          }
        });
        cells[k] = el;
        box.appendChild(el);
      }
    }
    this.setters.set(u.slot, (v) => cells.forEach((el, k) => (el.value = fmtNum(v[k] ?? 0))));
    return box;
  }

  /** A range slider (in `ctrl`) + an editable number field (in `value`) for one
   * number in [min,max]; typing clamps + snaps to the step. Returns a mover
   * that sets both from outside (MIDI / hydration). */
  private sliderPair(
    ctrl: HTMLElement,
    value: HTMLElement,
    min: number,
    max: number,
    stepIn: number,
    current: () => number,
    onValue: (v: number) => void,
  ): (v: number) => void {
    const step = stepIn > 0 ? stepIn : 0.001;
    const cur = current();
    const el = document.createElement("input");
    el.type = "range";
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(cur);

    const num = document.createElement("input");
    num.type = "number";
    num.className = "upanel-num";
    num.min = String(min);
    num.max = String(max);
    num.step = String(step);
    num.value = fmtNum(cur);

    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      num.value = fmtNum(v);
      onValue(v);
    });
    // Commit the typed value on Enter/blur: clamp to [min,max] and snap to step.
    const commit = (): void => {
      let v = parseFloat(num.value);
      if (!Number.isFinite(v)) v = current();
      v = snap(v, min, max, step);
      el.value = String(v);
      num.value = fmtNum(v);
      onValue(v);
    };
    num.addEventListener("change", commit);
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        num.blur();
      }
    });

    ctrl.appendChild(el);
    value.appendChild(num);
    return (n: number) => {
      el.value = String(n);
      num.value = fmtNum(n);
    };
  }

  private fill(ctrl: HTMLElement, value: HTMLElement, s: Slot, i: number): void {
    const ui: FxUiKind = s.uniform.ui;

    if (ui.kind === "toggle") {
      const el = document.createElement("input");
      el.type = "checkbox";
      el.checked = (s.value[0] ?? 0) >= 0.5;
      el.addEventListener("change", () => {
        this.set(i, [el.checked ? 1 : 0]);
        value.textContent = el.checked ? "on" : "off";
      });
      ctrl.appendChild(el);
      value.textContent = el.checked ? "on" : "off";
      this.setters.set(s.uniform.slot, (v) => {
        el.checked = (v[0] ?? 0) >= 0.5;
        value.textContent = el.checked ? "on" : "off";
      });
      return;
    }

    if (ui.kind === "color") {
      // A native <input type="color"> renders inconsistently across platforms —
      // a full-width swatch on Android/Chrome but a small fixed circle on iOS
      // WKWebView (it ignores width/height). Wrap it: a styled swatch we control
      // for the visuals, with the native input overlaid invisibly so a tap still
      // opens each platform's colour picker.
      const wrap = document.createElement("label");
      wrap.className = "upanel-color";
      const swatch = document.createElement("span");
      swatch.className = "upanel-color-swatch";
      const el = document.createElement("input");
      el.type = "color";
      el.value = rgbToHex(s.value);
      swatch.style.background = el.value;
      value.textContent = el.value;
      el.addEventListener("input", () => {
        this.set(i, hexToRgb(el.value, s.uniform.width));
        swatch.style.background = el.value;
        value.textContent = el.value;
      });
      wrap.append(swatch, el);
      ctrl.appendChild(wrap);
      return;
    }

    if (ui.kind === "dropdown") {
      const el = document.createElement("select");
      ui.options.forEach((opt, idx) => {
        const o = document.createElement("option");
        o.value = String(idx);
        o.textContent = opt;
        el.appendChild(o);
      });
      el.value = String(Math.round(s.value[0] ?? 0));
      el.addEventListener("change", () => this.set(i, [parseInt(el.value, 10)]));
      ctrl.appendChild(el);
      return;
    }

    if (ui.kind === "matrix") return; // rendered by matrix()

    // slider + an editable number field (type a value → clamp+snap to range).
    const move = this.sliderPair(ctrl, value, ui.min, ui.max, ui.step, () => this.slots[i]?.value[0] ?? ui.min, (v) =>
      this.set(i, [v]),
    );
    // External (MIDI) driver moves both the slider and the number field.
    this.setters.set(s.uniform.slot, (v) => move(v[0] ?? ui.min));
  }
}

const COMPONENT = ["x", "y", "z", "w"];

function clampN(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
/** Clamp to [min,max] then snap to the slider's step grid. */
function snap(v: number, min: number, max: number, step: number): number {
  v = clampN(v, min, max);
  if (step > 0) v = min + Math.round((v - min) / step) * step;
  return clampN(v, min, max);
}
/** Compact numeric label (up to 4 decimals, trailing zeros trimmed). */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 1e4) / 1e4);
}

function clamp255(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}
function rgbToHex(v: number[]): string {
  const [r, g, b] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  const h = (n: number): string => clamp255(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function hexToRgb(hex: string, width: number): number[] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const out = [r, g, b];
  // vec4 color uniforms carry an alpha slot; default it opaque.
  if (width >= 4) out.push(1);
  return out.slice(0, Math.max(3, width));
}
