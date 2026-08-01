/**
 * Settings ▸ MIDI (FUG-9) — the hardware + semantic-naming surface. Here the
 * user enables Web MIDI, sees connected devices, and NAMES physical controls:
 * wiggle a knob, type "speed", assign. Those semantic names are global, so any
 * effect with a matching uniform can bind to them (the per-effect binding UI
 * lives in the effect editor's Uniforms pane).
 *
 * All hardware access goes through the shared {@link midiManager}; the naming
 * table is {@link midiStore}. Self-contained injected CSS (CJS-safe, mirroring
 * settings.css.ts). Degrades gracefully when Web MIDI is unsupported.
 */

import { Button, icon } from "../kit";
import type { Router, Screen } from "../app/router";
import {
  midiManager,
  midiSupported,
  controlKey,
  controlLabel,
  type MidiControlEvent,
  type MidiDeviceInfo,
} from "../../midi/manager";
import { midiStore, type SemanticControl } from "../../store/midiStore";

export function MidiScreen(_router: Router): Screen {
  installMidiStyles();
  const el = document.createElement("div");
  el.className = "screen screen--midi";

  const head = document.createElement("h1");
  head.className = "screen-headline";
  head.textContent = "MIDI controllers";
  const sub = document.createElement("p");
  sub.className = "screen-sub";
  sub.textContent =
    "Connect a controller and name its knobs/pads. Named controls (e.g. “speed”) can drive any effect uniform — map them per effect in the editor.";
  el.append(head, sub);

  const body = document.createElement("div");
  el.appendChild(body);

  // -- live wiring --------------------------------------------------------
  let lastControl: MidiControlEvent | null = midiManager.lastControl;
  // Live value per control key, for the meters.
  const liveValues = new Map<string, number>();
  const unsubs: (() => void)[] = [];

  // -- enable / device list -----------------------------------------------
  function enableSection(): HTMLElement {
    const g = group("Connection");
    if (!midiSupported()) {
      const warn = document.createElement("p");
      warn.className = "midi-warn";
      warn.textContent =
        "Web MIDI isn’t available in this browser. Try Chrome/Edge on desktop or Android.";
      g.appendChild(warn);
      return g;
    }
    if (!midiManager.enabled) {
      const p = document.createElement("p");
      p.className = "midi-hint";
      p.textContent = "MIDI access is off. Enable it to connect controllers.";
      const btn = Button({
        label: "Enable MIDI",
        icon: "link",
        onClick: async () => {
          const ok = await midiManager.enable();
          if (!ok) toastLike(g, "MIDI access denied or unavailable.");
          rerender();
        },
      });
      g.append(p, btn);
      return g;
    }
    const devices = midiManager.devices();
    const list = document.createElement("div");
    list.className = "midi-devices";
    if (devices.length === 0) {
      const p = document.createElement("p");
      p.className = "midi-hint";
      p.textContent = "MIDI enabled — no input devices detected. Plug one in.";
      list.appendChild(p);
    } else {
      for (const d of devices) list.appendChild(deviceRow(d));
    }
    g.appendChild(list);
    return g;
  }

  function deviceRow(d: MidiDeviceInfo): HTMLElement {
    const row = document.createElement("div");
    row.className = "midi-device";
    const dot = document.createElement("span");
    dot.className = "midi-dot";
    const name = document.createElement("span");
    name.className = "midi-device-name";
    name.textContent = d.name;
    row.append(dot, name);
    return row;
  }

  // -- learn / assign -----------------------------------------------------
  function learnSection(): HTMLElement {
    const g = group("Name a control");
    if (!midiManager.enabled) {
      const p = document.createElement("p");
      p.className = "midi-hint";
      p.textContent = "Enable MIDI above to start naming controls.";
      g.appendChild(p);
      return g;
    }
    const p = document.createElement("p");
    p.className = "midi-hint";
    p.textContent = "Move a knob, fader, or pad — it appears below — then give it a name.";

    const captured = document.createElement("div");
    captured.className = "midi-captured";
    const capLabel = document.createElement("span");
    capLabel.className = "midi-captured-label";
    const nameInput = document.createElement("input");
    nameInput.className = "midi-name-input";
    nameInput.placeholder = "e.g. speed";
    nameInput.autocapitalize = "off";
    nameInput.spellcheck = false;
    const assign = Button({
      label: "Assign",
      icon: "plus",
      onClick: () => doAssign(),
    });

    function refreshCaptured(): void {
      if (lastControl) {
        capLabel.textContent = `${lastControl.control.device} · ${controlLabel(lastControl.control)}`;
        nameInput.disabled = false;
        (assign as HTMLButtonElement).disabled = false;
      } else {
        capLabel.textContent = "— waiting for a control —";
        nameInput.disabled = true;
        (assign as HTMLButtonElement).disabled = true;
      }
    }
    function doAssign(): void {
      if (!lastControl) return;
      const nm = nameInput.value.trim();
      if (!nm) {
        nameInput.focus();
        return;
      }
      midiStore.assignSemantic(lastControl.control, nm);
      nameInput.value = "";
      rerender();
    }
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doAssign();
      }
    });
    refreshCaptured();
    // Keep this section's captured chip live without a full rerender (which
    // would blow away the input the user is typing into).
    capturedRefreshers.push(refreshCaptured);

    captured.append(capLabel, nameInput, assign);
    g.append(p, captured);
    return g;
  }

  // -- named controls table -----------------------------------------------
  function namedSection(): HTMLElement {
    const g = group("Named controls");
    const semantics = midiStore.semantics();
    if (semantics.length === 0) {
      const p = document.createElement("p");
      p.className = "midi-hint";
      p.textContent = "No named controls yet.";
      g.appendChild(p);
      return g;
    }
    for (const s of semantics) g.appendChild(semanticRow(s));
    return g;
  }

  function semanticRow(s: SemanticControl): HTMLElement {
    const row = document.createElement("div");
    row.className = "midi-sem";

    const nameEl = document.createElement("span");
    nameEl.className = "midi-sem-name";
    nameEl.textContent = s.name;

    const src = document.createElement("span");
    src.className = "midi-sem-src";
    src.textContent = `${s.control.device} · ${controlLabel(s.control)}`;

    // Live meter reflecting the control's most recent value.
    const meter = document.createElement("div");
    meter.className = "midi-meter";
    const fill = document.createElement("div");
    fill.className = "midi-meter-fill";
    fill.style.width = `${Math.round((liveValues.get(s.id) ?? 0) * 100)}%`;
    meter.appendChild(fill);
    meterFills.set(s.id, fill);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "midi-icon-btn";
    del.title = "Remove";
    del.setAttribute("aria-label", `Remove ${s.name}`);
    del.append(icon("trash"));
    del.addEventListener("click", () => {
      midiStore.removeSemantic(s.id);
      rerender();
    });

    const info = document.createElement("div");
    info.className = "midi-sem-info";
    info.append(nameEl, src);
    row.append(info, meter, del);
    return row;
  }

  // -- render orchestration -----------------------------------------------
  // Meters + captured chip update on every control event WITHOUT a rerender;
  // these registries are rebuilt each rerender.
  let meterFills = new Map<string, HTMLElement>();
  let capturedRefreshers: (() => void)[] = [];

  function rerender(): void {
    meterFills = new Map();
    capturedRefreshers = [];
    body.replaceChildren(enableSection(), learnSection(), namedSection());
  }

  function onControl(e: MidiControlEvent): void {
    lastControl = e;
    liveValues.set(controlKey(e.control), e.value);
    const fill = meterFills.get(controlKey(e.control));
    if (fill) fill.style.width = `${Math.round(e.value * 100)}%`;
    for (const fn of capturedRefreshers) fn();
  }

  return {
    el,
    onMount: () => {
      rerender();
      unsubs.push(midiManager.onControl(onControl));
      unsubs.push(midiManager.onDevices(() => rerender()));
      unsubs.push(midiStore.subscribe(() => rerender()));
    },
    onUnmount: () => {
      for (const u of unsubs) u();
      unsubs.length = 0;
    },
  };
}

