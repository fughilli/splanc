/**
 * "What's new?" — the sparkle bubble and the release-notes card.
 *
 * After an update the app does NOT pop the notes over the screen. On the first
 * launch of a new version (for the PWA: the pull-to-refresh that loaded a new
 * deploy, since navigations are network-first in sw.js) a small sparkle bubble
 * sits in the lower-left corner, exactly where the tour's first-run hint sits.
 * Tapping it opens the card with the notes of every version since the one last
 * seen. The bubble goes away once the card is opened, and is never shown again
 * for that version (the version is recorded at launch). A fresh install shows
 * no bubble: that launch belongs to the tour hint. The card is always reachable
 * from About → "What's new" under the version number.
 *
 * Notes come from `whatsnew/index.json` beside the app (mirrored from the
 * GitHub releases at deploy time; see ./model.ts). The native iOS shell bundles
 * the app without them, so it falls back to splanc.io's copy.
 */

import { assetUrl } from "../../assetBase";
import { appBuildInfo } from "../../buildInfo";
import { isNativePlatform } from "../../net/native";
import { Button, Sheet, icon } from "../kit";
import { installHintStyles } from "../guide/tour";
import {
  WHATS_NEW_STORAGE_KEY,
  cardContent,
  deserializeWhatsNewState,
  parseIndex,
  planBoot,
  serializeWhatsNewState,
  type CardMode,
  type NoteNode,
  type ReleaseNotes,
  type WhatsNewIndex,
  type WhatsNewState,
} from "./model";

const TOUR_STORAGE_KEY = "ledmapper.tour";
/** Where the native shell (no mirrored notes in its bundle) reads them from. */
const PUBLIC_INDEX_URL = "https://splanc.io/app/whatsnew/index.json";
const RELEASES_URL = "https://github.com/fughilli/splanc/releases";

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadState(): WhatsNewState {
  return deserializeWhatsNewState(readStore(WHATS_NEW_STORAGE_KEY));
}

function saveState(s: WhatsNewState): void {
  try {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, serializeWhatsNewState(s));
  } catch {
    /* storage blocked: the bubble may show again next launch, which is harmless */
  }
}

// -- loading ------------------------------------------------------------------

interface LoadedIndex {
  index: WhatsNewIndex;
  /** index.json's own URL; media paths resolve against it. */
  base: string;
}

let loading: Promise<LoadedIndex | null> | null = null;

async function fetchIndex(url: string): Promise<LoadedIndex | null> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) return null;
  const index = parseIndex(await res.json());
  return index ? { index, base: res.url || url } : null;
}

/** The mirrored notes, fetched once per session (null when this deploy has none,
 * e.g. a local dev build, or offline before they were ever cached). */
export function loadWhatsNew(): Promise<LoadedIndex | null> {
  loading ??= (async () => {
    const candidates = [assetUrl("whatsnew/index.json")];
    if (isNativePlatform()) candidates.push(PUBLIC_INDEX_URL);
    for (const url of candidates) {
      try {
        const got = await fetchIndex(url);
        if (got) return got;
      } catch {
        /* try the next source */
      }
    }
    loading = null; // let a later open retry (e.g. back online)
    return null;
  })();
  return loading;
}

// -- rendering ----------------------------------------------------------------

/** Note headings sit under the card's per-release heading (h3). */
const HEADING_MAP: Record<string, string> = { h1: "h4", h2: "h4", h3: "h5", h4: "h6", h5: "h6", h6: "h6" };

/** Build DOM for sanitized notes. createElement + textContent only, never
 * innerHTML; attributes are the allowlisted ones parseIndex kept. */
