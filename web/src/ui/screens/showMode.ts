/**
 * Show Mode (FUG-110) — the live performance workspace. Cue two effects onto
 * left/right FX decks (A/B) and crossfade between them on the device, which runs
 * both decks concurrently and blends their per-LED output. Every transport
 * control (crossfade, play/pause, blend mode, list navigation, cue) is
 * MIDI-mappable via the existing Web-MIDI layer.
 *
 * The device is the render engine; this screen is the controller:
 *   - cueing an effect compiles it to .fxb and submit_effect(deck=A|B),
 *   - the crossfader pushes set_crossfade(position, mode),
 *   - play/pause is set_effect("", deck) / set_effect(id, deck).
 */

import { Button, IconButton, Sheet, EmptyState, toast, icon } from "../kit";
import { effectStore, type StoredEffect } from "../../store/effectStore";
import { deviceEffects } from "../../store/deviceEffects";
import { deviceStore } from "../../store/deviceStore";
import { midiStore } from "../../store/midiStore";
import { midiManager, midiSupported, controlLabel, type MidiControlEvent } from "../../midi/manager";
import {
  SHOW_ACTIONS,
  resolveShowAction,
  showActionKind,
  type ShowAction,
} from "../../midi/showRouter";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { appState } from "../app/state";
import type { Router, Screen } from "../app/router";

interface DeckState {
  effectId: string | null;
  name: string;
  playing: boolean;
}

