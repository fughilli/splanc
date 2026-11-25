/**
 * Editor MIDI-mapping pane (FUG-9). Lists the current effect's drivable uniforms
 * and lets the user bind each to a MIDI control — WITHOUT touching the effect
 * source. Two ways to bind:
 *   • pick an already-named ("semantic") control from the dropdown, or
 *   • hit Learn and wiggle a knob: if that knob is already named we bind to it,
 *     otherwise we auto-name it after the uniform (so "learn on the speed row"
 *     names the knob "speed" globally and binds it).
 *
 * A ✨ Remap button hands the whole job to the AI (canned prompt, editor-owned).
 * Bindings live in {@link midiStore}, keyed by effectId + uniform NAME, so they
 * survive recompiles and code edits. The pane also shows a live meter per bound
 * uniform. All hardware access is the shared {@link midiManager}.
 *
 * Colour uniforms get a row too, binding one knob to HUE (S and V stay where
 * they are). Richer colour/vector mappings (three knobs as H/S/V, RGB, vector
 * components) come from ✨ Remap and are listed under the rows.
 */

import type { FxUniform } from "../../fx/preview";
import {
  midiManager,
  midiSupported,
  controlKey,
  controlLabel,
  type MidiControlEvent,
} from "../../midi/manager";
import { midiStore, sameTarget, type UniformBinding } from "../../store/midiStore";
import { isAutoBindable, isColorUniform } from "../../midi/router";
import { installMidiStyles } from "../../ui/screens/midi";

export interface MidiMapPanelOpts {
  /** Fire the canned AI remap prompt (editor drives the chat turn). The panel
   * awaits the returned promise to animate the button while the turn runs. */
  onRemap: () => void | Promise<void>;
}

export class MidiMapPanel {
  readonly node: HTMLElement;
  private manifest: FxUniform[] = [];
  /** Vector / matrix uniforms: no row, but their channel bindings are listed. */
  private channelUniforms: FxUniform[] = [];
  private learnUniform: string | null = null;
  private readonly unsubs: (() => void)[] = [];
  // Live value per control key (for meters) + meter fills keyed by the SAME
  // control key so a control event maps straight to its meter(s).
  private readonly liveValues = new Map<string, number>();
  private meterFills = new Map<string, HTMLElement[]>();
  private meterRaf = 0;
  // Remap button feedback (FUG-51). Held on the instance so the working/done
  // state survives the re-renders that fire mid-turn when the AI applies
  // mappings (midiStore change → render()).
  private remapState: "idle" | "working" | "done" = "idle";
  private remapDoneTimer = 0;

  constructor(
    private readonly effectId: string,
    private readonly opts: MidiMapPanelOpts,
  ) {
    installMidiStyles();
    installPanelStyles();
    this.node = document.createElement("div");
    this.node.className = "midimap";
    this.unsubs.push(midiManager.onControl((e) => this.onControl(e)));
    this.unsubs.push(midiManager.onDevices(() => this.render()));
    this.unsubs.push(midiStore.subscribe(() => this.render()));
    this.render();
  }