export function renderNotes(nodes: NoteNode[], base: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    if (typeof n === "string") {
      frag.appendChild(document.createTextNode(n));
      continue;
    }
    const el = document.createElement(HEADING_MAP[n.t] ?? n.t);
    const a = n.a ?? {};
    if (n.t === "a") {
      const link = el as HTMLAnchorElement;
      link.href = String(a.href);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else if (n.t === "img") {
      const img = el as HTMLImageElement;
      img.src = new URL(String(a.src), base).href;
      img.alt = typeof a.alt === "string" ? a.alt : "";
      img.loading = "lazy";
      img.decoding = "async";
      if (typeof a.width === "number") img.width = a.width;
      if (typeof a.height === "number") img.height = a.height;
    } else if (n.t === "video") {
      const v = el as HTMLVideoElement;
      v.src = new URL(String(a.src), base).href;
      if (typeof a.poster === "string") v.poster = new URL(a.poster, base).href;
      v.controls = true; // always: an uncontrollable video is an accessibility trap
      v.muted = a.muted === true;
      v.loop = a.loop === true;
      v.playsInline = true;
      v.preload = "metadata";
      if (typeof a.width === "number") v.width = a.width;
    } else if (n.t === "ol" && typeof a.start === "number") {
      (el as HTMLOListElement).start = a.start;
    } else if (n.t === "details" && a.open === true) {
      (el as HTMLDetailsElement).open = true;
    }
    if (n.c) el.appendChild(renderNotes(n.c, base));
    frag.appendChild(el);
  }
  return frag;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function releaseSection(r: ReleaseNotes, base: string, label: string, headingId?: string): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "wn-release";
  const head = document.createElement("div");
  head.className = "wn-release-head";
  const h = document.createElement("h3");
  h.className = "wn-release-title";
  h.textContent = `${label} ${r.version}`;
  if (headingId) h.id = headingId;
  const date = document.createElement("span");
  date.className = "wn-release-date";
  date.textContent = formatDate(r.date);
  head.append(h, date);
  const notes = document.createElement("div");
  notes.className = "wn-notes";
  if (r.body.length) notes.appendChild(renderNotes(r.body, base));
  else notes.textContent = "No notes for this release.";
  sec.append(head, notes);
  if (r.url) {
    const more = document.createElement("a");
    more.className = "wn-release-link";
    more.href = r.url;
    more.target = "_blank";
    more.rel = "noopener noreferrer";
    more.textContent = "View on GitHub";
    sec.appendChild(more);
  }
  return sec;
}

function collapsed(summary: string, content: HTMLElement): HTMLDetailsElement {
  const d = document.createElement("details");
  d.className = "wn-collapsed";
  const s = document.createElement("summary");
  s.textContent = summary;
  d.append(s, content);
  return d;
}