export function ShowModeScreen(_router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen show-screen";

  const compiler = new FxCompilerWorker();

  const decks: [DeckState, DeckState] = [
    { effectId: null, name: "", playing: false },
    { effectId: null, name: "", playing: false },
  ];
  let library: StoredEffect[] = [];
  let focusIndex = 0;
  let crossfade = 0; // 0..1 (0 = all A, 1 = all B)
  let mode = 0; // 0 = linear RGB, 1 = linear HSV

  // -- device push helpers --------------------------------------------------

  function connected(): boolean {
    return appState.client?.isConnected === true;
  }

  let xfTimer = 0;
  function pushCrossfade(): void {
    window.clearTimeout(xfTimer);
    xfTimer = window.setTimeout(() => {
      const c = appState.client;
      if (c?.isConnected) void c.setCrossfade(crossfade, mode).catch(() => undefined);
    }, 40); // coalesce a fast fader drag into ~25 Hz of frames
  }

  async function cueDeck(deck: 0 | 1, e: StoredEffect): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) {
      toast("Connect a device first", { error: true });
      return;
    }
    const r = await compiler.compile(e.source);
    if (!r.ok) {
      toast(`"${e.name}" has compile errors`, { error: true });
      return;
    }
    try {
      await c.submitEffect(e.id, r.bytecode, true, deck);
      deviceEffects.markSent(deviceStore.activeId(), e.id);
      decks[deck] = { effectId: e.id, name: e.name, playing: true };
      toast(`Cued "${e.name}" → Deck ${deck === 0 ? "A" : "B"}`);
      render();
    } catch (err) {
      toast(`Cue failed: ${String(err)}`, { error: true });
    }
  }

  function playPauseDeck(deck: 0 | 1): void {
    const d = decks[deck];
    if (!d.effectId) return;
    d.playing = !d.playing;
    const c = appState.client;
    if (c?.isConnected) {
      // "" parks the deck (keeps the other running); the id re-activates it.
      void c.setEffect(d.playing ? d.effectId : "", deck).catch(() => undefined);
    }
    render();
  }

  function setCrossfade(v: number): void {
    crossfade = Math.min(1, Math.max(0, v));
    fader.value = String(Math.round(crossfade * 100));
    xfReadout.textContent = crossfadeLabel();
    pushCrossfade();
  }

  function toggleMode(): void {
    mode = mode === 0 ? 1 : 0;
    modeBtn.querySelector("span")!.textContent = mode === 0 ? "RGB" : "HSV";
    pushCrossfade(); // mode rides the same set_crossfade
  }

  function crossfadeLabel(): string {
    const pct = Math.round(crossfade * 100);
    return pct === 0 ? "A" : pct === 100 ? "B" : `${100 - pct} / ${pct}`;
  }

  function moveFocus(delta: number): void {
    if (library.length === 0) return;
    focusIndex = (focusIndex + delta + library.length) % library.length;
    renderList();
    listEl.children[focusIndex]?.scrollIntoView({ block: "nearest" });
  }

  // -- MIDI dispatch --------------------------------------------------------

  // Last raw value per trigger action, for rising-edge (button press) detection.
  const lastTrigger = new Map<string, number>();

  function dispatchMidi(ev: MidiControlEvent): void {
    const resolved = resolveShowAction(ev, midiStore.showBindings());
    if (!resolved) return;
    const { action, value } = resolved;
    if (showActionKind(action) === "value") {
      if (action === "crossfade") setCrossfade(value);
      return;
    }
    // Trigger: fire once on the rising edge (press), not on release.
    const prev = lastTrigger.get(action) ?? 0;
    lastTrigger.set(action, value);
    if (!(prev < 0.5 && value >= 0.5)) return;
    switch (action) {
      case "crossfadeMode":
        toggleMode();
        break;
      case "deckA.playPause":
        playPauseDeck(0);
        break;
      case "deckB.playPause":
        playPauseDeck(1);
        break;
      case "list.prev":
        moveFocus(-1);
        break;
      case "list.next":
        moveFocus(1);
        break;
      case "deckA.cue":
        if (library[focusIndex]) void cueDeck(0, library[focusIndex]!);
        break;
      case "deckB.cue":
        if (library[focusIndex]) void cueDeck(1, library[focusIndex]!);
        break;
    }
  }

  // -- DOM ------------------------------------------------------------------

  const header = document.createElement("div");
  header.className = "show-header";
  const title = document.createElement("div");
  title.className = "show-title";
  title.textContent = "Show mode";
  const midiBtn = Button({ label: "MIDI map", icon: "midi", variant: "quiet", onClick: openMidiSheet });
  header.append(title, midiBtn);

  const offlineHint = document.createElement("div");
  offlineHint.className = "show-offline";
  offlineHint.textContent = "Not connected — cueing is disabled. Connect a device to run a show.";

  // Deck cards
  function deckCard(deck: 0 | 1): HTMLElement {
    const card = document.createElement("div");
    card.className = "show-deck";
    card.dataset["deck"] = String(deck);
    const label = document.createElement("div");
    label.className = "show-deck-label";
    label.textContent = `Deck ${deck === 0 ? "A" : "B"}`;
    const name = document.createElement("div");
    name.className = "show-deck-name";
    const d = decks[deck];
    name.textContent = d.effectId ? d.name : "— empty —";
    if (!d.effectId) name.classList.add("show-deck-name--empty");
    const controls = document.createElement("div");
    controls.className = "show-deck-controls";
    const pp = IconButton(d.playing ? "pause" : "play", {
      title: d.playing ? "Pause deck" : "Play deck",
    });
    pp.disabled = !d.effectId;
    pp.addEventListener("click", () => playPauseDeck(deck));
    const cue = Button({
      label: "Cue selected",
      icon: "effect-to-device",
      variant: "quiet",
      onClick: () => {
        if (library[focusIndex]) void cueDeck(deck, library[focusIndex]!);
      },
    });
    controls.append(pp, cue);
    card.append(label, name, controls);
    return card;
  }
  const decksRow = document.createElement("div");
  decksRow.className = "show-decks";

  // Crossfader
  const xfWrap = document.createElement("div");
  xfWrap.className = "show-xfader";
  const xfLabels = document.createElement("div");
  xfLabels.className = "show-xfader-labels";
  const aLbl = document.createElement("span");
  aLbl.textContent = "A";
  const xfReadout = document.createElement("span");
  xfReadout.className = "show-xfader-readout metric";
  xfReadout.textContent = crossfadeLabel();
  const bLbl = document.createElement("span");
  bLbl.textContent = "B";
  xfLabels.append(aLbl, xfReadout, bLbl);
  const fader = document.createElement("input");
  fader.type = "range";
  fader.min = "0";
  fader.max = "100";
  fader.step = "1";
  fader.value = "0";
  fader.className = "show-xfader-input";
  fader.setAttribute("aria-label", "Crossfade A to B");
  fader.addEventListener("input", () => setCrossfade(Number(fader.value) / 100));
  const modeBtn = Button({ label: "RGB", variant: "quiet", onClick: toggleMode });
  modeBtn.classList.add("show-mode-btn");
  modeBtn.title = "Blend colour space: linear RGB vs linear HSV";
  xfWrap.append(xfLabels, fader, modeBtn);

  // Effect picker list
  const listWrap = document.createElement("div");
  listWrap.className = "show-list-wrap";
  const listHead = document.createElement("div");
  listHead.className = "show-list-head";
  listHead.textContent = "Effects";
  const listEl = document.createElement("div");
  listEl.className = "show-list";

  function renderList(): void {
    listEl.replaceChildren();
    if (library.length === 0) {
      listEl.append(EmptyState({ icon: "sparkles", title: "No effects in your library yet" }));
      return;
    }
    library.forEach((e, i) => {
      const r = document.createElement("div");
      r.className = "show-row";
      if (i === focusIndex) r.classList.add("show-row--focus");
      const nm = document.createElement("span");
      nm.className = "show-row-name";
      nm.textContent = e.name;
      const cueA = IconButton("effect-to-device", { title: "Cue → Deck A" });
      cueA.classList.add("show-cue-a");
      cueA.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void cueDeck(0, e);
      });
      const cueB = IconButton("effect-to-device", { title: "Cue → Deck B" });
      cueB.classList.add("show-cue-b");
      cueB.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void cueDeck(1, e);
      });
      r.addEventListener("click", () => {
        focusIndex = i;
        renderList();
      });
      r.append(nm, cueA, cueB);
      listEl.append(r);
    });
  }
  listWrap.append(listHead, listEl);

  function render(): void {
    offlineHint.style.display = connected() ? "none" : "";
    decksRow.replaceChildren(deckCard(0), deckCard(1));
  }

  el.append(header, offlineHint, decksRow, xfWrap, listWrap);

  // -- MIDI mapping sheet ---------------------------------------------------

  function openMidiSheet(): void {
    // Teardown for the learn listener; runs on EVERY close path (scrim/✕/prog)
    // via the Sheet's onClose hook.
    let unsub: () => void = () => {};
    const sheet = Sheet("MIDI mapping — Show mode", { onClose: () => unsub() });
    const body = sheet.body;
    if (!midiSupported()) {
      const p = document.createElement("p");
      p.className = "sheet-hint";
      p.textContent = "This browser has no Web MIDI support.";
      body.append(p);
      return;
    }

    let listening: string | null = null; // action id awaiting a control wiggle
    const rows = new Map<string, HTMLElement>();

    // While the sheet is open, capture the next control for the learning action.
    unsub = midiManager.onControl((ev) => {
      if (listening === null) return;
      midiStore.setShowBinding(listening, ev.control);
      listening = null;
      rebuild();
    });

    async function ensureEnabled(): Promise<void> {
      if (!midiManager.enabled) await midiManager.enable();
      rebuild();
    }

    function rebuild(): void {
      body.replaceChildren();
      if (!midiManager.enabled) {
        body.append(
          Button({
            label: "Enable MIDI",
            icon: "midi",
            block: true,
            onClick: () => void ensureEnabled(),
          }),
        );
        return;
      }
      const hint = document.createElement("p");
      hint.className = "sheet-hint";
      hint.textContent = listening
        ? "Move a control to bind it…"
        : "Tap an action, then move the knob/button to bind it.";
      body.append(hint);
      rows.clear();
      for (const a of SHOW_ACTIONS) {
        body.append(actionRow(a));
      }
    }

    function actionRow(a: ShowAction): HTMLElement {
      const row = document.createElement("div");
      row.className = "show-midi-row";
      if (listening === a.id) row.classList.add("show-midi-row--learn");
      const label = document.createElement("div");
      label.className = "show-midi-label";
      label.textContent = a.label;
      const bound = midiStore.showBindingFor(a.id);
      const val = document.createElement("div");
      val.className = "show-midi-val metric";
      val.textContent = bound ? controlLabel(bound) : listening === a.id ? "waiting…" : "unmapped";
      const learn = Button({
        label: listening === a.id ? "…" : bound ? "Rebind" : "Learn",
        variant: "quiet",
        onClick: () => {
          listening = listening === a.id ? null : a.id;
          rebuild();
        },
      });
      const clear = IconButton("close", { title: "Clear mapping" });
      clear.disabled = !bound;
      clear.addEventListener("click", () => {
        midiStore.clearShowBinding(a.id);
        rebuild();
      });
      row.append(label, val, learn, clear);
      rows.set(a.id, row);
      return row;
    }

    rebuild();
  }

  // -- lifecycle ------------------------------------------------------------

  let midiUnsub: (() => void) | null = null;
  let stateUnsub: (() => void) | null = null;

  async function loadLibrary(): Promise<void> {
    library = await effectStore.list({ sort: "updated" });
    if (focusIndex >= library.length) focusIndex = 0;
    renderList();
  }

  return {
    el,
    onMount: () => {
      render();
      void loadLibrary();
      // Route hardware MIDI into the show transport (no permission prompt here —
      // it only receives if MIDI was already enabled from the MIDI settings).
      if (midiManager.enabled) midiUnsub = midiManager.onControl(dispatchMidi);
      else if (midiSupported()) {
        // Enable lazily so a controller works without visiting Settings first.
        void midiManager.enable().then((ok) => {
          if (ok) midiUnsub = midiManager.onControl(dispatchMidi);
        });
      }
      stateUnsub = appState.subscribe(() => render());
    },
    onUnmount: () => {
      midiUnsub?.();
      midiUnsub = null;
      stateUnsub?.();
      stateUnsub = null;
      window.clearTimeout(xfTimer);
      compiler.dispose();
    },
  };
}