  /** Update the drivable-uniform list (called on each successful compile). */
  setManifest(uniforms: FxUniform[]): void {
    this.manifest = uniforms.filter(isAutoBindable);
    this.channelUniforms = uniforms.filter((u) => !isAutoBindable(u));
    this.render();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.meterRaf !== 0) cancelAnimationFrame(this.meterRaf);
    if (this.remapDoneTimer !== 0) clearTimeout(this.remapDoneTimer);
  }

  // -- events -------------------------------------------------------------
  private onControl(e: MidiControlEvent): void {
    const key = controlKey(e.control);
    this.liveValues.set(key, e.value);

    if (this.learnUniform !== null) {
      this.bindLearned(this.learnUniform, e);
      this.learnUniform = null;
      this.render();
      return;
    }
    // Coalesce meter writes to one animation frame — controllers emit faster
    // than the display refreshes, and a per-event `width` write (a layout) is
    // what stuttered. Batching to rAF tracks smoothly, like the preview.
    this.scheduleMeterFlush();
  }

  private scheduleMeterFlush(): void {
    if (this.meterRaf !== 0) return;
    this.meterRaf = requestAnimationFrame(() => {
      this.meterRaf = 0;
      for (const [key, fills] of this.meterFills) {
        const w = `${Math.round((this.liveValues.get(key) ?? 0) * 100)}%`;
        for (const fill of fills) fill.style.width = w;
      }
    });
  }

  /** Learn: bind `uniform` to the moved control, naming it if needed. */
  private bindLearned(uniform: string, e: MidiControlEvent): void {
    const existing = midiStore.semantics().find((s) => s.id === controlKey(e.control));
    const name = existing?.name ?? uniform;
    if (!existing) midiStore.assignSemantic(e.control, name);
    const u = this.manifest.find((m) => m.name === uniform);
    this.bindRow(uniform, u !== undefined && isColorUniform(u), name);
  }

  /** The binding a row shows: the scalar binding, or a colour's hue binding
   * (explicit `h`, or none = hue). */
  private rowBinding(u: FxUniform): UniformBinding | undefined {
    const list = midiStore.bindingsFor(this.effectId, u.name);
    if (!isColorUniform(u)) return list[0];
    return list.find((b) => b.channel === undefined || b.channel === "h");
  }

  /** Bind (or, with `semantic` null, unbind) a row's knob. A colour row's knob
   * drives hue; other colour channels are left alone. */
  private bindRow(uniform: string, color: boolean, semantic: string | null): void {
    if (!color) {
      if (semantic === null) midiStore.clearBinding(this.effectId, uniform);
      else midiStore.setBinding(this.effectId, { uniform, semantic });
      return;
    }
    midiStore.clearBinding(this.effectId, uniform, "");
    if (semantic === null) midiStore.clearBinding(this.effectId, uniform, "h");
    else midiStore.setBinding(this.effectId, { uniform, semantic, channel: "h", space: "hsv" });
  }

  // -- remap button (FUG-51) ---------------------------------------------
  /** Build the ✨ Remap button in its current state: idle, a spinner+"Remapping…"
   * while the AI turn runs, or a brief "✓ Mapped" flash once it finishes. */
  private remapButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "midimap-remap";
    if (this.remapState === "working") {
      btn.classList.add("working");
      btn.disabled = true;
      btn.title = "The AI is mapping your MIDI controls…";
      const spin = document.createElement("span");
      spin.className = "midimap-remap-spinner";
      const label = document.createElement("span");
      label.textContent = "Remapping…";
      btn.append(spin, label);
    } else if (this.remapState === "done") {
      btn.classList.add("done");
      btn.textContent = "✓ Mapped";
      btn.title = "The AI finished mapping your MIDI controls";
      btn.addEventListener("click", () => void this.runRemapAnimated());
    } else {
      btn.textContent = "✨ Remap";
      btn.title = "Let the AI map MIDI controls to these uniforms";
      btn.addEventListener("click", () => void this.runRemapAnimated());
    }
    return btn;
  }

  /** Drive the remap turn while reflecting its progress on the button: spin
   * until the editor's turn settles, then flash "done" for a moment. */
  private async runRemapAnimated(): Promise<void> {
    if (this.remapState === "working") return;
    if (this.remapDoneTimer !== 0) {
      clearTimeout(this.remapDoneTimer);
      this.remapDoneTimer = 0;
    }
    this.remapState = "working";
    this.render();
    try {
      await this.opts.onRemap();
    } finally {
      // The editor swallows AI errors (they surface in the chat pane); reaching
      // here just means the turn is over — the "done" flash is the completion cue.
      this.remapState = "done";
      this.render();
      this.remapDoneTimer = window.setTimeout(() => {
        this.remapDoneTimer = 0;
        this.remapState = "idle";
        this.render();
      }, 1600);
    }
  }

  // -- render -------------------------------------------------------------
  private render(): void {
    this.meterFills = new Map<string, HTMLElement[]>();
    this.node.replaceChildren();

    // Header: title + Remap.
    const header = document.createElement("div");
    header.className = "midimap-header";
    const title = document.createElement("span");
    title.className = "midimap-title";
    title.textContent = "MIDI mappings";
    header.append(title, this.remapButton());
    this.node.appendChild(header);

    if (!midiSupported()) {
      this.node.appendChild(hint("Web MIDI isn’t available in this browser."));
      return;
    }
    if (!midiManager.enabled) {
      const p = hint("Enable MIDI to bind these controls to your hardware.");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "midimap-enable";
      btn.textContent = "Enable MIDI";
      btn.addEventListener("click", async () => {
        await midiManager.enable();
        this.render();
      });
      this.node.append(p, btn);
      // Still show the rows so bindings can be configured before enabling.
    }

    if (this.manifest.length === 0) {
      this.node.appendChild(hint("Compile an effect with slider, toggle or colour uniforms to map them."));
      return;
    }

    const status = document.createElement("p");
    status.className = "midi-hint";
    status.textContent =
      this.learnUniform !== null
        ? `Move a control to bind “${this.learnUniform}”…`
        : "Bind a knob per uniform. Named controls are shared across effects.";
    this.node.appendChild(status);

    const grid = document.createElement("div");
    grid.className = "midimap-grid";
    for (const u of this.manifest) grid.appendChild(this.row(u));
    this.node.appendChild(grid);

    // Per-channel colour/vector mappings that the rows don't show (e.g. three
    // knobs as H/S/V from ✨ Remap), one line per uniform.
    for (const u of [...this.manifest, ...this.channelUniforms]) {
      const shown = this.manifest.includes(u) ? this.rowBinding(u) : undefined;
      const extra = midiStore.bindingsFor(this.effectId, u.name).filter((b) => shown === undefined || !sameTarget(b, shown));
      if (extra.length === 0) continue;
      const parts = extra.map((b) => `${channelName(b.channel)} ← ${b.semantic}${fixedNote(b)}`);
      const line = hint(`${u.name}: ${parts.join(" · ")}`);
      line.classList.add("midimap-channels");
      this.node.appendChild(line);
    }

    const foot = hint("Name controls globally in Settings ▸ MIDI; bindings here are per-effect.");
    this.node.appendChild(foot);
  }

  private row(u: FxUniform): HTMLElement {
    const row = document.createElement("div");
    row.className = "midimap-row";

    const name = document.createElement("span");
    name.className = "midimap-uname";
    const color = isColorUniform(u);
    if (color) {
      // The uniform name may truncate; the "hue" tag never does.
      const nm = document.createElement("span");
      nm.className = "midimap-uname-text";
      nm.textContent = u.name;
      const tag = document.createElement("span");
      tag.className = "midimap-tag";
      tag.textContent = "hue";
      name.classList.add("midimap-uname--tagged");
      name.append(nm, tag);
      name.title = `${u.name}: a knob here drives the hue`;
    } else {
      name.textContent = u.name;
      name.title = u.name;
    }

    const binding = this.rowBinding(u);

    // Semantic picker: None + every named control.
    const sel = document.createElement("select");
    sel.className = "midimap-sel";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— none —";
    sel.appendChild(none);
    const semantics = midiStore.semantics();
    for (const s of semantics) {
      const o = document.createElement("option");
      o.value = s.name;
      o.textContent = s.name;
      sel.appendChild(o);
    }
    sel.value = binding?.semantic ?? "";
    // If bound to a semantic that no longer exists, show it as a stale option.
    if (binding && !semantics.some((s) => s.name === binding.semantic)) {
      const o = document.createElement("option");
      o.value = binding.semantic;
      o.textContent = `${binding.semantic} (missing)`;
      sel.appendChild(o);
      sel.value = binding.semantic;
    }
    sel.addEventListener("change", () => {
      this.bindRow(u.name, color, sel.value === "" ? null : sel.value);
      this.render();
    });

    // Learn button.
    const learn = document.createElement("button");
    learn.type = "button";
    learn.className = "midimap-learn" + (this.learnUniform === u.name ? " on" : "");
    learn.textContent = this.learnUniform === u.name ? "…" : "Learn";
    learn.title = "Wiggle a control to bind it";
    learn.addEventListener("click", async () => {
      await midiManager.enable();
      this.learnUniform = this.learnUniform === u.name ? null : u.name;
      this.render();
    });

    // Live meter (registered so onControl can move it).
    const meter = document.createElement("div");
    meter.className = "midi-meter midimap-meter";
    const fill = document.createElement("div");
    fill.className = "midi-meter-fill";
    if (binding) {
      const sem = midiStore.semanticByName(binding.semantic);
      const v = sem ? (this.liveValues.get(sem.id) ?? 0) : 0;
      fill.style.width = `${Math.round(v * 100)}%`;
      // Key meters by the control id so an event updates every row it drives.
      if (sem) {
        const list = this.meterFills.get(sem.id) ?? [];
        list.push(fill);
        this.meterFills.set(sem.id, list);
      }
    }
    meter.appendChild(fill);

    row.append(name, sel, learn, meter);
    return row;
  }
}

