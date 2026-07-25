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
 *     capture_preview vision) against api.anthropic.com (BYO key).
 *  5. Key config + disassembly toggle moved into a ⋯ overflow menu in the
 *     editor header (out of the main body).
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { FxPreview, deriveLedTopology, type FxUniform, type LedTopology } from "../../fx/preview";
import { MapView } from "../mapview";
import { generateFixture } from "../../effects/fixtures";
import { extractTopology } from "../../topology/extract";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { UniformPanel } from "../../effects/editor/uniform-panel";
import { highlight } from "../../effects/editor/highlight";
import { complete, type CompletionItem } from "../../effects/editor/completions";
import {
  chatTurn,
  editorContext,
  getApiKey,
  type ChatMessage,
} from "../../effects/ai/generate";
import { effectStore, isBuiltinEffect } from "../../store/effectStore";
import { mapStore } from "../../store/mapStore";
import { appState } from "../app/state";
import { Button, IconButton, icon, toast } from "../kit";
import { FxLayout } from "../../effects/editor/layout";
import { openAiKeySheet } from "./aiKeySheet";
import type { Router, Screen } from "../app/router";

const COMPILE_DEBOUNCE_MS = 300;
const SAVE_DEBOUNCE_MS = 800;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function EffectEditorScreen(router: Router, effectId: string): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--fxedit";

  // -- live state -----------------------------------------------------------
  const worker = new FxCompilerWorker();
  let currentMap: OutputMap | null = null;
  let mapView: MapView | null = null;
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
  const statusEl = document.createElement("div");
  statusEl.className = "fxedit-status";
  editorWrap.append(codeWrap, statusEl);

  function setStatusCompiling(): void {
    statusEl.className = "fxedit-status fxedit-status--busy";
    statusEl.replaceChildren();
    const spin = document.createElement("span");
    spin.className = "fxedit-spinner";
    const txt = document.createElement("span");
    txt.textContent = "compiling…";
    statusEl.append(spin, txt);
  }
  function setStatusOk(text: string): void {
    statusEl.className = "fxedit-status fxedit-status--ok";
    statusEl.textContent = `✓ ${text}`;
  }
  function setStatusErr(text: string): void {
    statusEl.className = "fxedit-status fxedit-status--err";
    statusEl.textContent = `✕ ${text}`;
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
    if (c?.isConnected) void c.setUniforms([{ slot, value }]).catch(() => undefined);
  });

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
    row.textContent = text;
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
  const sendBtn = Button({ label: "Send to device", icon: "effect-to-device", onClick: () => void sendToDevice() });
  const hydrateBtn = Button({ label: "Load uniforms", icon: "effect-from-device", variant: "quiet", onClick: () => void hydrateFromDevice() });

  function refreshDevice(): void {
    const connected = appState.client?.isConnected ?? false;
    sendBtn.disabled = !connected;
    hydrateBtn.disabled = !connected;
    if (!connected) devStatus.textContent = "Connect a device (tap the status pill) to send this effect.";
  }

  // -- floating chrome + ⋯ overflow menu ------------------------------------
  // The editor route runs under the Shell's OVERLAY chrome (app-bar + tab-bar
  // hidden), so all controls live in small, semi-transparent clusters that
  // OVERLAY the workspace corners instead of pushing layout:
  //   • top-left:  floating Back button + the inline-editable name pill
  //   • top-right: a floating ⋯ overflow menu (AI key…, disasm toggle)
  const floatL = document.createElement("div");
  floatL.className = "fxedit-float fxedit-float--l";
  const backBtn = IconButton("back", { title: "Back to effects", onClick: () => router.navigate("/effects") });
  backBtn.classList.add("fxedit-floatbtn");
  floatL.append(backBtn, nameLabel, nameInput);

  const floatR = document.createElement("div");
  floatR.className = "fxedit-float fxedit-float--r";
  const kebab = IconButton("more", { title: "Editor menu", onClick: () => toggleMenu() });
  kebab.classList.add("fxedit-floatbtn");
  floatR.appendChild(kebab);

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
  const miDisasm = document.createElement("button");
  miDisasm.type = "button";
  miDisasm.className = "fxedit-menu-item";
  function syncDisasmLabel(): void {
    miDisasm.textContent = layout.isVisible("disasm") ? "Hide disassembly" : "Show disassembly";
  }
  miDisasm.addEventListener("click", () => {
    layout.setVisible("disasm", !layout.isVisible("disasm"));
    syncDisasmLabel();
    closeMenu();
  });
  const miReset = document.createElement("button");
  miReset.type = "button";
  miReset.className = "fxedit-menu-item";
  miReset.textContent = "Reset layout";
  miReset.addEventListener("click", () => {
    layout.resetLayout();
    syncDisasmLabel(); // reset re-hides disassembly
    closeMenu();
  });
  menu.append(miKey, miDisasm, miReset);
  floatR.appendChild(menu);

  let menuOpen = false;
  function toggleMenu(): void {
    if (menuOpen) closeMenu();
    else openMenu();
  }
  function openMenu(): void {
    menuOpen = true;
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
  const mapPicker = document.createElement("select");
  mapPicker.className = "fxedit-mappick";

  async function populateMapPicker(): Promise<string | null> {
    const maps = await mapStore.list({ sort: "updated" });
    mapPicker.replaceChildren();
    const fixtureOpt = document.createElement("option");
    fixtureOpt.value = "__fixture__";
    fixtureOpt.textContent = "Sample fixture (tree)";
    mapPicker.appendChild(fixtureOpt);
    for (const m of maps) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.name;
      mapPicker.appendChild(o);
    }
    return appState.selectedMapId ?? maps[0]?.id ?? null;
  }

  mapPicker.addEventListener("change", () => void selectMap(mapPicker.value));

  async function selectMap(id: string): Promise<void> {
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
      disasmPre.textContent = "";
      return;
    }
    setStatusOk(`compiled · ${r.uniforms.length} uniforms · ${r.bytecode.length} bytes`);
    lastCompileSummary = `OK — ${r.uniforms.length} uniforms, ${r.bytecode.length} bytes`;
    panel.setManifest(r.uniforms);
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
    if (chatBusy) return;
    if (!getApiKey()) {
      // No key yet — prompt via the same sheet the ⋯ menu opens.
      openAiKeySheet();
      return;
    }
    const ask = chatInput.value.trim();
    if (!ask) return;
    chatInput.value = "";
    appendChat("user", ask);

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

    try {
      const finalText = await chatTurn(chatHistory, {
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
        onToolUse: () => undefined,
      });
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
  async function sendToDevice(): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    const r = await worker.compile(codeEl.value);
    if (!r.ok) {
      devStatus.textContent = "Fix compile errors before sending.";
      return;
    }
    devStatus.textContent = "Uploading…";
    try {
      await c.submitEffect(effectId, r.bytecode, true);
      if (panel.values().length > 0) await c.setUniforms(panel.values());
      devStatus.textContent = "Sent · effect active.";
    } catch (e) {
      devStatus.textContent = `upload failed: ${msg(e)}`;
    }
  }

  async function hydrateFromDevice(): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    try {
      const r = await c.getEffectUniforms();
      panel.hydrate(r.current.map((x) => ({ slot: x.slot, value: x.value })));
      for (const { slot, value } of r.current) preview?.setUniform(slot, value);
      devStatus.textContent = "Loaded uniforms from device.";
    } catch (e) {
      devStatus.textContent = `load failed: ${msg(e)}`;
    }
  }

  // -- layout ---------------------------------------------------------------
  function buttonRow(...btns: HTMLElement[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "fxedit-btnrow";
    row.append(...btns);
    return row;
  }

  // Grid / Triad segmented toggle for the preview (same feature Map Detail
  // exposes). Flips mapView.showGrid / showTriad; safe before mapView exists.
  function viewToggle(label: string, apply: (on: boolean) => void): HTMLButtonElement {
    let on = false;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toggle-chip";
    b.textContent = label;
    b.addEventListener("click", () => {
      on = !on;
      b.classList.toggle("toggle-chip--on", on);
      apply(on);
    });
    return b;
  }

  const mapRow = document.createElement("label");
  mapRow.className = "fxedit-fieldrow";
  const mapCap = document.createElement("span");
  mapCap.textContent = "Preview map";
  mapRow.append(mapCap, mapPicker);

  const viewToggles = document.createElement("div");
  viewToggles.className = "fxedit-viewtoggles";
  viewToggles.append(
    viewToggle("Grid", (v) => {
      if (mapView) mapView.showGrid = v;
    }),
    viewToggle("Triad", (v) => {
      if (mapView) mapView.showTriad = v;
    }),
  );

  // Preview pane content: canvas + its controls. The canvas node is STABLE —
  // it's created once and only re-parented, so MapView keeps drawing to it.
  const previewBody = document.createElement("div");
  previewBody.className = "fxedit-previewbody";
  const previewControls = document.createElement("div");
  previewControls.className = "fxedit-previewctl";
  previewControls.append(viewToggles, mapRow);
  previewBody.append(canvas, previewControls);

  // Chat pane content.
  const chatBody = document.createElement("div");
  chatBody.className = "fxedit-chatbody";
  chatBody.append(chatLog, chatInputWrap);

  // Diagnostics pane content (diags list + device controls live together — both
  // are "status" surfaces the user consults, not primary editing views).
  const diagBody = document.createElement("div");
  diagBody.className = "fxedit-diagbody";
  const devLegend = document.createElement("div");
  devLegend.className = "fxedit-legend";
  devLegend.textContent = "Device";
  diagBody.append(diagsEl, devLegend, buttonRow(sendBtn, hydrateBtn), devStatus);

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
      { id: "diagnostics", title: "Diagnostics", node: diagBody },
      { id: "disasm", title: "Disassembly", node: disasmBody },
      { id: "chat", title: "AI chat", node: chatBody },
    ],
    onRelayout: () => {
      // A resize/relayout changes the canvas box; keep the preview crisp.
      resizePreviewCanvas();
    },
  });
  // The layout fills the workspace; the floating control clusters overlay it.
  el.append(layout.root, floatL, floatR);

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
      const banner = document.createElement("div");
      banner.className = "fxedit-builtin";
      const label = document.createElement("span");
      label.textContent = "Built-in effect — read-only";
      banner.append(
        label,
        Button({
          label: "Duplicate to edit",
          icon: "sparkles",
          onClick: async () => {
            const nid = await effectStore.duplicate(effectId);
            if (nid) router.navigate(`/effects/edit/${nid}`);
          },
        }),
      );
      el.appendChild(banner);
    }

    try {
      const defaultMapId = await populateMapPicker();
      mapPicker.value = defaultMapId ?? "__fixture__";
      await selectMap(mapPicker.value);
    } catch (e) {
      // A preview/map hiccup must not disable the rest of the editor.
      console.error("effect editor: preview/map init failed", e);
      toast("Preview unavailable — editing still works", { error: true });
    }

    refreshDevice();
    layout.mount();
    syncDisasmLabel();
    resizePreviewCanvas();
    unsubAppState = appState.subscribe(() => refreshDevice());

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
      layout.unmount();
      preview?.dispose();
      worker.dispose();
      mapView?.stop();
      mapView = null;
    },
  };
}
