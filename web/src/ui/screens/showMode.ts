/**
 * Show Mode — the live performance workspace. Cue two effects onto left/right
 * FX decks (A/B) and crossfade between them on the device, which runs both decks
 * concurrently and blends their per-LED output. Each deck also carries its
 * effect's device-stored uniform keypoints (pads + a morph fader, blended in
 * parameter space on the device — docs/design/uniform-keypoints.md). Every
 * transport control (crossfade, play/pause, blend mode, list navigation, cue,
 * keypoint morph / step / save) is MIDI-mappable via the Web-MIDI layer.
 *
 * The device is the render engine; this screen is the controller:
 *   - cueing an effect compiles it to .fxb and submit_effect(deck=A|B),
 *   - the crossfader pushes set_crossfade(position, mode),
 *   - keypoint pads / the morph fader push blend_keypoints(deck, weights),
 *   - play/pause is set_effect("", deck) / set_effect(id, deck).
 *
 * The effects list is its own scroll container (it never scrolls the page) and
 * a keyboard listbox. A per-deck MIDI encoder moves its highlight — endless in
 * a relative encoder mode (midi/encoder.ts), so it scrolls indefinitely — and
 * the encoder's push loads the highlighted effect onto that deck: cue, or take
 * (load + crossfade to it). midi/twister.ts can set a Midi Fighter Twister up
 * for this over SysEx (twisterSetup.ts).
 */

