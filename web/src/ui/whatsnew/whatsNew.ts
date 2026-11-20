/**
 * "What's new?" — the sparkle bubble and the release-notes card.
 *
 * After an update the app does NOT pop the notes over the screen. On the first
 * launch of a new version (for the PWA: the pull-to-refresh that loaded a new
 * deploy, since navigations are network-first in sw.js) a small sparkle bubble
 * sits in the lower-left corner, exactly where the tour's first-run hint sits.
 * Tapping it opens the card on the Splanc app's notes, scrolled to the newest,
 * with every version since the one last seen marked "New". The bubble goes away
 * once the card is opened, and is never shown again for that version (the
 * version is recorded at launch). A fresh install shows no bubble: that launch
 * belongs to the tour hint. The card is always reachable from About → "What's
 * new" under the version number (opening on the product last picked).
 *
 * The card: a product dropdown (Splanc app, Firmware, Bridge, …) and a "Jump
 * to…" version picker in a bar pinned to the top, then ONE long scroll of every
 * release of that product, newest first. Notes come from `whatsnew/index.json`
 * + `whatsnew/<product>.json` beside the app (mirrored from the GitHub
 * releases at deploy time; see ./model.ts); a product's file is fetched when it
 * is first picked. The native iOS shell bundles the app without them, so it
 * falls back to splanc.io's copy.
 */

import { assetUrl } from "../../assetBase";
import { appBuildInfo } from "../../buildInfo";
import { isNativePlatform } from "../../net/native";
import { Button, Sheet, icon } from "../kit";
import { installHintStyles } from "../guide/tour";
import {
  APP_PRODUCT,
  WHATS_NEW_STORAGE_KEY,
  deserializeWhatsNewState,
  jumpTargets,
  parseIndex,
  parseProductNotes,
  pickProduct,
  planBoot,
  productHistory,
  releaseAnchor,
  serializeWhatsNewState,
  type CardMode,
  type NoteNode,
  type ProductInfo,
  type ReleaseNotes,
  type WhatsNewIndex,
  type WhatsNewState,
} from "./model";

const TOUR_STORAGE_KEY = "ledmapper.tour";
/** The product last picked in the card's dropdown (About reopens on it). */
const PRODUCT_STORAGE_KEY = "splanc.whatsnew.product";
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

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: nothing to remember it by, which is harmless */
  }
}

function loadState(): WhatsNewState {
  return deserializeWhatsNewState(readStore(WHATS_NEW_STORAGE_KEY));
}

function saveState(s: WhatsNewState): void {
  // Storage blocked: the bubble may show again next launch, which is harmless.
  writeStore(WHATS_NEW_STORAGE_KEY, serializeWhatsNewState(s));
}

// -- loading ------------------------------------------------------------------

interface LoadedIndex {
  index: WhatsNewIndex;
  /** index.json's own URL; product files and media paths resolve against it. */
  base: string;
}

let loading: Promise<LoadedIndex | null> | null = null;
/** Per product id: its notes, fetched once per session. */
const productNotes = new Map<string, Promise<ReleaseNotes[] | null>>();

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

/** One product's releases (newest first): inline in a schema-1 index, else its
 * `<product>.json`, fetched on first use. null when it can't be had (offline
 * and never cached); a later call retries. */
function loadProductNotes(loaded: LoadedIndex, product: ProductInfo): Promise<ReleaseNotes[] | null> {
  if (product.releases) return Promise.resolve(product.releases);
  const file = product.file;
  if (!file) return Promise.resolve(null);
  let p = productNotes.get(product.id);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(new URL(file, loaded.base).href, { cache: "no-cache" });
        const notes = res.ok ? parseProductNotes(await res.json(), product.id) : null;
        if (!notes) productNotes.delete(product.id);
        return notes;
      } catch {
        productNotes.delete(product.id);
        return null;
      }
    })();
    productNotes.set(product.id, p);
  }
  return p;
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

