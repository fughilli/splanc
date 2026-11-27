/**
 * Auto uniform panel (docs/design/effects-compiler.md §"live uniform panel"):
 * renders one control per manifest uniform (slider/HSV colour picker/toggle/dropdown; a
 * ranged vector gets one slider per component, a `: vector` / `: direction`
 * vec2/vec3 an XY pad / direction dial or sphere, a mat3/mat4 an N×N number grid)
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
import { VectorSwatch, vectorSummary } from "../../ui/kit/vectorPicker";
import {
  clampUniformValue,
  componentRanges,
  isRangedVector,
  matIndex,
  matrixDim,
  snapToStep,
  stepAttr,
} from "../uniformValues";
import { toHex } from "../../color/hsv";
import { ColorSwatch } from "../../ui/kit/hsvPicker";

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
    /** `label` renames controls for display (the Effects tab's tune sheet shows
     * "Base color" for `base_color`); the editor shows the raw names. `empty`
     * replaces the "No uniforms declared." line. */
    private readonly opts: {
      label?: (name: string) => string;
      empty?: string;
      /** Once at the end of a gesture (a pad / slider release, a typed value):
       * the place to persist (LiveControl.commit) without waiting for idle. */
      onCommit?: (slot: number, value: number[]) => void;
    } = {},
  ) {}

  private label(name: string): string {
    return this.opts.label ? this.opts.label(name) : name;
  }

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

  /**
   * Set one slot's live value and move its control, WITHOUT firing onChange:
   * the caller decides which sinks get it (the agent's set_live_uniforms tool
   * applies the preview itself and sends to the device only when that is
   * honest, #452). Returns false for an unknown slot.
   */
  setLive(slot: number, value: number[]): boolean {
    const s = this.slots.find((x) => x.uniform.slot === slot);
    if (s === undefined) return false;
    s.value = value.slice();
    this.setters.get(slot)?.(s.value);
    return true;
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

  /** The end of a gesture on slot `slotIndex`: hand its value to onCommit. */
  private commitSlot(slotIndex: number): void {
    const s = this.slots[slotIndex];
    if (s) this.opts.onCommit?.(s.uniform.slot, s.value.slice());
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
      p.textContent = this.opts.empty ?? "No uniforms declared.";
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
    name.textContent = this.label(s.uniform.name);
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
      name.textContent = `${this.label(u.name)}.${COMPONENT[c] ?? c}`;
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
        }, () => this.commitSlot(i)),
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
   * number in [min,max]; typing clamps (and snaps when the uniform has a step
   * grid). `step` 0 is continuous: the uniform's native f32 precision, no
   * grid (D-541). Returns a mover that sets both from outside (MIDI / hydration). */
  private sliderPair(
    ctrl: HTMLElement,
    value: HTMLElement,
    min: number,
    max: number,
    step: number,
    current: () => number,
    onValue: (v: number) => void,
    onRelease?: () => void,
  ): (v: number) => void {
    const cur = current();
    const el = document.createElement("input");
    el.type = "range";
    el.min = String(min);
    el.max = String(max);
    el.step = stepAttr(step);
    el.value = String(cur);

    const num = document.createElement("input");
    num.type = "number";
    num.className = "upanel-num";
    num.min = String(min);
    num.max = String(max);
    num.step = stepAttr(step);
    num.value = fmtNum(cur);

    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      num.value = fmtNum(v);
      onValue(v);
    });
    el.addEventListener("change", () => onRelease?.());
    // Commit the typed value on Enter/blur: clamp to [min,max] (+ snap to a
    // declared step grid; a continuous uniform keeps exactly what was typed).
    const commit = (): void => {
      // The field shows a rounded label: an unedited field (Enter / blur with
      // no change) keeps the exact live value rather than the label.
      let v = num.value === fmtNum(current()) ? current() : parseFloat(num.value);
      if (!Number.isFinite(v)) v = current();
      v = snapToStep(v, min, max, step);
      el.value = String(v);
      num.value = fmtNum(v);
      onValue(v);
      onRelease?.();
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
      // The live HSV picker (D-541): a swatch that opens a hue ring + SV
      // square (a Sheet on phones, a popover on desktop). Float output, every
      // move streams through onChange; a vec4 gets an alpha slider. The hex in
      // the value column is a label only (no 8-bit round-trip).
      const label = (v: readonly number[]): string => toHex(v, s.uniform.width >= 4 ? (v[3] ?? 1) : undefined);
      const swatch = ColorSwatch({
        value: s.value,
        alpha: s.uniform.width >= 4,
        title: this.label(s.uniform.name),
        onInput: (v) => {
          const next = clampUniformValue(s.uniform, v);
          this.set(i, next);
          value.textContent = value.title = label(next);
        },
        onCommit: (v) => this.opts.onCommit?.(s.uniform.slot, clampUniformValue(s.uniform, v)),
      });
      ctrl.appendChild(swatch.el);
      value.textContent = value.title = label(s.value);
      value.classList.add("upanel-hex");
      this.setters.set(s.uniform.slot, (v) => {
        swatch.set(v);
        value.textContent = value.title = label(v);
      });
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

    if (ui.kind === "vector" || ui.kind === "direction") {
      // The XY pad (+ z slider) / direction dial or sphere (D-541 PR 4): a
      // button opening the picker (a Sheet on phones, a popover on desktop).
      // Every move streams through onChange; the release commits.
      const dims: 2 | 3 = s.uniform.width >= 3 ? 3 : 2;
      const mode = ui.kind;
      const ranges = componentRanges(s.uniform) ?? undefined;
      const summary = (v: readonly number[]): string => vectorSummary(v, dims, mode);
      const pad = VectorSwatch({
        value: s.value,
        dims,
        mode,
        ...(ranges ? { ranges } : {}),
        step: ui.kind === "vector" ? ui.step : 0,
        title: this.label(s.uniform.name),
        onInput: (v) => {
          const next = clampUniformValue(s.uniform, v);
          this.set(i, next);
          value.textContent = value.title = summary(next);
        },
        onCommit: (v) => this.opts.onCommit?.(s.uniform.slot, clampUniformValue(s.uniform, v)),
      });
      ctrl.appendChild(pad.el);
      value.textContent = value.title = summary(s.value);
      // External drivers (MIDI, the agent) move the button and an open picker.
      this.setters.set(s.uniform.slot, (v) => {
        pad.set(v);
        value.textContent = value.title = summary(v);
      });
      return;
    }

    // slider + an editable number field (type a value → clamp+snap to range).
    const move = this.sliderPair(
      ctrl,
      value,
      ui.min,
      ui.max,
      ui.step,
      () => this.slots[i]?.value[0] ?? ui.min,
      (v) => this.set(i, [v]),
      () => this.commitSlot(i),
    );
    // External (MIDI) driver moves both the slider and the number field.
    this.setters.set(s.uniform.slot, (v) => move(v[0] ?? ui.min));
  }
}

const COMPONENT = ["x", "y", "z", "w"];

/** Compact numeric label (up to 4 decimals, trailing zeros trimmed). */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 1e4) / 1e4);
}
