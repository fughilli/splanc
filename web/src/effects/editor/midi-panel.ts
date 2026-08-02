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
 */

import type { FxUniform } from "../../fx/preview";
import {
  midiManager,
  midiSupported,
  controlKey,
  controlLabel,
  type MidiControlEvent,
} from "../../midi/manager";
import { midiStore } from "../../store/midiStore";
import { isDrivable } from "../../midi/router";
import { installMidiStyles } from "../../ui/screens/midi";

export interface MidiMapPanelOpts {
  /** Fire the canned AI remap prompt (editor drives the chat turn). */
  onRemap: () => void;
}

export class MidiMapPanel {
  readonly node: HTMLElement;
  private manifest: FxUniform[] = [];
  private learnUniform: string | null = null;
  private readonly unsubs: (() => void)[] = [];
  // Live value per control key (for meters) + meter fills keyed by the SAME
  // control key so a control event maps straight to its meter(s).
  private readonly liveValues = new Map<string, number>();
  private meterFills = new Map<string, HTMLElement[]>();
  private meterRaf = 0;

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
    this.manifest = uniforms.filter(isDrivable);
    this.render();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.meterRaf !== 0) cancelAnimationFrame(this.meterRaf);
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
    midiStore.setBinding(this.effectId, { uniform, semantic: name });
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
    const remap = document.createElement("button");
    remap.type = "button";
    remap.className = "midimap-remap";
    remap.textContent = "✨ Remap";
    remap.title = "Let the AI map MIDI controls to these uniforms";
    remap.addEventListener("click", () => this.opts.onRemap());
    header.append(title, remap);
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
      this.node.appendChild(hint("Compile an effect with slider/toggle uniforms to map them."));
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

    const foot = hint("Name controls globally in Settings ▸ MIDI; bindings here are per-effect.");
    this.node.appendChild(foot);
  }

  private row(u: FxUniform): HTMLElement {
    const row = document.createElement("div");
    row.className = "midimap-row";

    const name = document.createElement("span");
    name.className = "midimap-uname";
    name.textContent = u.name;
    name.title = u.name;

    const binding = midiStore.bindingFor(this.effectId, u.name);

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
      if (sel.value === "") midiStore.clearBinding(this.effectId, u.name);
      else midiStore.setBinding(this.effectId, { uniform: u.name, semantic: sel.value });
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
  background: var(--accent); color: var(--on-accent, #fff); border: none; cursor: pointer;
  border-radius: var(--radius-1, 6px); padding: var(--sp-1) var(--sp-2); font-weight: 600;
}
.midimap-remap:hover { filter: brightness(1.08); }
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