function fillCard(body: HTMLElement, loaded: LoadedIndex | null, mode: CardMode): void {
  const current = appBuildInfo.version;
  const c = cardContent(loaded?.index ?? null, current, mode);
  const base = loaded?.base ?? assetUrl("whatsnew/index.json");
  const out: HTMLElement[] = [];
  if (c.missingCurrent && current) {
    const p = document.createElement("p");
    p.className = "wn-missing";
    p.append(`Release notes for Splanc ${current} aren't available here yet. `);
    const a = document.createElement("a");
    a.href = `${RELEASES_URL}/tag/app-v${current}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Read them on GitHub";
    p.append(a, ".");
    out.push(p);
  } else if (!loaded) {
    const p = document.createElement("p");
    p.className = "wn-missing";
    p.append("No release notes in this build. ");
    const a = document.createElement("a");
    a.href = RELEASES_URL;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "See all releases on GitHub";
    p.append(a, ".");
    out.push(p);
  }
  c.primary.forEach((r, i) => out.push(releaseSection(r, base, "Splanc", i === 0 ? "wn-first" : undefined)));
  if (c.firmware.length) {
    const fw = document.createElement("div");
    fw.className = "wn-firmware";
    for (const r of c.firmware) fw.appendChild(releaseSection(r, base, "Firmware"));
    const label = c.firmware.length === 1 ? `Firmware ${c.firmware[0]!.version}` : `Firmware (${c.firmware.length} releases)`;
    out.push(collapsed(label, fw));
  }
  if (c.earlier.length) {
    const list = document.createElement("div");
    for (const r of c.earlier) list.appendChild(releaseSection(r, base, "Splanc"));
    out.push(collapsed(`Earlier releases (${c.earlier.length})`, list));
  }
  body.replaceChildren(...out);
}

let openCard: { close: () => void } | null = null;

/**
 * Open the "What's new?" card. `mode` picks the notes (see cardContent);
 * focus moves into the card and returns to `opener` when it closes.
 */
export function openWhatsNew(mode: CardMode = { kind: "history" }, opener?: HTMLElement | null): void {
  if (openCard) return;
  installWhatsNewStyles();
  const returnFocus = opener ?? (document.activeElement as HTMLElement | null);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") sheet.close();
  };
  const sheet = Sheet("What's new", {
    onClose: () => {
      openCard = null;
      document.removeEventListener("keydown", onKey);
      if (returnFocus?.isConnected) returnFocus.focus();
    },
  });
  openCard = sheet;
  const panel = sheet.body.parentElement;
  if (panel) {
    panel.classList.add("wn-sheet");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const title = panel.querySelector(".k-sheet-head h2");
    if (title) {
      title.id = "wn-title";
      panel.setAttribute("aria-labelledby", "wn-title");
    }
  }
  document.addEventListener("keydown", onKey);
  sheet.body.className = "wn-body";
  const status = document.createElement("p");
  status.className = "wn-loading";
  status.textContent = "Loading release notes…";
  sheet.body.appendChild(status);
  const content = document.createElement("div");
  content.setAttribute("aria-live", "polite");
  const done = Button({ label: "Done", variant: "primary", block: true, onClick: () => sheet.close() });
  done.classList.add("wn-done");
  sheet.body.append(content, done);
  // Focus the close button first: a screen reader lands in the dialog and can
  // read on; Done closes it at the end.
  requestAnimationFrame(() => panel?.querySelector<HTMLElement>(".k-sheet-head button")?.focus());
  void loadWhatsNew().then((loaded) => {
    status.remove();
    fillCard(content, loaded, mode);
  });
}

// -- the sparkle bubble ---------------------------------------------------------

let bubbleEl: HTMLElement | null = null;

function removeBubble(): void {
  bubbleEl?.remove();
  bubbleEl = null;
}

function showBubble(since: string | null): void {
  if (bubbleEl || typeof document === "undefined") return;
  installHintStyles();
  installWhatsNewStyles();
  const anchor = document.createElement("div");
  // Same anchor as the tour's first-run hint: identical corner, size and style.
  anchor.className = "tour-hint-anchor wn-anchor";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "k-helptip-btn wn-bubble";
  const version = appBuildInfo.version ?? "";
  const label = `What's new in Splanc ${version}`.trim();
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-haspopup", "dialog");
  btn.appendChild(icon("sparkles"));
  btn.addEventListener("click", () => {
    removeBubble();
    openWhatsNew({ kind: "since", since });
  });
  anchor.appendChild(btn);
  document.body.appendChild(anchor);
  bubbleEl = anchor;
}

/**
 * Run once at launch, BEFORE the tour's first-run hint (which writes the tour
 * key this reads to tell an update from a fresh install). Returns true when the
 * sparkle bubble is showing — the caller then skips the tour hint, so the two
 * never share the corner: a fresh install gets the tour, an update the sparkle.
 */
export function initWhatsNew(opts: { suppressed: boolean }): boolean {
  if (typeof document === "undefined") return false;
  const plan = planBoot({
    state: loadState(),
    current: appBuildInfo.version,
    priorUse: readStore(TOUR_STORAGE_KEY) !== null,
    suppressed: opts.suppressed,
  });
  if (plan.save) saveState(plan.save);
  if (!plan.bubble) return false;
  showBubble(plan.since);
  // Warm the notes (and through the service worker, the offline cache).
  void loadWhatsNew();
  return true;
}

// -- styles -----------------------------------------------------------------------

let stylesInstalled = false;
function installWhatsNewStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
.wn-bubble { color: var(--accent); border-color: var(--accent); position: relative; }
.wn-bubble:hover, .wn-bubble:focus-visible { color: var(--text); background: var(--accent-quiet); }
.wn-bubble:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.wn-bubble::after {
  content: ""; position: absolute; inset: -1px; border-radius: 50%;
  box-shadow: 0 0 0 0 var(--accent); animation: wn-pulse 2.4s var(--ease) 3;
  pointer-events: none;
}
@keyframes wn-pulse { 0% { box-shadow: 0 0 0 0 var(--accent); opacity: .7; } 100% { box-shadow: 0 0 0 10px var(--accent); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .wn-bubble::after { animation: none; } }
.wn-sheet { max-width: 720px; margin: 0 auto; }
.wn-body { display: flex; flex-direction: column; gap: var(--sp-4); }
.wn-loading, .wn-missing { color: var(--text-dim); margin: 0; line-height: 1.5; }
.wn-release { display: flex; flex-direction: column; gap: var(--sp-2); }
.wn-release + .wn-release { border-top: 1px solid var(--border); padding-top: var(--sp-4); }
.wn-release-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
.wn-release-title { margin: 0; font-size: var(--f-title); color: var(--text); }
.wn-release-date { color: var(--text-dim); font-size: var(--f-caption); }
.wn-release-link { font-size: var(--f-caption); color: var(--accent); align-self: flex-start; }
.wn-notes { color: var(--text); font-size: var(--f-body); line-height: 1.5; overflow-wrap: anywhere; }
.wn-notes > :first-child { margin-top: 0; }
.wn-notes > :last-child { margin-bottom: 0; }
.wn-notes h4, .wn-notes h5, .wn-notes h6 { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--f-body); }
.wn-notes h6 { color: var(--text-dim); }
.wn-notes p { margin: var(--sp-2) 0; }
.wn-notes ul, .wn-notes ol { margin: var(--sp-2) 0; padding-left: 1.25rem; }
.wn-notes li + li { margin-top: var(--sp-1); }
.wn-notes a { color: var(--accent); }
.wn-notes img, .wn-notes video { display: block; max-width: 100%; height: auto; border-radius: var(--r-ctrl); border: 1px solid var(--border); background: var(--surface-2); margin: var(--sp-2) 0; }
.wn-notes code, .wn-notes kbd { font-family: var(--font-mono); font-size: 0.9em; background: var(--surface-2); border-radius: 4px; padding: 0 4px; }
.wn-notes pre { background: var(--surface-2); border-radius: var(--r-ctrl); padding: var(--sp-2) var(--sp-3); overflow-x: auto; }
.wn-notes pre code { background: none; padding: 0; }
.wn-notes blockquote { margin: var(--sp-2) 0; padding-left: var(--sp-3); border-left: 3px solid var(--border); color: var(--text-dim); }
.wn-notes table { border-collapse: collapse; display: block; overflow-x: auto; }
.wn-notes th, .wn-notes td { border: 1px solid var(--border); padding: var(--sp-1) var(--sp-2); }
.wn-collapsed { border: 1px solid var(--border); border-radius: var(--r-card); padding: var(--sp-2) var(--sp-3); }
.wn-collapsed > summary { cursor: pointer; color: var(--text); font-weight: 600; padding: var(--sp-1) 0; }
.wn-collapsed[open] > summary { margin-bottom: var(--sp-3); }
.wn-collapsed .wn-release-title { font-size: var(--f-body); }
.wn-done { margin-top: var(--sp-2); }
`;
  document.head.appendChild(style);
}