function externalLink(href: string, text: string, className?: string): HTMLAnchorElement {
  const a = document.createElement("a");
  if (className) a.className = className;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

function releaseSection(product: ProductInfo, r: ReleaseNotes, base: string, fresh: boolean): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "wn-release";
  sec.id = releaseAnchor(product.id, r.version);
  const head = document.createElement("div");
  head.className = "wn-release-head";
  const h = document.createElement("h3");
  h.className = "wn-release-title";
  h.tabIndex = -1; // "Jump to…" moves focus here
  h.textContent = `${product.label} ${r.version}`;
  sec.setAttribute("aria-labelledby", (h.id = `${sec.id}-h`));
  if (fresh || r.prerelease) {
    const tag = document.createElement("span");
    tag.className = fresh ? "wn-tag wn-tag--new" : "wn-tag";
    tag.textContent = fresh ? "New" : "Pre-release";
    h.append(" ", tag);
  }
  const date = document.createElement("span");
  date.className = "wn-release-date";
  date.textContent = formatDate(r.date);
  head.append(h, date);
  const notes = document.createElement("div");
  notes.className = "wn-notes";
  if (r.body.length) notes.appendChild(renderNotes(r.body, base));
  else notes.textContent = "No notes for this release.";
  sec.append(head, notes);
  if (r.url) sec.appendChild(externalLink(r.url, "View on GitHub", "wn-release-link"));
  return sec;
}

function notice(...parts: (string | Node)[]): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "wn-missing";
  p.append(...parts);
  return p;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let openCard: { close: () => void } | null = null;

