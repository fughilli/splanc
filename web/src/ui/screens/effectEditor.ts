/**
 * In-shell effect editor (replaces the detached /editor.html) — a first-class,
 * routed screen at #/effects/edit/:id. It loads the effect's `source` from the
 * EffectStore, compiles it off-thread (FxCompilerWorker) on idle, previews it
 * with the EXACT firmware VM (FxPreview) over a map, and autosaves edits back to
 * the store. When a device is connected (appState.client) it can push the
 * compiled .fxb and live uniform values.
 *
 * Editor features (see the task brief):
 *  1. A compile status chip that reflects the worker compile lifecycle
 *     (compiling… → ✓ compiled · N uniforms · M bytes / ✕ line L: msg), made
 *     visible the instant a compile is kicked off and race-safe against
 *     superseded compiles.
 *  2. A collapsible disassembly panel, refreshed on each successful compile —
 *     the .fxb is disassembled by the AUTHORITATIVE Rust disassembler exposed
 *     through the compiler wasm (fx_disassemble) via the worker.
 *  3. A lightweight syntax-highlight overlay (transparent textarea over a
 *     <pre><code> backdrop, see highlight.ts) — no heavy editor dependency.
 *  4. An interactive AI CHAT panel driving a tool-use loop (set_script /
 *     capture_preview vision + MIDI-mapping tools) against api.anthropic.com
 *     (BYO key).
 *  5. Key config moved into a ⋯ overflow menu in the
 *     editor header (out of the main body).
 *  6. A MIDI pane (FUG-9): bind hardware controls to this effect's uniforms via
 *     the mapping layer (never the source), with a ✨ AI "Remap" button. The
 *     shared MidiRouter moves the uniform controls live as knobs turn.
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { FxPreview, deriveLedTopology, type FxUniform, type LedTopology } from "../../fx/preview";
import { MapView } from "../mapview";
import { generateFixture } from "../../effects/fixtures";
import { extractTopology } from "../../topology/extract";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { UniformPanel } from "../../effects/editor/uniform-panel";
import { highlight } from "../../effects/editor/highlight";
import { formatFx } from "../../effects/editor/format";
import { complete, type CompletionItem } from "../../effects/editor/completions";
import {
  chatTurn,
  editorContext,
  getApiKey,
  type ChatMessage,
  type MidiMappingCall,
} from "../../effects/ai/generate";
import { resolveFleetTargets } from "../../effects/fleet";
import { estimateAcrossDevices, describeFleet } from "../../effects/multiDevice";
import { estimateFrameTime, DEFAULT_BUDGET_MODEL, type BudgetModel } from "../../effects/costModel";
import { budgetFromEstimate } from "../../effects/budget";
import { costTableStore } from "../../store/costTableStore";
import { builtinCostsToPrompt } from "../../effects/perfContext";
import { BudgetBar } from "./budgetBar";
import { MidiRouter, isDrivable } from "../../midi/router";
import { MidiMapPanel } from "../../effects/editor/midi-panel";
import { midiStore, type UniformBinding } from "../../store/midiStore";
import { midiManager, controlLabel } from "../../midi/manager";
import { effectStore, isBuiltinEffect } from "../../store/effectStore";
import { mapStore } from "../../store/mapStore";
import { renderSettings } from "../../store/appearance";
import { appState } from "../app/state";
import { Button, IconButton, icon, toast, type IconName } from "../kit";
import { FxLayout } from "../../effects/editor/layout";
import { VideoTexturePanel } from "../../effects/editor/videoTexture";
import { openAiKeySheet } from "./aiKeySheet";
import { renderMarkdown } from "../markdown";
import type { Router, Screen } from "../app/router";

const COMPILE_DEBOUNCE_MS = 300;
const SAVE_DEBOUNCE_MS = 800;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Byte-for-byte equality of two (possibly null) buffers. */
function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function EffectEditorScreen(router: Router, effectId: string): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--fxedit";

  // -- live state -----------------------------------------------------------
  const worker = new FxCompilerWorker();
  let currentMap: OutputMap | null = null;
  let mapView: MapView | null = null;
  // Preview grid/triad state, seeded from the Appearance defaults and toggled by
  // the view chips; applied to mapView whenever it's (re)created.
  let previewGrid = false;
  let previewTriad = false;
  let positions: Float32Array | null = null;
  let preview: FxPreview | null = null;
  // Per-LED topology (led.seg/s/branch) for the current map, so the preview
  // matches the device. Recomputed async on map change; token guards staleness.
  let currentTopo: LedTopology | null = null;
  let topoToken = 0;
  let lastT = 0;
  let frame = 0;
  let startT = 0;
  let compileTimer: number | null = null;
  let saveTimer: number | null = null;
  let compileSeq = 0;
  // Latest successful-compile artefacts, fed to the AI as turn context.
  let lastCompileSummary = "not compiled yet";
  let lastDisassembly = "";
  let lastBytecode: Uint8Array | null = null;
  // The .fxb last successfully pushed to the device — auto-push skips a compile
  // whose bytecode is byte-identical (e.g. a whitespace edit) so it doesn't
  // needlessly re-flash the device.
  let lastPushedFxb: Uint8Array | null = null;
  let chatBusy = false;
  const chatHistory: ChatMessage[] = [];
  let raf = 0;
  let disposed = false;

  // -- DOM ------------------------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.className = "fxedit-canvas";
  canvas.width = 640;
  canvas.height = 420;

  /** MapView now owns the preview canvas resolution (it tracks the element's CSS
   * box via a ResizeObserver and scales the context by devicePixelRatio), so a
   * relayout needs no manual resize here — kept as a hook point for onRelayout. */
  function resizePreviewCanvas(): void {
    /* no-op: MapView self-sizes to its display box */
  }

  // -- inline-editable effect name (a small pill; click → input in place) ----
  // Rendered as plain text; clicking swaps in an input that commits on
  // Enter/blur (effectStore.rename) and cancels on Esc. It lives in the floating
  // control cluster (top-left), NOT as a full Field row.
  let effectName = "Untitled effect";
  const nameLabel = document.createElement("button");
  nameLabel.type = "button";
  nameLabel.className = "fxedit-namepill";
  nameLabel.title = "Rename effect";
  const nameInput = document.createElement("input");
  nameInput.className = "fxedit-nameinput";
  nameInput.spellcheck = false;
  nameInput.autocapitalize = "off";
  nameInput.setAttribute("autocomplete", "off");
  nameInput.style.display = "none";

  function setNameText(name: string): void {
    effectName = name;
    nameLabel.textContent = name;
  }
  function beginNameEdit(): void {
    nameInput.value = effectName;
    nameLabel.style.display = "none";
    nameInput.style.display = "";
    nameInput.focus();
    nameInput.select();
  }
  function commitNameEdit(): void {
    if (nameInput.style.display === "none") return;
    const next = nameInput.value.trim() || "Untitled effect";
    nameInput.style.display = "none";
    nameLabel.style.display = "";
    if (next !== effectName) {
      setNameText(next);
      void effectStore.rename(effectId, next);
    }
  }
  function cancelNameEdit(): void {
    nameInput.style.display = "none";
    nameLabel.style.display = "";
  }
  nameLabel.addEventListener("click", beginNameEdit);
  nameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitNameEdit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancelNameEdit();
    }
  });
  nameInput.addEventListener("blur", commitNameEdit);

  // -- code editor: transparent textarea layered над a highlighted backdrop --
  const editorWrap = document.createElement("div");
  editorWrap.className = "fxedit-editor";

  const codeWrap = document.createElement("div");
  codeWrap.className = "fxedit-codewrap";
  const backdrop = document.createElement("pre");
  backdrop.className = "fxedit-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  const backdropCode = document.createElement("code");
  backdrop.appendChild(backdropCode);
  const codeEl = document.createElement("textarea");
  codeEl.className = "fxedit-code";
  codeEl.spellcheck = false;
  codeEl.autocapitalize = "off";
  codeEl.setAttribute("autocomplete", "off");
  codeWrap.append(backdrop, codeEl);

  function paintHighlight(): void {
    backdropCode.innerHTML = highlight(codeEl.value);
  }
  function syncScroll(): void {
    backdrop.scrollTop = codeEl.scrollTop;
    backdrop.scrollLeft = codeEl.scrollLeft;
    if (popupOpen) positionPopup();
  }

  // -- autocomplete popup ---------------------------------------------------
  // A floating list anchored at the caret with per-item docstrings. Caret pixel
  // coordinates are computed via a hidden "mirror" <div> that duplicates the
  // textarea's text + font metrics up to the caret; the caret position is the
  // offset of a zero-width marker span inside the mirror (the standard trick).
  const popup = document.createElement("div");
  popup.className = "fxac";
  popup.style.display = "none";
  const popupList = document.createElement("div");
  popupList.className = "fxac-list";
  const popupDoc = document.createElement("div");
  popupDoc.className = "fxac-doc";
  popup.append(popupList, popupDoc);

  // Mirror for caret measurement. Hidden but laid out; styles are copied from
  // the textarea on demand so font/padding/line-height match exactly.
  const mirror = document.createElement("div");
  mirror.className = "fxac-mirror";
  mirror.setAttribute("aria-hidden", "true");
  const mirrorMark = document.createElement("span");
  codeWrap.append(popup, mirror);

  let popupOpen = false;
  let popupItems: CompletionItem[] = [];
  let popupFrom = 0;
  let popupActive = 0;
  let popupTimer: number | null = null;

  const KIND_BADGE: Record<CompletionItem["kind"], string> = {
    member: "mem",
    func: "fn",
    type: "ty",
    keyword: "kw",
    context: "ctx",
    uniform: "var",
    state: "state",
    swizzle: "sw",
  };

  function caretPixel(): { left: number; top: number } {
    // Copy the metrics that affect glyph flow from the textarea to the mirror.
    const cs = getComputedStyle(codeEl);
    const props = [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "boxSizing",
      "tabSize",
    ] as const;
    for (const p of props) mirror.style.setProperty(cssProp(p), cs[p as keyof CSSStyleDeclaration] as string);
    mirror.style.width = `${codeEl.clientWidth}px`;

    const caret = codeEl.selectionEnd;
    mirror.textContent = codeEl.value.slice(0, caret);
    mirror.appendChild(mirrorMark);
    mirrorMark.textContent = "​";

    const left = mirrorMark.offsetLeft - codeEl.scrollLeft;
    const top = mirrorMark.offsetTop - codeEl.scrollTop;
    return { left, top };
  }

  function cssProp(camel: string): string {
    return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  }

  function positionPopup(): void {
    const { left, top } = caretPixel();
    const lineH = parseFloat(getComputedStyle(codeEl).lineHeight) || 18;
    popup.style.left = `${Math.max(0, left)}px`;
    popup.style.top = `${top + lineH + 2}px`;
  }

  function renderPopup(): void {
    popupList.replaceChildren();
    popupItems.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "fxac-row" + (i === popupActive ? " fxac-row--active" : "");
      const badge = document.createElement("span");
      badge.className = `fxac-badge fxac-badge--${it.kind}`;
      badge.textContent = KIND_BADGE[it.kind];
      const label = document.createElement("span");
      label.className = "fxac-label";
      label.textContent = it.label;
      const detail = document.createElement("span");
      detail.className = "fxac-detail";
      detail.textContent = it.detail;
      row.append(badge, label, detail);
      row.addEventListener("mousedown", (ev) => {
        // mousedown (not click) so the textarea doesn't blur before we accept.
        ev.preventDefault();
        popupActive = i;
        acceptCompletion();
      });
      row.addEventListener("mouseenter", () => {
        popupActive = i;
        highlightActive();
      });
      popupList.appendChild(row);
    });
    const active = popupItems[popupActive];
    popupDoc.textContent = active ? active.doc : "";
  }

  function highlightActive(): void {
    const rows = popupList.children;
    for (let i = 0; i < rows.length; i++) {
      rows[i]!.classList.toggle("fxac-row--active", i === popupActive);
    }
    const active = popupItems[popupActive];
    popupDoc.textContent = active ? active.doc : "";
    const el2 = rows[popupActive] as HTMLElement | undefined;
    el2?.scrollIntoView({ block: "nearest" });
  }

  function openPopup(): void {
    if (disposed) return;
    const caret = codeEl.selectionEnd;
    // Only trigger with a collapsed selection.
    if (codeEl.selectionStart !== caret) return closePopup();
    const { items, from } = complete(codeEl.value, caret);
    if (items.length === 0) return closePopup();
    popupItems = items;
    popupFrom = from;
    popupActive = 0;
    popupOpen = true;
    popup.style.display = "";
    renderPopup();
    positionPopup();
  }

  function closePopup(): void {
    if (!popupOpen) return;
    popupOpen = false;
    popup.style.display = "none";
    popupItems = [];
  }

  function schedulePopup(): void {
    if (popupTimer !== null) clearTimeout(popupTimer);
    popupTimer = window.setTimeout(openPopup, 60);
  }

  // selectionchange fires on any caret move (mouse click, arrow keys). If the
  // caret is no longer at the token the popup was opened for, dismiss it — we
  // don't reopen here to avoid a popup on every click; typing reopens it.
  function onSelectionChange(): void {
    if (!popupOpen) return;
    if (document.activeElement !== codeEl) return closePopup();
    const caret = codeEl.selectionEnd;
    if (caret < popupFrom) return closePopup();
    positionPopup();
  }

  function acceptCompletion(): void {
    const it = popupItems[popupActive];
    if (!it) return closePopup();
    const caret = codeEl.selectionEnd;
    const before = codeEl.value.slice(0, popupFrom);
    const after = codeEl.value.slice(caret);
    // Functions insert `name(` and leave the caret inside the parens.
    const insert = it.kind === "func" ? `${it.insertText}(` : it.insertText;
    codeEl.value = before + insert + after;
    const newCaret = before.length + insert.length;
    codeEl.selectionStart = codeEl.selectionEnd = newCaret;
    closePopup();
    // Repaint highlight + persist, but do NOT trigger a compile from an accept
    // beyond the normal edit path — reuse the same schedulers as typing.
    paintHighlight();
    syncScroll();
    scheduleCompile();
    scheduleSave();
    codeEl.focus();
  }

  /** Keydown handler for popup navigation; returns true if it consumed the key
   * (so the caller can preventDefault and skip other editor handling). */
  function popupKeydown(ev: KeyboardEvent): boolean {
    if (!popupOpen) return false;
    switch (ev.key) {
      case "ArrowDown":
        popupActive = (popupActive + 1) % popupItems.length;
        highlightActive();
        return true;
      case "ArrowUp":
        popupActive = (popupActive - 1 + popupItems.length) % popupItems.length;
        highlightActive();
        return true;
      case "Enter":
      case "Tab":
        acceptCompletion();
        return true;
      case "Escape":
        closePopup();
        return true;
      default:
        return false;
    }
  }

  // -- compile status chip --------------------------------------------------
  // The line holds the compile status (a text span that's rewritten on each
  // compile) plus a persistent collapse/expand arrow for the budget drawer.
  const statusEl = document.createElement("div");
  statusEl.className = "fxedit-status";
  const statusText = document.createElement("span");
  statusText.className = "fxedit-status-text";
  statusEl.append(statusText);

  // -- FUG-11 budget bar ----------------------------------------------------
  // The color-coded fraction of the frame budget the current program consumes,
  // estimated OFFLINE from the resolved device cost model (real-C6-calibrated
  // when a device profile is stored, else the shipped default) for the active
  // map's LED count. Shown right under the compile status so the "will this hit
  // framerate?" signal is visible while authoring — no device required.
  const PERF_COLLAPSE_KEY = "fxedit.perf.collapsed.v1";
  const budgetBar = BudgetBar();
  budgetBar.el.classList.add("fxedit-budget");
  // Collapsible perf meter: an arrow tab collapses the full bar down to a thin
  // colored strip at the bottom of the code tab (under the compile output). The
  // strip keeps its budget color, so the "am I over budget?" signal survives.
  const perfWrap = document.createElement("div");
  perfWrap.className = "fxedit-perf";
  perfWrap.style.display = "none";
  // Collapse/expand arrow, docked at the right end of the compiler-output line:
  // it opens/closes the verbose budget drawer (percent + ms), leaving just the
  // colored strip when collapsed.
  const perfToggle = document.createElement("button");
  perfToggle.type = "button";
  perfToggle.className = "fxedit-perf-toggle";
  perfToggle.title = "Show / hide budget details";
  perfToggle.setAttribute("aria-label", "Toggle budget details");
  perfToggle.append(icon("chevron"));
  const isPerfCollapsed = (): boolean => perfWrap.classList.contains("fxedit-perf--collapsed");
  const setPerfCollapsed = (collapsed: boolean): void => {
    perfWrap.classList.toggle("fxedit-perf--collapsed", collapsed);
    perfToggle.classList.toggle("fxedit-perf-toggle--collapsed", collapsed);
    try {
      localStorage.setItem(PERF_COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage blocked — non-fatal */
    }
  };
  setPerfCollapsed(localStorage.getItem(PERF_COLLAPSE_KEY) === "1");
  perfToggle.addEventListener("click", () => setPerfCollapsed(!isPerfCollapsed()));
  statusEl.append(perfToggle);
  perfWrap.append(budgetBar.el);
  editorWrap.append(codeWrap, statusEl, perfWrap);

  async function updateBudgetBar(bytecode: Uint8Array | null): Promise<void> {
    if (bytecode === null) {
      perfWrap.style.display = "none";
      return;
    }
    try {
      const { table } = await costTableStore.resolveTable();
      const model: BudgetModel = table.budget ?? DEFAULT_BUDGET_MODEL;
      const ledCount = currentMap ? currentMap.leds.length : 256;
      const est = estimateFrameTime({ bytecode, ledCount, table });
      budgetBar.update(budgetFromEstimate(est, model));
      perfWrap.style.display = "";
    } catch {
      perfWrap.style.display = "none";
    }
  }

  function setStatusCompiling(): void {
    statusEl.className = "fxedit-status fxedit-status--busy";
    statusText.replaceChildren();
    const spin = document.createElement("span");
    spin.className = "fxedit-spinner";
    const txt = document.createElement("span");
    txt.textContent = "compiling…";
    statusText.append(spin, txt);
  }
  function setStatusOk(text: string): void {
    statusEl.className = "fxedit-status fxedit-status--ok";
    statusText.textContent = `✓ ${text}`;
  }
  function setStatusErr(text: string): void {
    statusEl.className = "fxedit-status fxedit-status--err";
    statusText.textContent = `✕ ${text}`;
  }

  // -- disassembly panel ----------------------------------------------------
  // The disassembly <pre> is a pane body (see FxLayout below); its show/hide is
  // driven by the layout, and mirrored by the ⋯ menu toggle.
  const disasmPre = document.createElement("pre");
  disasmPre.className = "fxedit-disasm";

  const uniformsHost = document.createElement("div");
  uniformsHost.className = "uniform-panel";
  const uniHint = document.createElement("p");
  uniHint.className = "fxedit-muted";
  uniHint.textContent = "Compile a script to see its controls.";
  uniformsHost.appendChild(uniHint);

  const diagsEl = document.createElement("ul");
  diagsEl.className = "fxedit-diags";

  const panel = new UniformPanel(uniformsHost, (slot, value) => {
    preview?.setUniform(slot, value);
    const c = appState.client;
    if (c?.isConnected) c.setUniforms([{ slot, value }]);
  });

  // -- MIDI: route hardware controls into the SAME uniform seam as a manual
  // drag (moves the panel control → preview + device), plus a per-effect
  // mapping pane. The router/panel share the app-wide midiManager/midiStore.
  // Latest compiled uniform manifest, cached so the MIDI tools/panel can list
  // the effect's drivable uniforms without recompiling.
  let lastUniforms: FxUniform[] = [];
  const midiRouter = new MidiRouter((u) => panel.applyExternal(u.slot, u.value));
  midiRouter.setEffect(effectId);
  const midiPanel = new MidiMapPanel(effectId, { onRemap: () => runRemap() });

  // -- AI chat panel --------------------------------------------------------
  const chatLog = document.createElement("div");
  chatLog.className = "fxedit-chatlog";
  const chatHint = document.createElement("p");
  chatHint.className = "fxedit-muted";
  chatHint.textContent =
    "Ask the AI to write or tweak this effect. It can compile changes and see the live preview.";
  chatLog.appendChild(chatHint);

  // The input is a textarea with the send control nested inline at its right as
  // an up-arrow button (so the box stays the dominant, legible element).
  const chatInput = document.createElement("textarea");
  chatInput.className = "fxedit-ask";
  chatInput.rows = 2;
  chatInput.placeholder = "e.g. make it a gentle blue breathing along the trunk";
  const chatSend = document.createElement("button");
  chatSend.type = "button";
  chatSend.className = "fxedit-asksend";
  chatSend.title = "Send (⌘/Ctrl + Enter)";
  chatSend.setAttribute("aria-label", "Send");
  chatSend.appendChild(icon("arrow-up"));
  chatSend.addEventListener("click", () => void runChat());
  const chatInputWrap = document.createElement("div");
  chatInputWrap.className = "fxedit-askwrap";
  chatInputWrap.append(chatInput, chatSend);
  chatInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void runChat();
    }
  });

  function appendChat(role: "user" | "assistant" | "tool", text: string): HTMLElement {
    if (chatHint.isConnected) chatHint.remove();
    const row = document.createElement("div");
    row.className = `fxedit-msg fxedit-msg--${role}`;
    if (role === "assistant") {
      // Assistant replies may use markdown (bold/italic/lists/code/links). User
      // and tool rows stay literal — the user typed theirs, and tool lines are
      // terse status labels. renderMarkdown builds DOM nodes directly (no
      // innerHTML), so untrusted model text can't inject markup.
      row.classList.add("fxedit-md");
      row.appendChild(renderMarkdown(text));
    } else {
      row.textContent = text;
    }
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
    return row;
  }

  // A live "what the model is doing" indicator (spinner + phase label), shown at
  // the foot of the log while a turn runs and updated as phases change.
  let chatStatusEl: HTMLElement | null = null;
  function setChatStatus(label: string): void {
    if (chatHint.isConnected) chatHint.remove();
    if (chatStatusEl === null) {
      chatStatusEl = document.createElement("div");
      chatStatusEl.className = "fxedit-chatstatus";
      const sp = document.createElement("span");
      sp.className = "fxedit-spinner";
      const tx = document.createElement("span");
      tx.className = "fxedit-chatstatus-label";
      chatStatusEl.append(sp, tx);
    }
    (chatStatusEl.querySelector(".fxedit-chatstatus-label") as HTMLElement).textContent = label;
    chatLog.appendChild(chatStatusEl); // keep it pinned to the bottom
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function clearChatStatus(): void {
    chatStatusEl?.remove();
    chatStatusEl = null;
  }

  // -- device section -------------------------------------------------------
  const devStatus = document.createElement("div");
  devStatus.className = "fxedit-muted";
  // Push (send this effect) / Pull (load the RUNNING effect's uniforms) — icon+
  // label tiles, matching the map-detail treatment.
  const deviceTile = (ic: IconName, label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "k-actiontile";
    b.append(icon(ic));
    const s = document.createElement("span");
    s.textContent = label;
    b.append(s);
    b.addEventListener("click", onClick);
    return b;
  };
  const sendBtn = deviceTile("effect-to-device", "Push", () => void sendToDevice());
  const hydrateBtn = deviceTile("effect-from-device", "Pull", () => void hydrateFromDevice());
  const devTiles = document.createElement("div");
  devTiles.className = "k-actiongrid fxedit-devtiles";
  devTiles.append(sendBtn, hydrateBtn);

  // Auto-push: when on, every successful compile is sent to the device.
  const AUTOPUSH_KEY = "fxedit.autopush.v1";
  const autoPushRow = document.createElement("label");
  autoPushRow.className = "fxedit-autopush";
  const autoPushCb = document.createElement("input");
  autoPushCb.type = "checkbox";
  autoPushCb.checked = localStorage.getItem(AUTOPUSH_KEY) === "1";
  const autoPushTxt = document.createElement("span");
  autoPushTxt.textContent = "Auto-push on compile";
  autoPushRow.append(autoPushCb, autoPushTxt);
  autoPushCb.addEventListener("change", () => {
    try {
      localStorage.setItem(AUTOPUSH_KEY, autoPushCb.checked ? "1" : "0");
    } catch {
      /* storage blocked — non-fatal */
    }
    // Just enabled with a program already compiled → push it right away.
    if (autoPushCb.checked && lastBytecode) void pushBytecode(lastBytecode);
  });

  // The effect id last reported as running on the device (null = unknown). When
  // it isn't this workspace's effect, the Device tab lights up (a warn tint) to
  // prompt the user to open it and push — instead of a floating pill.
  let runningEffectId: string | null = null;
  function refreshMismatch(): void {
    const mismatch = runningEffectId !== null && runningEffectId !== effectId;
    layout.setPaneAttention("diagnostics", mismatch);
  }

  // Video → device-texture streaming panel (its own pane). It consumes the live
  // client + the latest compiled bytecode (to discover the effect's textures).
  const videoPanel = new VideoTexturePanel();

  let prevConnected = false;
  function refreshDevice(): void {
    const connected = appState.client?.isConnected ?? false;
    sendBtn.disabled = !connected;
    hydrateBtn.disabled = !connected;
    if (!connected) devStatus.textContent = "Connect a device (tap the status pill) to send this effect.";
    videoPanel.setSink(connected ? appState.client : null);
    // Newly connected → automatically pull whatever effect is running so its
    // uniforms hydrate and any mismatch surfaces without a manual tap.
    if (connected && !prevConnected) void hydrateFromDevice();
    if (!connected) {
      runningEffectId = null;
      refreshMismatch();
    }
    prevConnected = connected;
  }

  // -- top drawer: collapsible chrome + ⋯ overflow menu ---------------------
  // The editor route runs under the Shell's OVERLAY chrome (app-bar + tab-bar
  // hidden), so all controls live in a single drawer bar pinned across the top
  // of the workspace:
  //   • left:  Back button + the inline-editable name pill
  //   • right: a ⋯ overflow menu (AI key…, Format code, Reset layout) and a
  //            chevron that COLLAPSES the drawer so the workspace reclaims the
  //            strip. A small floating handle re-expands it. State persists.
  const DRAWER_KEY = "fxedit.drawer.collapsed.v1";
  const drawer = document.createElement("div");
  drawer.className = "fxedit-drawer";
  const backBtn = IconButton("back", { title: "Back to effects", onClick: () => router.navigate("/effects") });
  backBtn.classList.add("fxedit-drawerbtn");

  // Right cluster: the ⋯ button anchors the overflow menu (position:relative),
  // and the collapse chevron sits beside it.
  const menuWrap = document.createElement("div");
  menuWrap.className = "fxedit-menuwrap";
  const kebab = IconButton("more", { title: "Editor menu", onClick: () => toggleMenu() });
  kebab.classList.add("fxedit-drawerbtn");
  menuWrap.appendChild(kebab);

  const collapseBtn = IconButton("chevron", { title: "Collapse toolbar", onClick: () => setDrawerCollapsed(true) });
  collapseBtn.classList.add("fxedit-drawerbtn", "fxedit-drawer-collapse");

  // While collapsed, the re-expand toggle lives INSIDE the top-right corner tab
  // strip's control cluster (see FxLayout.collapseToggle), not floating over it.
  function setDrawerCollapsed(collapsed: boolean): void {
    // Never collapse with no panes open: the expand toggle lives in a tab strip,
    // and with no tabs there'd be nothing to bring the drawer back with.
    if (collapsed && !layout.anyVisible()) return;
    el.classList.toggle("fxedit-drawer-collapsed", collapsed);
    if (collapsed) closeMenu();
    layout.refresh(); // re-render strips so the in-strip expand toggle toggles
    try {
      localStorage.setItem(DRAWER_KEY, collapsed ? "1" : "0");
    } catch {
      /* private-mode / quota — collapse still works for this session */
    }
  }

  const menu = document.createElement("div");
  menu.className = "fxedit-menu";
  menu.style.display = "none";
  const miKey = document.createElement("button");
  miKey.type = "button";
  miKey.className = "fxedit-menu-item";
  miKey.textContent = "AI key…";
  miKey.addEventListener("click", () => {
    closeMenu();
    openAiKeySheet();
  });
  const miFormat = document.createElement("button");
  miFormat.type = "button";
  miFormat.className = "fxedit-menu-item";
  miFormat.textContent = "Format code";
  miFormat.addEventListener("click", () => {
    formatCode();
    closeMenu();
  });
  const miReset = document.createElement("button");
  miReset.type = "button";
  miReset.className = "fxedit-menu-item";
  miReset.textContent = "Reset layout";
  miReset.addEventListener("click", () => {
    layout.resetLayout();
    closeMenu();
  });
  // Recall section: one "Show <Pane>" item per closed pane, rebuilt whenever the
  // menu opens (a pane's hidden state changes as the user closes/reopens panes).
  const miRecall = document.createElement("div");
  miRecall.className = "fxedit-menu-recall";
  function refreshRecall(): void {
    miRecall.replaceChildren();
    const hidden = layout.hiddenPanes();
    if (hidden.length === 0) return;
    const sep = document.createElement("div");
    sep.className = "fxedit-menu-sep";
    sep.textContent = "Closed panes";
    miRecall.appendChild(sep);
    for (const pane of hidden) {
      const it = document.createElement("button");
      it.type = "button";
      it.className = "fxedit-menu-item";
      it.textContent = `Show ${pane.title}`;
      it.addEventListener("click", () => {
        layout.setVisible(pane.id, true);
        closeMenu();
      });
      miRecall.appendChild(it);
    }
  }
  menu.append(miKey, miFormat, miReset, miRecall);

  // Auto-format (re-indent) the buffer, keeping the caret at roughly the same
  // logical spot (measured in non-whitespace characters, which the reformat
  // preserves). Repaints, recompiles and autosaves like any edit.
  function formatCode(): void {
    const old = codeEl.value;
    const next = formatFx(old);
    if (next === old) {
      toast("Already formatted");
      return;
    }
    const caret = codeEl.selectionStart ?? 0;
    let before = 0;
    for (let i = 0; i < caret; i++) if (!/\s/.test(old[i]!)) before++;
    codeEl.value = next;
    let seen = 0;
    let pos = next.length;
    if (before === 0) {
      pos = 0;
    } else {
      for (let i = 0; i < next.length; i++) {
        if (!/\s/.test(next[i]!) && ++seen === before) {
          pos = i + 1;
          break;
        }
      }
    }
    codeEl.setSelectionRange(pos, pos);
    paintHighlight();
    syncScroll();
    scheduleCompile();
    scheduleSave();
    toast("Formatted");
  }
  menuWrap.appendChild(menu);

  let menuOpen = false;
  function toggleMenu(): void {
    if (menuOpen) closeMenu();
    else openMenu();
  }
  function openMenu(): void {
    menuOpen = true;
    refreshRecall();
    menu.style.display = "";
    // Defer the outside-click listener so this same click doesn't close it.
    setTimeout(() => document.addEventListener("click", onDocClick), 0);
  }
  function closeMenu(): void {
    menuOpen = false;
    menu.style.display = "none";
    document.removeEventListener("click", onDocClick);
  }
  function onDocClick(ev: MouseEvent): void {
    const t = ev.target as Node;
    if (!menu.contains(t) && !kebab.contains(t)) closeMenu();
  }

  // -- map picker -----------------------------------------------------------
  // A circular overlay button (bottom-right of the preview) opens a dropdown
  // menu listing the available maps. Mirrors the ⋯ overflow-menu pattern, but
  // opens UPWARD since it sits at the bottom of the pane.
  const mapMenu = document.createElement("div");
  mapMenu.className = "fxedit-menu fxedit-menu--up";
  mapMenu.style.display = "none";

  let mapMenuOpen = false;
  function openMapMenu(): void {
    mapMenuOpen = true;
    mapMenu.style.display = "";
    // Defer the outside-click listener so this same click doesn't close it.
    setTimeout(() => document.addEventListener("click", onMapDocClick), 0);
  }
  function closeMapMenu(): void {
    mapMenuOpen = false;
    mapMenu.style.display = "none";
    document.removeEventListener("click", onMapDocClick);
  }
  function toggleMapMenu(): void {
    if (mapMenuOpen) closeMapMenu();
    else openMapMenu();
  }
  function onMapDocClick(ev: MouseEvent): void {
    const t = ev.target as Node;
    if (!mapMenu.contains(t) && !mapBtn.contains(t)) closeMapMenu();
  }

  async function populateMapPicker(): Promise<string | null> {
    const maps = await mapStore.list({ sort: "updated" });
    const opts: { value: string; label: string }[] = [
      { value: "__fixture__", label: "Sample fixture (tree)" },
      ...maps.map((m) => ({ value: m.id, label: m.name })),
    ];
    mapMenu.replaceChildren();
    for (const o of opts) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "fxedit-menu-item";
      item.dataset.value = o.value;
      item.textContent = o.label;
      item.addEventListener("click", () => {
        closeMapMenu();
        void selectMap(o.value);
      });
      mapMenu.appendChild(item);
    }
    return appState.selectedMapId ?? maps[0]?.id ?? null;
  }

  // Reflect the active map in the menu (a check-marked item).
  function markSelectedMap(id: string): void {
    for (const item of Array.from(mapMenu.children) as HTMLButtonElement[]) {
      item.classList.toggle("fxedit-menu-item--sel", item.dataset["value"] === id);
    }
  }

  async function selectMap(id: string): Promise<void> {
    markSelectedMap(id);
    if (id === "__fixture__") {
      loadMap(generateFixture("tree", { count: 160, seed: 3, jitterFrac: 0.06 }));
      return;
    }
    const rec = await mapStore.get(id);
    if (rec) loadMap(rec.map, rec.topology);
    else loadMap(generateFixture("tree", { count: 160, seed: 3, jitterFrac: 0.06 }));
  }

  function loadMap(map: OutputMap, topology?: Topology): void {
    currentMap = map;
    positions = new Float32Array(map.leds.length * 3);
    for (let i = 0; i < map.leds.length; i++) {
      const p = map.leds[i]!.xyz;
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
    }
    if (mapView === null) {
      mapView = new MapView(canvas, map);
      // Honour any chip toggles made before the view existed (the constructor
      // seeds from the same defaults, so this only matters after a user change).
      mapView.showGrid = previewGrid;
      mapView.showTriad = previewTriad;
      mapView.setLedColors(new Uint8Array(map.leds.length * 3));
      mapView.start();
    } else {
      mapView.update(map);
      mapView.setLedColors(new Uint8Array(map.leds.length * 3));
    }
    void refreshTopology(map, topology);
  }

  // Compute the current map's per-LED topology (led.seg/s/branch) so the preview
  // matches the device. Uses the stored topology when present, else extracts one
  // (the same path real data takes) so synthetic/junction fixtures preview their
  // topology too. Async + token-guarded: a newer map load supersedes an older
  // extraction that's still running.
  async function refreshTopology(map: OutputMap, topology?: Topology): Promise<void> {
    const token = ++topoToken;
    let topo = topology;
    if (!topo || topo.segments.length === 0) {
      topo = await extractTopology(map).catch(() => undefined);
    }
    if (token !== topoToken || disposed || currentMap !== map) return;
    currentTopo = deriveLedTopology(map, topo);
    preview?.setTopology(currentTopo);
  }

  // -- compile --------------------------------------------------------------
  function scheduleCompile(): void {
    if (compileTimer !== null) clearTimeout(compileTimer);
    // Signal "compiling…" immediately on any edit; the worker call is debounced
    // but the UI shows intent right away.
    setStatusCompiling();
    compileTimer = window.setTimeout(() => void compileNow(), COMPILE_DEBOUNCE_MS);
  }

  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void effectStore.save(effectId, codeEl.value);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Compile once and update all sinks. Returns the FxCompiled for callers that
   * need the result (the AI set_script tool). Superseded compiles no-op. */
  async function compileNow(): Promise<void> {
    // Mark busy synchronously so a compile kicked off programmatically (AI) is
    // visible before the worker returns.
    setStatusCompiling();
    const src = codeEl.value;
    const seq = ++compileSeq;
    const r = await worker.compile(src);
    if (seq !== compileSeq || disposed) return; // a newer compile supersedes us

    renderDiagnostics(r.diagnostics);
    if (!r.ok) {
      const first = r.diagnostics[0];
      const summary = first ? `line ${first.line + 1}: ${first.msg}` : "compile failed";
      setStatusErr(summary);
      lastCompileSummary = `ERROR — ${summary}`;
      lastDisassembly = "";
      lastBytecode = null;
      disasmPre.textContent = "";
      videoPanel.setBytecode(null);
      void updateBudgetBar(null);
      return;
    }
    lastBytecode = r.bytecode;
    setStatusOk(`compiled · ${r.uniforms.length} uniforms · ${r.bytecode.length} bytes`);
    void updateBudgetBar(r.bytecode);
    videoPanel.setBytecode(r.bytecode);
    lastCompileSummary = `OK — ${r.uniforms.length} uniforms, ${r.bytecode.length} bytes`;
    panel.setManifest(r.uniforms);
    lastUniforms = r.uniforms;
    // Auto-push: a clean compile goes straight to the connected device — but only
    // when the .fxb actually changed, so a whitespace-only edit doesn't re-flash.
    if (
      autoPushCb.checked &&
      appState.client?.isConnected &&
      !bytesEqual(r.bytecode, lastPushedFxb)
    ) {
      void pushBytecode(r.bytecode);
    }
    midiRouter.setManifest(r.uniforms);
    // Auto-bind uniforms to like-named controls ("speed" uniform ↔ a knob named
    // "speed") — fills gaps only, never overrides an explicit binding. Emits, so
    // the panel re-renders; then refresh its manifest for the drivable list.
    midiStore.autoBind(effectId, r.uniforms.filter(isDrivable).map((u) => u.name));
    midiPanel.setManifest(r.uniforms);
    await swapPreview(r.bytecode);

    // Refresh disassembly (authoritative Rust disassembler via the worker).
    const disasm = await worker.disassemble(r.bytecode);
    if (seq !== compileSeq || disposed) return;
    lastDisassembly = disasm;
    disasmPre.textContent = disasm;
  }

  async function swapPreview(bytecode: Uint8Array): Promise<void> {
    preview?.dispose();
    preview = await FxPreview.create(bytecode);
    if (disposed) {
      preview.dispose();
      preview = null;
      return;
    }
    for (const { slot, value } of panel.values()) preview.setUniform(slot, value);
    if (currentTopo !== null) preview.setTopology(currentTopo);
    startT = performance.now();
    frame = 0;
  }

  function renderDiagnostics(diags: { line: number; col: number; msg: string }[]): void {
    diagsEl.replaceChildren();
    for (const d of diags) {
      const li = document.createElement("li");
      li.textContent = `line ${d.line + 1}, col ${d.col + 1}: ${d.msg}`;
      diagsEl.appendChild(li);
    }
  }

  // -- animation ------------------------------------------------------------
  function tick(t: number): void {
    raf = requestAnimationFrame(tick);
    const dt = lastT === 0 ? 16 : Math.min(100, t - lastT);
    lastT = t;
    if (preview === null || mapView === null || currentMap === null || positions === null) return;
    const time = (t - startT) / 1000;
    preview.tick(time, dt / 1000, frame++, currentMap.leds.length);
    mapView.setLedColors(preview.shadeAll(positions));
  }

  // -- AI chat: run one user turn through the tool-use loop ------------------
  async function runChat(): Promise<void> {
    const ask = chatInput.value.trim();
    if (!ask) return;
    // Keep the typed text if there's no key yet (the sheet opens; sending again
    // after setting a key preserves the ask).
    if (!getApiKey()) {
      openAiKeySheet();
      return;
    }
    chatInput.value = "";
    await submitChat(ask);
  }

  // The canned "magic remap" prompt (FUG-9): the model reads the effect's
  // uniforms + the named MIDI controls and wires them via the mapping layer —
  // never by editing the effect source.
  const REMAP_PROMPT =
    "Map my MIDI controls to this effect's uniforms. First call list_midi_controls " +
    "to see the drivable uniforms and the named controls, then call set_midi_mapping " +
    "to wire them. Match by meaning (a 'speed'/'rate' knob → a speed uniform, " +
    "'brightness' → an intensity/gain uniform, etc.) and only map scalar uniforms. " +
    "Do NOT modify the effect source — the mapping is a separate layer.";

  async function runRemap(): Promise<void> {
    if (chatBusy) return;
    // Surface the AI-chat pane so the user sees what the remap is doing.
    if (!layout.isVisible("chat")) layout.setVisible("chat", true);
    await submitChat(REMAP_PROMPT, { label: "✨ Remap MIDI controls" });
  }

  /** Build the always-included MIDI context for the AI: the effect's drivable
   * uniforms, the globally-named controls, and the current bindings. */
  function midiListSummary(): string {
    const uniforms = lastUniforms.filter(isDrivable).map((u) => ({
      name: u.name,
      type: u.ui.kind,
      ...(u.ui.kind === "slider" ? { min: u.ui.min, max: u.ui.max } : {}),
    }));
    const controls = midiStore.semantics().map((s) => ({
      name: s.name,
      source: `${s.control.device} · ${controlLabel(s.control)}`,
    }));
    const current = midiStore.bindings(effectId).map((b) => ({
      uniform: b.uniform,
      control: b.semantic,
      ...(b.min !== undefined ? { min: b.min } : {}),
      ...(b.max !== undefined ? { max: b.max } : {}),
      ...(b.invert ? { invert: true } : {}),
    }));
    return JSON.stringify(
      { uniforms, namedControls: controls, currentMappings: current, midiEnabled: midiManager.enabled },
      null,
      2,
    );
  }

  /** Apply AI-proposed mappings to the mapping layer (never the source). */
  function applyMidiMappings(mappings: MidiMappingCall[]): string {
    const drivable = new Set(lastUniforms.filter(isDrivable).map((u) => u.name));
    const applied: UniformBinding[] = [];
    const skipped: string[] = [];
    for (const m of mappings) {
      if (!drivable.has(m.uniform)) {
        skipped.push(`${m.uniform} (not a drivable uniform)`);
        continue;
      }
      applied.push({
        uniform: m.uniform,
        semantic: m.control,
        ...(typeof m.min === "number" ? { min: m.min } : {}),
        ...(typeof m.max === "number" ? { max: m.max } : {}),
        ...(m.invert ? { invert: true } : {}),
      });
    }
    midiStore.replaceBindings(effectId, applied);
    return `Applied ${applied.length} mapping(s)${
      skipped.length ? `; skipped: ${skipped.join(", ")}` : ""
    }. The effect source was not modified.`;
  }

  /** Estimate the current program across the AI estimation fleet and render the
   * per-device budget report for the AI (FUG-11 feedback signal). Falls back to
   * the map's LED count for any fleet target and to the active device / default
   * when no fleet is configured. */
  async function estimateFleetReport(): Promise<string> {
    if (lastBytecode === null) {
      return "No compiled program to estimate — the current source does not compile. Fix the errors (or call set_script) first, then estimate again.";
    }
    const fallbackLeds = currentMap ? currentMap.leds.length : 256;
    const targets = await resolveFleetTargets(fallbackLeds);
    const fleet = estimateAcrossDevices(lastBytecode, targets);
    return describeFleet(fleet);
  }

  /** Shared body: ground the turn in the editor context, run the tool loop. */
  async function submitChat(ask: string, opts: { label?: string } = {}): Promise<void> {
    if (chatBusy) return;
    if (!getApiKey()) {
      // No key yet — prompt via the same sheet the ⋯ menu opens.
      openAiKeySheet();
      return;
    }
    appendChat("user", opts.label ?? ask);

    // Always ground the turn in the current editor + latest compile (+ disasm).
    const ctx = editorContext(
      lastDisassembly
        ? { source: codeEl.value, compileSummary: lastCompileSummary, disassembly: lastDisassembly }
        : { source: codeEl.value, compileSummary: lastCompileSummary },
    );
    chatHistory.push({ role: "user", content: `${ctx}\n\nUser: ${ask}` });

    chatBusy = true;
    chatSend.disabled = true;
    setChatStatus("Thinking…");

    // Per-device builtin cost listing (from the user's calibrated board if any,
    // else the default model) so the model knows the relative cost of each fn.
    let deviceCosts: string | undefined;
    try {
      const { table, stored } = await costTableStore.resolveTable();
      deviceCosts = builtinCostsToPrompt(table, stored !== null);
    } catch {
      deviceCosts = undefined;
    }

    try {
      const finalText = await chatTurn(
        chatHistory,
        {
        onThinking: () => setChatStatus("Thinking…"),
        onSetScript: async (source) => {
          setChatStatus("Generating code…");
          codeEl.value = source;
          paintHighlight();
          syncScroll();
          scheduleSave();
          setChatStatus("Compiling…");
          await compileNow();
          return `Compile result: ${lastCompileSummary}${
            lastDisassembly ? `\n\nDisassembly:\n${lastDisassembly}` : ""
          }`;
        },
        onCapturePreview: async () => {
          setChatStatus("Inspecting rendered image…");
          return capturePreviewPng();
        },
        onListMidi: async () => {
          setChatStatus("Reading MIDI controls…");
          return midiListSummary();
        },
        onSetMidiMapping: async (mappings) => {
          setChatStatus("Mapping MIDI controls…");
          return applyMidiMappings(mappings);
        },
        onEstimatePerformance: async () => {
          setChatStatus("Estimating performance…");
          return estimateFleetReport();
        },
        onToolUse: () => undefined,
        },
        deviceCosts,
      );
      clearChatStatus();
      appendChat("assistant", finalText || "(done)");
    } catch (e) {
      clearChatStatus();
      appendChat("assistant", `AI error: ${msg(e)}`);
    } finally {
      chatBusy = false;
      chatSend.disabled = false;
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  }

  /** Render the live preview canvas to a PNG data URL for the vision tool. The
   * MapView draws to `canvas` (a 2D context), so toDataURL captures the current
   * frame directly — we nudge one frame first so it reflects the latest script. */
  function capturePreviewPng(): string {
    if (preview !== null && mapView !== null && currentMap !== null && positions !== null) {
      const time = (performance.now() - startT) / 1000;
      preview.tick(time, 1 / 60, frame++, currentMap.leds.length);
      // MapView runs its own rAF loop, so pushing fresh colors updates the
      // canvas on the next frame; the capture reflects the current effect.
      mapView.setLedColors(preview.shadeAll(positions));
    }
    return canvas.toDataURL("image/png");
  }

  // -- device ---------------------------------------------------------------
  // Upload already-compiled bytecode + the current uniforms to the device. Shared
  // by the manual Push button and the auto-push-on-compile path.
  async function pushBytecode(bytecode: Uint8Array): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    devStatus.textContent = "Uploading…";
    try {
      await c.submitEffect(effectId, bytecode, true);
      lastPushedFxb = bytecode; // flashed — auto-push dedupes against this
      if (panel.values().length > 0) c.setUniforms(panel.values());
      // This effect is now the one running on the device → clears any mismatch.
      runningEffectId = effectId;
      refreshMismatch();
      devStatus.textContent = "Pushed · effect active.";
    } catch (e) {
      devStatus.textContent = `push failed: ${msg(e)}`;
    }
  }

  async function sendToDevice(): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    const r = await worker.compile(codeEl.value);
    if (!r.ok) {
      devStatus.textContent = "Fix compile errors before sending.";
      return;
    }
    await pushBytecode(r.bytecode);
  }

  // Pull the uniforms of whatever effect is CURRENTLY RUNNING on the device
  // (get_effect_uniforms with no id → the active effect). If that isn't this
  // workspace's effect, flag the mismatch in the corner.
  async function hydrateFromDevice(): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    try {
      const r = await c.getEffectUniforms();
      runningEffectId = r.effectId;
      refreshMismatch();
      panel.hydrate(r.current.map((x) => ({ slot: x.slot, value: x.value })));
      for (const { slot, value } of r.current) preview?.setUniform(slot, value);
      devStatus.textContent =
        r.effectId === effectId
          ? "Pulled uniforms from device."
          : "Pulled uniforms — device is running a different effect.";
    } catch (e) {
      devStatus.textContent = `pull failed: ${msg(e)}`;
    }
  }

  // -- layout ---------------------------------------------------------------
  // Circular icon toggle for a preview overlay (grid / triad). Flips
  // mapView.showGrid / showTriad; safe before mapView exists. `initial` seeds
  // the pressed state from the Appearance defaults so the button matches the
  // MapView, which also starts from those defaults.
  function overlayToggle(
    iconName: IconName,
    title: string,
    initial: boolean,
    apply: (on: boolean) => void,
  ): HTMLButtonElement {
    let on = initial;
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-pressed", String(on));
    b.className = "fxedit-ovbtn" + (on ? " fxedit-ovbtn--on" : "");
    b.appendChild(icon(iconName));
    b.addEventListener("click", () => {
      on = !on;
      b.classList.toggle("fxedit-ovbtn--on", on);
      b.setAttribute("aria-pressed", String(on));
      apply(on);
    });
    return b;
  }

  // Seed the overlay toggles (and, when it exists, the live view) from the
  // Appearance grid/triad defaults; thereafter the buttons own the preview's
  // overlay state.
  const viewDefaults = renderSettings();
  previewGrid = viewDefaults.showGrid;
  previewTriad = viewDefaults.showTriad;

  // Map-picker button: opens the map dropdown menu (anchored above it).
  const mapBtn = document.createElement("button");
  mapBtn.type = "button";
  mapBtn.title = "Preview map";
  mapBtn.className = "fxedit-ovbtn";
  mapBtn.appendChild(icon("map"));
  mapBtn.addEventListener("click", () => toggleMapMenu());
  const mapBtnWrap = document.createElement("div");
  mapBtnWrap.className = "fxedit-ovbtnwrap";
  mapBtnWrap.append(mapBtn, mapMenu);

  // A cluster of circular graphical buttons overlaid on the lower-right of the
  // 3D view (grid / triad overlay toggles + map picker), reclaiming the space
  // the old control strip took up below the canvas.
  const previewOverlay = document.createElement("div");
  previewOverlay.className = "fxedit-previewoverlay";
  previewOverlay.append(
    overlayToggle("grid", "Toggle floor grid", previewGrid, (v) => {
      previewGrid = v;
      if (mapView) mapView.showGrid = v;
    }),
    overlayToggle("triad", "Toggle world axes", previewTriad, (v) => {
      previewTriad = v;
      if (mapView) mapView.showTriad = v;
    }),
    mapBtnWrap,
  );

  // Preview pane content: the canvas fills the pane and the controls overlay
  // its lower-right corner. The canvas node is STABLE — it's created once and
  // only re-parented, so MapView keeps drawing to it.
  const previewBody = document.createElement("div");
  previewBody.className = "fxedit-previewbody";
  previewBody.append(canvas, previewOverlay);

  // Chat pane content.
  const chatBody = document.createElement("div");
  chatBody.className = "fxedit-chatbody";
  chatBody.append(chatLog, chatInputWrap);

  // "Device" pane content: the upload/download (send/hydrate) controls are the
  // primary surface; the compiler diagnostics list lives below under its own
  // label (both are "status" surfaces the user consults, not editing views).
  const diagBody = document.createElement("div");
  diagBody.className = "fxedit-diagbody";
  const diagsLegend = document.createElement("div");
  diagsLegend.className = "fxedit-legend";
  diagsLegend.textContent = "Diagnostics";
  diagBody.append(devTiles, autoPushRow, devStatus, diagsLegend, diagsEl);

  // Disassembly pane content (the .fxedit-disasm <pre>).
  const disasmBody = document.createElement("div");
  disasmBody.className = "fxedit-disasmbody";
  disasmBody.appendChild(disasmPre);

  // ---- pane model + slots -------------------------------------------------
  // Each pane wraps a STABLE content node (never recreated — only re-parented)
  // so the code textarea / MapView canvas / chat log preserve state across
  // relayouts. Panes live in "slots" (regions); the layout persists to
  // localStorage. On narrow viewports the wide layout is ignored: code +
  // uniforms are primary, the rest cycle through an overflow tab strip.
  const layout = new FxLayout({
    panes: [
      { id: "code", title: "Code", primary: true, node: editorWrap },
      { id: "uniforms", title: "Uniforms", primary: true, node: uniformsHost },
      { id: "preview", title: "Preview", node: previewBody },
      { id: "diagnostics", title: "Device", node: diagBody },
      { id: "disasm", title: "Disassembly", node: disasmBody },
      { id: "chat", title: "AI chat", node: chatBody },
      { id: "midi", title: "MIDI", node: midiPanel.node },
      { id: "video", title: "Video", node: videoPanel.node },
    ],
    onRelayout: () => {
      // A resize/relayout changes the canvas box; keep the preview crisp.
      resizePreviewCanvas();
      // With every tab closed the workspace has no strip to host the expand
      // toggle, so force the drawer expanded (and hide its collapse control via
      // .fxedit-no-panes) — Back / ⋯ stay reachable to recover a pane.
      const empty = !layout.anyVisible();
      el.classList.toggle("fxedit-no-panes", empty);
      if (empty && el.classList.contains("fxedit-drawer-collapsed")) setDrawerCollapsed(false);
    },
    // Collapsed: render the expand toggle in the corner strip's control cluster.
    collapseToggle: {
      collapsed: () => el.classList.contains("fxedit-drawer-collapsed"),
      onExpand: () => setDrawerCollapsed(false),
    },
  });
  // Assemble the drawer bar (left → right) and pin it above the workspace.
  drawer.append(backBtn, nameLabel, nameInput, menuWrap, collapseBtn);
  el.append(layout.root, drawer);
  // Restore the persisted collapsed state (defaults to expanded on first visit).
  try {
    if (localStorage.getItem(DRAWER_KEY) === "1") el.classList.add("fxedit-drawer-collapsed");
  } catch {
    /* ignore storage errors — start expanded */
  }

  let unsubAppState: (() => void) | null = null;

  async function load(): Promise<void> {
    const rec = await effectStore.get(effectId);
    if (!rec) {
      el.replaceChildren();
      const warn = document.createElement("div");
      warn.className = "screen-sub";
      warn.textContent = "Effect not found.";
      const back = Button({ label: "Back to effects", icon: "back", onClick: () => router.navigate("/effects") });
      el.append(warn, back);
      return;
    }
    setNameText(rec.name);
    codeEl.value = rec.source;
    paintHighlight();

    // Built-in starter effects are IMMUTABLE: show them read-only and offer a
    // one-tap fork. (effectStore.save is a no-op for them too, as a backstop.)
    if (isBuiltinEffect(effectId)) {
      codeEl.readOnly = true;
      nameInput.readOnly = true;
      // The banner lives INSIDE the code-wrap (not the screen root) so it's
      // confined to the Code pane: it grays out the read-only code behind a
      // centered card and leaves every other control — uniform sliders,
      // preview, device — reachable. (effectStore.save is a no-op for built-ins
      // too, as a backstop.)
      const banner = document.createElement("div");
      banner.className = "fxedit-builtin";
      const card = document.createElement("div");
      card.className = "fxedit-builtin-card";
      const label = document.createElement("span");
      label.textContent = "Built-in effect";
      const sep = document.createElement("span");
      sep.className = "fxedit-builtin-sep";
      card.append(
        label,
        sep,
        Button({
          label: "Duplicate",
          icon: "sparkles",
          onClick: async () => {
            const nid = await effectStore.duplicate(effectId);
            if (nid) router.navigate(`/effects/edit/${nid}`);
          },
        }),
      );
      banner.appendChild(card);
      codeWrap.appendChild(banner);
    }

    try {
      const defaultMapId = await populateMapPicker();
      await selectMap(defaultMapId ?? "__fixture__");
    } catch (e) {
      // A preview/map hiccup must not disable the rest of the editor.
      console.error("effect editor: preview/map init failed", e);
      toast("Preview unavailable — editing still works", { error: true });
    }

    refreshDevice();
    // Offline video preview (FUG-39): stream the Video panel's frames into the
    // live preview VM, so camera/file input maps onto the effect's texture with
    // no hardware. `preview`/`currentMap` are captured mutably (both are swapped
    // on recompile / map change), so the adapter always targets the current VM.
    videoPanel.setPreview({
      setTexture: (texIndex, w, h, rgba) => {
        if (preview && currentMap) preview.setTexture(texIndex, w, h, rgba, currentMap.leds.length);
      },
    });
    layout.mount();
    resizePreviewCanvas();
    unsubAppState = appState.subscribe(() => refreshDevice());
    // Start routing MIDI into the uniform seam (moves the panel + preview +
    // device). Enabling access is a separate, user-gesture step in the MIDI pane.
    midiRouter.attach();

    raf = requestAnimationFrame(tick);
    scheduleCompile();
  }

  // Wire editor interactions SYNCHRONOUSLY (not inside the async load(), whose
  // awaits — map picker / preview — could throw and skip attachment, leaving the
  // textarea "dead": edits wouldn't repaint the backdrop and scroll wouldn't sync.
  codeEl.addEventListener("input", () => {
    paintHighlight();
    syncScroll();
    scheduleCompile();
    scheduleSave();
    schedulePopup();
  });
  codeEl.addEventListener("scroll", syncScroll);
  codeEl.addEventListener("keydown", (ev) => {
    if (popupKeydown(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    // Shift+Alt+F → auto-format (VS Code convention).
    if (ev.altKey && ev.shiftKey && (ev.key === "F" || ev.key === "f")) {
      ev.preventDefault();
      formatCode();
    }
  });
  codeEl.addEventListener("keyup", (ev) => {
    if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(ev.key)) return;
    schedulePopup();
  });
  codeEl.addEventListener("blur", () => closePopup());
  document.addEventListener("selectionchange", onSelectionChange);

  return {
    el,
    onMount: () => {
      // Lock document scroll while the editor is mounted. The editor root is
      // pinned to the layout viewport (position: fixed) so the soft keyboard
      // OVERLAYS instead of reflowing the layout — but the <html>/<body> can
      // still scroll behind it, so we freeze them too. Removed on unmount.
      document.documentElement.classList.add("is-locked");
      document.body.classList.add("is-locked");
      void load();
    },
    onUnmount: () => {
      disposed = true;
      document.documentElement.classList.remove("is-locked");
      document.body.classList.remove("is-locked");
      closeMenu();
      closePopup();
      document.removeEventListener("selectionchange", onSelectionChange);
      if (raf) cancelAnimationFrame(raf);
      if (compileTimer !== null) clearTimeout(compileTimer);
      if (saveTimer !== null) clearTimeout(saveTimer);
      if (popupTimer !== null) clearTimeout(popupTimer);
      void effectStore.save(effectId, codeEl.value);
      unsubAppState?.();
      midiRouter.detach();
      midiPanel.dispose();
      videoPanel.dispose();
      layout.unmount();
      preview?.dispose();
      worker.dispose();
      mapView?.stop();
      mapView = null;
    },
  };
}