const CHANNEL_NAMES: Record<string, string> = {
  h: "hue",
  s: "saturation",
  v: "value",
  r: "red",
  g: "green",
  b: "blue",
  a: "alpha",
};

function channelName(ch: string | undefined): string {
  if (ch === undefined) return "hue";
  return CHANNEL_NAMES[ch] ?? (/^\d+$/.test(ch) ? `[${ch}]` : ch);
}

function fixedNote(b: UniformBinding): string {
  const f = b.fixed;
  if (!f) return "";
  const parts = [
    ...(f.s !== undefined ? [`S ${f.s.toFixed(2)}`] : []),
    ...(f.v !== undefined ? [`V ${f.v.toFixed(2)}`] : []),
  ];
  return parts.length ? ` (${parts.join(", ")} fixed)` : "";
}

function hint(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "midi-hint";
  p.textContent = text;
  return p;
}

let installed = false;
function installPanelStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.midimap { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2); }
.midimap-header { display: flex; align-items: center; justify-content: space-between; }
.midimap-title { font-weight: 600; }
.midimap-remap {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  background: var(--accent); color: var(--on-accent, #fff); border: none; cursor: pointer;
  border-radius: var(--radius-1, 6px); padding: var(--sp-1) var(--sp-2); font-weight: 600;
  transition: background 0.2s ease;
}
.midimap-remap:hover { filter: brightness(1.08); }
.midimap-remap.working { cursor: default; opacity: 0.9; }
.midimap-remap.done { background: var(--ok, #2ea043); }
.midimap-remap-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid rgba(255, 255, 255, 0.4); border-top-color: var(--on-accent, #fff);
  animation: midimap-remap-spin 0.7s linear infinite;
}
@keyframes midimap-remap-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .midimap-remap-spinner { animation: none; }
  .midimap-remap { transition: none; }
}
.midimap-enable {
  align-self: flex-start; background: var(--surface-2, #1a1a22); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-1, 6px);
  padding: var(--sp-1) var(--sp-2); cursor: pointer;
}
.midimap-grid { display: flex; flex-direction: column; gap: var(--sp-1); }
.midimap-row {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(8ch, 14ch) auto 64px;
  align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0;
}
.midimap-row + .midimap-row { border-top: 1px solid var(--border); }
.midimap-uname { font-family: var(--font-mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midimap-uname--tagged { display: flex; align-items: baseline; gap: var(--sp-1); }
.midimap-uname-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midimap-tag { flex: none; color: var(--text-dim); font-size: 0.85em; }
.midimap-sel {
  background: var(--surface-2, #1a1a22); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-1, 6px); padding: 2px var(--sp-1);
  min-width: 0;
}
.midimap-learn {
  background: none; color: var(--text-dim); border: 1px solid var(--border);
  border-radius: var(--radius-1, 6px); padding: 2px var(--sp-2); cursor: pointer;
}
.midimap-learn.on { color: var(--on-accent, #fff); background: var(--accent); border-color: var(--accent); }
.midimap-meter { flex: none; }
`;