/**
 * Open the "What's new?" card. "since" (the sparkle) opens on the Splanc app
 * with the versions since `since` marked new; "history" (About) opens on the
 * product last picked. Either way the list starts at the top (newest). Focus
 * moves into the card and returns to `opener` when it closes.
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
  const panel = sheet.body.parentElement; // .k-sheet: the one long scroll view
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

  // The pinned bar: product dropdown + "Jump to…" version picker.
  const bar = document.createElement("div");
  bar.className = "wn-bar";
  const pick = (aria: string): HTMLSelectElement => {
    const wrap = document.createElement("div");
    wrap.className = "k-field wn-field";
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", aria);
    sel.disabled = true;
    wrap.appendChild(sel);
    bar.appendChild(wrap);
    return sel;
  };
  const productSel = pick("Product");
  const jumpSel = pick("Jump to version");
  const content = document.createElement("div");
  content.className = "wn-list";
  content.setAttribute("aria-live", "polite");
  content.setAttribute("aria-busy", "true");
  content.appendChild(notice("Loading release notes…"));
  const foot = document.createElement("div");
  foot.className = "wn-foot";
  foot.appendChild(externalLink(RELEASES_URL, "All releases on GitHub", "wn-release-link"));
  const done = Button({ label: "Done", variant: "primary", block: true, onClick: () => sheet.close() });
  done.classList.add("wn-done");
  foot.appendChild(done);
  sheet.body.append(bar, content, foot);
  // Focus the close button first: a screen reader lands in the dialog and can
  // read on; Done closes it at the end.
  requestAnimationFrame(() => panel?.querySelector<HTMLElement>(".k-sheet-head button")?.focus());

  const scrollTo = (el: HTMLElement | null): void => {
    if (!panel) return;
    const top = el
      ? el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - bar.offsetHeight - 8
      : 0;
    panel.scrollTo({ top: Math.max(0, top), behavior: el && !prefersReducedMotion() ? "smooth" : "auto" });
  };

  let generation = 0;
  const show = async (loaded: LoadedIndex, product: ProductInfo): Promise<void> => {
    const gen = ++generation;
    jumpSel.disabled = true;
    content.setAttribute("aria-busy", "true");
    content.replaceChildren(notice(`Loading ${product.name} release notes…`));
    const notes = await loadProductNotes(loaded, product);
    if (gen !== generation || !sheet.body.isConnected) return; // switched again / closed
    const current = appBuildInfo.version;
    const hist = productHistory(product.id, notes ?? [], current, mode);
    const out: HTMLElement[] = [];
    if (!notes) {
      out.push(notice(`Couldn't load the ${product.name} release notes. `, externalLink(RELEASES_URL, "See them on GitHub"), "."));
    } else if (hist.missingCurrent && current) {
      out.push(
        notice(
          `Release notes for Splanc ${current} aren't available here yet. `,
          externalLink(`${RELEASES_URL}/tag/app-v${current}`, "Read them on GitHub"),
          ".",
        ),
      );
    }
    for (const r of hist.releases) out.push(releaseSection(product, r, loaded.base, hist.fresh.has(r.version)));
    content.replaceChildren(...out);
    content.setAttribute("aria-busy", "false");
    const placeholder = new Option("Jump to…", "");
    placeholder.disabled = true;
    const targets = jumpTargets(product.id, hist);
    jumpSel.replaceChildren(
      placeholder,
      ...targets.map((t, i) => {
        const date = formatDate(hist.releases[i]?.date ?? null);
        return new Option(date ? `${t.label} · ${date}` : t.label, t.anchor);
      }),
    );
    jumpSel.value = "";
    jumpSel.disabled = targets.length === 0;
    scrollTo(null); // newest at the top
  };

  void loadWhatsNew().then((loaded) => {
    if (!sheet.body.isConnected) return;
    const wanted = mode.kind === "since" ? APP_PRODUCT : readStore(PRODUCT_STORAGE_KEY);
    const first = pickProduct(loaded?.index ?? null, wanted);
    if (!loaded || !first) {
      content.setAttribute("aria-busy", "false");
      content.replaceChildren(
        notice("No release notes in this build. ", externalLink(RELEASES_URL, "See all releases on GitHub"), "."),
      );
      bar.hidden = true;
      return;
    }
    const products = loaded.index.products;
    productSel.replaceChildren(...products.map((p) => new Option(p.name, p.id)));
    productSel.value = first.id;
    productSel.disabled = products.length < 2;
    productSel.addEventListener("change", () => {
      const p = products.find((x) => x.id === productSel.value);
      if (!p) return;
      writeStore(PRODUCT_STORAGE_KEY, p.id);
      void show(loaded, p);
    });
    jumpSel.addEventListener("change", () => {
      const target = jumpSel.value ? document.getElementById(jumpSel.value) : null;
      jumpSel.value = ""; // back to "Jump to…": the same version can be picked again
      if (!target) return;
      scrollTo(target);
      target.querySelector<HTMLElement>(".wn-release-title")?.focus({ preventScroll: true });
    });
    void show(loaded, first);
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
.wn-body { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
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
.wn-bar {
  position: sticky; top: calc(-1 * var(--sp-4)); z-index: 1;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sp-2);
  margin: 0 calc(-1 * var(--sp-4)); padding: var(--sp-2) var(--sp-4) var(--sp-3);
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.wn-bar[hidden] { display: none; }
.wn-field { margin: 0; min-width: 0; }
.wn-field select { min-width: 0; text-overflow: ellipsis; }
.wn-field select:disabled { opacity: 0.6; }
.wn-list { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
.wn-release-title .wn-tag { vertical-align: middle; }
.wn-tag {
  display: inline-block; font-size: var(--f-caption); font-weight: 600; line-height: 1.4;
  padding: 0 var(--sp-2); border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim);
}
.wn-tag--new { color: var(--accent); border-color: var(--accent); background: var(--accent-quiet); }
.wn-release-title:focus { outline: none; }
.wn-release-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.wn-foot { display: flex; flex-direction: column; gap: var(--sp-3); border-top: 1px solid var(--border); padding-top: var(--sp-4); }
.wn-foot .wn-release-link { align-self: center; }
`;
  document.head.appendChild(style);
}