// -- small local helpers -----------------------------------------------------

function group(legend: string): HTMLElement {
  const g = document.createElement("section");
  g.className = "midi-group";
  const l = document.createElement("h2");
  l.className = "midi-legend";
  l.textContent = legend;
  g.appendChild(l);
  return g;
}

/** A tiny inline notice (avoids importing the global toast for a local error). */
function toastLike(host: HTMLElement, text: string): void {
  const n = document.createElement("p");
  n.className = "midi-warn";
  n.textContent = text;
  host.appendChild(n);
}

let installed = false;
export function installMidiStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--midi .midi-group { margin-bottom: var(--sp-4); }
.midi-legend {
  font-size: var(--f-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin: 0 0 var(--sp-2);
}
.midi-hint { color: var(--text-dim); font-size: var(--f-caption); margin: 0 0 var(--sp-2); }
.midi-warn { color: var(--danger, #e06666); font-size: var(--f-caption); margin: var(--sp-2) 0 0; }
.midi-devices { display: flex; flex-direction: column; gap: var(--sp-1); }
.midi-device { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0; }
.midi-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
.midi-device-name { font-weight: 600; }

.midi-captured {
  display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
  padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius-2, 8px);
}
.midi-captured-label { font-family: var(--font-mono, monospace); color: var(--text-dim); flex: 1 1 auto; min-width: 0; }
.midi-name-input {
  flex: 0 1 12ch; background: var(--surface-2, #1a1a22); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-1, 6px); padding: var(--sp-1) var(--sp-2);
}

.midi-sem {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.midi-sem + .midi-sem { border-top: 1px solid var(--border); }
.midi-sem-info { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.midi-sem-name { font-weight: 600; }
.midi-sem-src { color: var(--text-dim); font-size: var(--f-caption); font-family: var(--font-mono, monospace); }
.midi-meter {
  flex: 0 0 80px; height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--surface-2, #1a1a22);
}
.midi-meter-fill { height: 100%; background: var(--accent); width: 0; transition: width 60ms linear; }
.midi-icon-btn {
  flex: 0 0 auto; background: none; border: none; color: var(--text-dim);
  cursor: pointer; padding: var(--sp-1); border-radius: var(--radius-1, 6px);
}
.midi-icon-btn:hover { color: var(--text); background: var(--surface-2, #1a1a22); }
`;