import { Button, IconButton, Sheet, EmptyState, toast, icon } from "../kit";
import { effectStore, type StoredEffect } from "../../store/effectStore";
import { deviceEffects } from "../../store/deviceEffects";
import { deviceStore } from "../../store/deviceStore";
import { midiStore } from "../../store/midiStore";
import {
  midiManager,
  midiSupported,
  controlKey,
  controlLabel,
  type MidiControlEvent,
} from "../../midi/manager";
import {
  ENCODER_MODES,
  EncoderTracker,
  detectEncoderMode,
  isEncoderMode,
  type EncoderMode,
} from "../../midi/encoder";
import { listKeyAction, scrollTopToReveal, stepIndex } from "../../midi/listNav";
import { openTwisterSetup } from "./twisterSetup";
import {
  SHOW_ACTIONS,
  resolveShowAction,
  showActionKind,
  type ShowAction,
} from "../../midi/showRouter";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { KeypointStrip } from "./keypointStrip";
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
  // The deck whose encoder last moved the highlight (tints it; Enter loads there).
  let browseDeck: 0 | 1 = 0;
  const encoders = new EncoderTracker();

  // -- device push helpers --------------------------------------------------

  function connected(): boolean {
    return appState.client?.isConnected === true;
  }

  // Through the client's live-control channel: the last position wins and the
  // send rate follows the device (one update in flight, paced on its ack), so a
  // fast drag or a MIDI fader never queues up behind itself.
  function pushCrossfade(): void {
    appState.client?.sendCrossfade(crossfade, mode);
  }

  const strips = [0, 1].map((d) =>
    KeypointStrip({ deck: d as 0 | 1, client: () => appState.client }),
  ) as [ReturnType<typeof KeypointStrip>, ReturnType<typeof KeypointStrip>];

  async function cueDeck(deck: 0 | 1, e: StoredEffect): Promise<boolean> {
    const c = appState.client;
    if (!c?.isConnected) {
      toast("Connect a device first", { error: true });
      return false;
    }
    const r = await compiler.compile(e.source);
    if (!r.ok) {
      toast(`"${e.name}" has compile errors`, { error: true });
      return false;
    }
    try {
      await c.submitEffect(e.id, r.bytecode, true, deck);
      deviceEffects.markSent(deviceStore.activeId(), e.id);
      decks[deck] = { effectId: e.id, name: e.name, playing: true };
      toast(`Cued "${e.name}" → Deck ${deck === 0 ? "A" : "B"}`);
      render();
      void strips[deck].refresh(); // this effect's keypoints, off the device
      return true;
    } catch (err) {
      toast(`Cue failed: ${String(err)}`, { error: true });
      return false;
    }
  }

  // Crossfade animation for "take" (load + fade to the deck).
  let fadeRaf = 0;
  function fadeTo(target: number, seconds: number): void {
    cancelAnimationFrame(fadeRaf);
    const from = crossfade;
    if (seconds <= 0 || from === target) {
      setCrossfade(target);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - t0) / (seconds * 1000));
      // Smoothstep: eases in/out so the cut isn't felt at either end.
      const k = t * t * (3 - 2 * t);
      setCrossfade(from + (target - from) * k);
      if (t < 1) fadeRaf = requestAnimationFrame(tick);
    };
    fadeRaf = requestAnimationFrame(tick);
  }

  /** Load the highlighted effect onto `deck`: cue it, or (take) also
   * crossfade to that deck. */
  async function loadHighlighted(deck: 0 | 1): Promise<void> {
    const e = library[focusIndex];
    if (!e) return;
    const ok = await cueDeck(deck, e);
    if (!ok) return;
    const o = midiStore.showOptions();
    if (o.loadBehavior === "take") fadeTo(deck === 0 ? 0 : 1, o.takeSeconds);
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

  function setCrossfade(v: number, fromUser = false): void {
    if (fromUser) cancelAnimationFrame(fadeRaf);
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

  /** Move the highlight by `delta` rows (wrapping for the prev/next buttons,
   * stopping at the ends for encoders and keys). */
  function moveFocus(delta: number, wrap = true): void {
    if (library.length === 0 || delta === 0) return;
    setFocus(stepIndex(focusIndex, delta, library.length, wrap));
  }

  /** Highlight row `i` and scroll ONLY the list (never the page) to show it. */
  function setFocus(i: number): void {
    if (library.length === 0) return;
    const prev = rowEls[focusIndex];
    focusIndex = Math.min(Math.max(0, i), library.length - 1);
    const row = rowEls[focusIndex];
    if (prev && prev !== row) {
      prev.classList.remove("show-row--focus");
      prev.setAttribute("aria-selected", "false");
    }
    if (!row) return;
    row.classList.add("show-row--focus");
    row.setAttribute("aria-selected", "true");
    listEl.setAttribute("aria-activedescendant", row.id);
    listEl.dataset["browse"] = String(browseDeck);
    const top = scrollTopToReveal(
      { scrollTop: listEl.scrollTop, height: listEl.clientHeight },
      { top: row.offsetTop - listEl.offsetTop, height: row.offsetHeight },
      Math.round(row.offsetHeight / 2),
    );
    if (top !== null) listEl.scrollTop = top;
  }

  // -- MIDI dispatch --------------------------------------------------------

  // Last raw value per trigger action, for rising-edge (button press) detection.
  const lastTrigger = new Map<string, number>();

  function dispatchMidi(ev: MidiControlEvent): void {
    const resolved = resolveShowAction(ev, midiStore.showBindings());
    if (!resolved) return;
    const { action, value } = resolved;
    const kind = showActionKind(action);
    if (kind === "encoder") {
      const steps = encoders.delta(action, ev.raw, midiStore.showBindingMode(action));
      if (action === "deckA.browse") browseDeck = 0;
      else if (action === "deckB.browse") browseDeck = 1;
      moveFocus(steps, false);
      return;
    }
    if (kind === "value") {
      if (action === "crossfade") setCrossfade(value);
      else if (action === "deckA.morph") strips[0].setMorph(value);
      else if (action === "deckB.morph") strips[1].setMorph(value);
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
      case "deckA.load":
        browseDeck = 0;
        void loadHighlighted(0);
        break;
      case "deckB.load":
        browseDeck = 1;
        void loadHighlighted(1);
        break;
      case "deckA.cue":
        if (library[focusIndex]) void cueDeck(0, library[focusIndex]!);
        break;
      case "deckB.cue":
        if (library[focusIndex]) void cueDeck(1, library[focusIndex]!);
        break;
      case "deckA.kpNext":
        strips[0].step(1);
        break;
      case "deckA.kpPrev":
        strips[0].step(-1);
        break;
      case "deckB.kpNext":
        strips[1].step(1);
        break;
      case "deckB.kpPrev":
        strips[1].step(-1);
        break;
      case "deckA.kpSave":
        void strips[0].saveQuick();
        break;
      case "deckB.kpSave":
        void strips[1].saveQuick();
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
    card.append(label, name, controls, strips[deck].el);
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
  fader.addEventListener("input", () => setCrossfade(Number(fader.value) / 100, true));
  const modeBtn = Button({ label: "RGB", variant: "quiet", onClick: toggleMode });
  modeBtn.classList.add("show-mode-btn");
  modeBtn.title = "Blend colour space: linear RGB vs linear HSV";
  xfWrap.append(xfLabels, fader, modeBtn);

  // Effect picker list
  const listWrap = document.createElement("div");
  listWrap.className = "show-list-wrap";
  const listHead = document.createElement("div");
  listHead.className = "show-list-head";
  listHead.id = "show-list-head";
  const listTitle = document.createElement("span");
  listTitle.textContent = "Effects";
  const listCount = document.createElement("span");
  listCount.className = "show-list-count metric";
  listHead.append(listTitle, listCount);
  const listEl = document.createElement("div");
  listEl.className = "show-list";
  // A listbox: focusable, arrow keys move the highlight; aria-activedescendant
  // keeps keyboard focus on the list itself while the highlight moves.
  listEl.tabIndex = 0;
  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-labelledby", "show-list-head");
  listEl.addEventListener("keydown", (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const rowH = rowEls[0]?.offsetHeight || 40;
    const a = listKeyAction(ev.key, library.length, listEl.clientHeight / rowH - 1);
    if (!a) return;
    ev.preventDefault();
    if (a.kind === "move") moveFocus(a.steps, false);
    else if (a.kind === "jump") setFocus(a.index);
    else void loadHighlighted(a.deck === "browse" ? browseDeck : a.deck);
  });
  let rowEls: HTMLElement[] = [];

  function renderList(): void {
    listEl.replaceChildren();
    rowEls = [];
    listCount.textContent = library.length ? String(library.length) : "";
    if (library.length === 0) {
      listEl.append(EmptyState({ icon: "sparkles", title: "No effects in your library yet" }));
      return;
    }
    library.forEach((e, i) => {
      const r = document.createElement("div");
      r.className = "show-row";
      r.id = `show-row-${i}`;
      r.setAttribute("role", "option");
      r.setAttribute("aria-selected", String(i === focusIndex));
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
      cueA.tabIndex = -1;
      cueB.tabIndex = -1;
      r.addEventListener("click", () => setFocus(i));
      r.append(nm, cueA, cueB);
      listEl.append(r);
      rowEls.push(r);
    });
    listEl.dataset["browse"] = String(browseDeck);
    const row = rowEls[focusIndex];
    if (row) listEl.setAttribute("aria-activedescendant", row.id);
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
    let learnTimer: ReturnType<typeof setTimeout> | undefined;
    const sheet = Sheet("MIDI mapping — Show mode", {
      onClose: () => {
        unsub();
        clearTimeout(learnTimer);
      },
    });
    const body = sheet.body;
    if (!midiSupported()) {
      const p = document.createElement("p");
      p.className = "sheet-hint";
      p.textContent =
        "This browser has no Web MIDI support (iOS/iPadOS Safari has none). Use Chrome or Edge on a computer or Android.";
      body.append(p);
      return;
    }

    let listening: string | null = null; // action id awaiting a control wiggle
    // After an encoder action is learned, keep watching that control for a
    // moment to guess its encoding from the values it sends.
    let sampling: { action: string; key: string; raws: number[] } | null = null;
    const guesses = new Map<string, string>(); // action -> reason shown in the row

    unsub = midiManager.onControl((ev) => {
      if (sampling && controlKey(ev.control) === sampling.key) {
        sampling.raws.push(ev.raw);
        const g = detectEncoderMode(sampling.raws);
        if (g) {
          if (midiStore.showBindingMode(sampling.action) !== g.mode) {
            midiStore.setShowBindingMode(sampling.action, g.mode);
          }
          guesses.set(sampling.action, `Detected: ${g.reason}`);
          rebuild();
        }
        return;
      }
      if (listening === null) return;
      const action = listening;
      midiStore.setShowBinding(action, ev.control);
      listening = null;
      guesses.delete(action);
      if (showActionKind(action) === "encoder" && ev.control.kind === "cc") {
        sampling = { action, key: controlKey(ev.control), raws: [ev.raw] };
        guesses.set(action, "Keep turning slowly, both ways, to detect its mode…");
        clearTimeout(learnTimer);
        learnTimer = setTimeout(() => {
          if (sampling?.action === action && sampling.raws.length < 3) {
            guesses.set(action, "Couldn't tell its mode — pick it below.");
          }
          sampling = null;
          rebuild();
        }, 3000);
      }
      rebuild();
    });

    async function ensureEnabled(): Promise<void> {
      if (!midiManager.enabled) await midiManager.enable();
      rebuild();
    }

    function optionsBlock(): HTMLElement {
      const box = document.createElement("div");
      box.className = "show-midi-options";
      const twister = Button({
        label: "Set up Midi Fighter Twister",
        icon: "midi",
        variant: "quiet",
        onClick: () => openTwisterSetup({ onDone: rebuild }),
      });
      const o = midiStore.showOptions();
      const lbl = document.createElement("label");
      lbl.className = "show-midi-opt";
      const cap = document.createElement("span");
      cap.textContent = "Encoder push";
      const sel = document.createElement("select");
      sel.className = "show-midi-select";
      for (const [v, t] of [
        ["cue", "Cue — load onto the deck"],
        ["take", "Take — load + crossfade to it"],
      ] as const) {
        const op = document.createElement("option");
        op.value = v;
        op.textContent = t;
        op.selected = o.loadBehavior === v;
        sel.append(op);
      }
      sel.addEventListener("change", () =>
        midiStore.setShowOptions({ loadBehavior: sel.value === "take" ? "take" : "cue" }),
      );
      lbl.append(cap, sel);
      const secs = document.createElement("label");
      secs.className = "show-midi-opt";
      const cap2 = document.createElement("span");
      cap2.textContent = "Take fade (s)";
      const num = document.createElement("input");
      num.type = "number";
      num.min = "0";
      num.max = "30";
      num.step = "0.1";
      num.value = String(o.takeSeconds);
      num.className = "show-midi-num";
      num.addEventListener("change", () => {
        const v = Number(num.value);
        if (Number.isFinite(v) && v >= 0 && v <= 30) midiStore.setShowOptions({ takeSeconds: v });
      });
      secs.append(cap2, num);
      box.append(twister, lbl, secs);
      return box;
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
      body.append(optionsBlock());
      const hint = document.createElement("p");
      hint.className = "sheet-hint";
      hint.textContent = listening
        ? "Move a control to bind it…"
        : "Tap an action, then move the knob/button to bind it. Encoders: turn slowly a few clicks so the mode can be detected.";
      body.append(hint);
      for (const a of SHOW_ACTIONS) {
        body.append(actionRow(a));
      }
    }

    function actionRow(a: ShowAction): HTMLElement {
      const row = document.createElement("div");
      row.className = "show-midi-row";
      if (listening === a.id) row.classList.add("show-midi-row--learn");
      const main = document.createElement("div");
      main.className = "show-midi-main";
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
        guesses.delete(a.id);
        rebuild();
      });
      main.append(label, val, learn, clear);
      row.append(main);

      // Encoder actions on a CC: how the control encodes its movement.
      if (a.kind === "encoder" && bound && bound.kind === "cc") {
        const sub = document.createElement("div");
        sub.className = "show-midi-sub";
        const sel = document.createElement("select");
        sel.className = "show-midi-select";
        sel.setAttribute("aria-label", `${a.label} — encoder mode`);
        const cur = midiStore.showBindingMode(a.id);
        for (const m of ENCODER_MODES) {
          const op = document.createElement("option");
          op.value = m.id;
          op.textContent = m.label;
          op.selected = m.id === cur;
          sel.append(op);
        }
        sel.addEventListener("change", () => {
          const m: EncoderMode = isEncoderMode(sel.value) ? sel.value : "absolute";
          midiStore.setShowBindingMode(a.id, m);
          if (sampling?.action === a.id) sampling = null; // manual choice wins
          guesses.delete(a.id);
          rebuild();
        });
        sub.append(sel);
        const note = guesses.get(a.id) ??
          (cur === "absolute" ? "Absolute knobs stop at the ends — a relative mode scrolls endlessly." : "");
        if (note) {
          const n = document.createElement("div");
          n.className = "show-midi-note";
          n.textContent = note;
          sub.append(n);
        }
        row.append(sub);
      }
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
    setFocus(focusIndex);
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
      // Re-read the decks' keypoints when the connection (re)appears only — app
      // state changes are frequent; the list itself only moves on save/delete/cue.
      let wasConnected = connected();
      stateUnsub = appState.subscribe(() => {
        render();
        if (connected() !== wasConnected) {
          wasConnected = connected();
          void strips[0].refresh();
          void strips[1].refresh();
        }
      });
      void strips[0].refresh();
      void strips[1].refresh();
    },
    onUnmount: () => {
      midiUnsub?.();
      midiUnsub = null;
      stateUnsub?.();
      stateUnsub = null;
      cancelAnimationFrame(fadeRaf);
      compiler.dispose();
    },
  };
}
