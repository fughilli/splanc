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

import type { OutputMap } from "@ledmapper/protocol";
import { FxPreview, type FxUniform } from "../../fx/preview";
import { MapView } from "../mapview";
import { generateFixture } from "../../effects/fixtures";
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
import { effectStore } from "../../store/effectStore";
import { mapStore } from "../../store/mapStore";
import { appState } from "../app/state";
import { Button, Card, Field, IconButton, toast } from "../kit";
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
  let lastT = 0;
  let frame = 0;
  let startT = 0;
  let compileTimer: number | null = null;
  let saveTimer: number | null = null;
  let compileSeq = 0;
  // Latest successful-compile artefacts, fed to the AI as turn context.
  let lastCompileSummary = "not compiled yet";
  let lastDisassembly = "";
  let showDisassembly = false;
  let chatBusy = false;
  const chatHistory: ChatMessage[] = [];
  let raf = 0;
  let disposed = false;

  // -- DOM ------------------------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.className = "fxedit-canvas";
  canvas.width = 640;
  canvas.height = 420;

  const nameField = Field({ label: "Effect name", placeholder: "My effect" });
  nameField.el.classList.add("fxedit-name");
  nameField.input.addEventListener("change", () => {
    void effectStore.rename(effectId, nameField.input.value.trim() || "Untitled effect");
  });

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
  const disasmCard = Card();
  disasmCard.classList.add("fxedit-disasm-card");
  disasmCard.style.display = "none";
  const disasmHead = document.createElement("div");
  disasmHead.className = "fxedit-legend";
  disasmHead.textContent = "Disassembly (.fxb)";
  const disasmPre = document.createElement("pre");
  disasmPre.className = "fxedit-disasm";
  disasmCard.append(disasmHead, disasmPre);

  function refreshDisasmVisibility(): void {
    disasmCard.style.display = showDisassembly ? "" : "none";
  }

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

  const chatInput = document.createElement("textarea");
  chatInput.className = "fxedit-ask";
  chatInput.rows = 2;
  chatInput.placeholder = "e.g. make it a gentle blue breathing along the trunk";
  const chatSend = Button({
    label: "Send",
    icon: "sparkles",
    onClick: () => void runChat(),
  });
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

  // -- device section -------------------------------------------------------
  const devStatus = document.createElement("div");
  devStatus.className = "fxedit-muted";
  const sendBtn = Button({ label: "Send to device", icon: "upload", onClick: () => void sendToDevice() });
  const hydrateBtn = Button({ label: "Load uniforms", icon: "download", variant: "quiet", onClick: () => void hydrateFromDevice() });

  function refreshDevice(): void {
    const connected = appState.client?.isConnected ?? false;
    sendBtn.disabled = !connected;
    hydrateBtn.disabled = !connected;
    if (!connected) devStatus.textContent = "Connect a device (tap the status pill) to send this effect.";
  }

  // -- editor header + ⋯ overflow menu --------------------------------------
  // The Shell owns the app bar and only exposes setChrome(); to keep all key
  // config out of the editor BODY we add an editor-local header row with a ⋯
  // kebab whose menu holds "AI key…" and the disassembly toggle.
  const header = document.createElement("div");
  header.className = "fxedit-header";
  const headerTitle = document.createElement("div");
  headerTitle.className = "fxedit-header-title";
  headerTitle.textContent = "Effect editor";
  const kebab = IconButton("more", { title: "Editor menu", onClick: () => toggleMenu() });
  header.append(headerTitle, kebab);

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
    miDisasm.textContent = showDisassembly ? "Hide disassembly" : "Show disassembly";
  }
  syncDisasmLabel();
  miDisasm.addEventListener("click", () => {
    showDisassembly = !showDisassembly;
    syncDisasmLabel();
    refreshDisasmVisibility();
    closeMenu();
  });
  menu.append(miKey, miDisasm);
  header.appendChild(menu);

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
    if (rec) loadMap(rec.map);
    else loadMap(generateFixture("tree", { count: 160, seed: 3, jitterFrac: 0.06 }));
  }

  function loadMap(map: OutputMap): void {
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
    const thinking = appendChat("assistant", "thinking…");

    try {
      const finalText = await chatTurn(chatHistory, {
        onSetScript: async (source) => {
          appendChat("tool", "· applied script + compiling…");
          codeEl.value = source;
          paintHighlight();
          syncScroll();
          scheduleSave();
          await compileNow();
          return `Compile result: ${lastCompileSummary}${
            lastDisassembly ? `\n\nDisassembly:\n${lastDisassembly}` : ""
          }`;
        },
        onCapturePreview: async () => {
          appendChat("tool", "· captured preview");
          return capturePreviewPng();
        },
        onToolUse: () => undefined,
      });
      thinking.textContent = finalText || "(done)";
    } catch (e) {
      thinking.textContent = `AI error: ${msg(e)}`;
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
  function fieldset(legend: string, ...children: (Node | string)[]): HTMLElement {
    const wrap = Card();
    const h = document.createElement("div");
    h.className = "fxedit-legend";
    h.textContent = legend;
    wrap.append(h, ...children);
    return wrap;
  }

  function buttonRow(...btns: HTMLElement[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "fxedit-btnrow";
    row.append(...btns);
    return row;
  }

  const mapRow = document.createElement("label");
  mapRow.className = "fxedit-fieldrow";
  const mapCap = document.createElement("span");
  mapCap.textContent = "Preview map";
  mapRow.append(mapCap, mapPicker);

  el.append(
    header,
    canvas,
    nameField.el,
    editorWrap,
    disasmCard,
    fieldset("Preview", mapRow),
    fieldset("AI chat", chatLog, chatInput, buttonRow(chatSend)),
    fieldset("Uniforms", uniformsHost),
    fieldset("Diagnostics", diagsEl),
    fieldset("Device", buttonRow(sendBtn, hydrateBtn), devStatus),
  );

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
    nameField.input.value = rec.name;
    codeEl.value = rec.source;
    paintHighlight();

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
    refreshDisasmVisibility();
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
    onMount: () => void load(),
    onUnmount: () => {
      disposed = true;
      closeMenu();
      closePopup();
      document.removeEventListener("selectionchange", onSelectionChange);
      if (raf) cancelAnimationFrame(raf);
      if (compileTimer !== null) clearTimeout(compileTimer);
      if (saveTimer !== null) clearTimeout(saveTimer);
      if (popupTimer !== null) clearTimeout(popupTimer);
      void effectStore.save(effectId, codeEl.value);
      unsubAppState?.();
      preview?.dispose();
      worker.dispose();
      mapView?.stop();
      mapView = null;
    },
  };
}
