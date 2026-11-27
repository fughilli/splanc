/**
 * The FX editor's Docs pane (D-541 PR 6): search the effect language and read a
 * page per term (signature, summary, explanation, example, cost hint, where it
 * may be used, related terms). On desktop it is a dockable side pane; on a
 * phone the editor opens a fresh instance in a bottom sheet.
 *
 * The content is the compiler's reference table (lang-spec.ts `LANG`), so it
 * always matches the compiler in this build.
 */

import { Button, Chip, icon } from "../../ui/kit";
import { renderMarkdown } from "../../ui/markdown";
import { highlight } from "./highlight";
import { LANG, langEntry, type LangEntry } from "./lang-spec";
import { docsByCategory, exampleIsProgram, kindLabel, scopeText, searchDocs } from "./docs";

export interface DocsPanelOpts {
  /** Insert a snippet example into the code (at the caret's line). */
  onInsert: (snippet: string) => void;
  /** Copy text to the clipboard (the panel shows no feedback itself). */
  onCopy: (text: string) => void;
}

export class DocsPanel {
  readonly node: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly body: HTMLElement;
  private readonly opts: DocsPanelOpts;
  /** Pages visited from the index (Back pops one). */
  private history: string[] = [];
  private current: string | null = null;

  constructor(opts: DocsPanelOpts) {
    this.opts = opts;
    this.node = document.createElement("div");
    this.node.className = "fxdocs";

    const head = document.createElement("div");
    head.className = "fxdocs-head";
    const field = document.createElement("label");
    field.className = "fxdocs-search";
    field.append(icon("search"));
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = "Search the language";
    this.search.setAttribute("aria-label", "Search the effect language");
    this.search.autocomplete = "off";
    this.search.spellcheck = false;
    field.append(this.search);
    head.append(field);

    this.body = document.createElement("div");
    this.body.className = "fxdocs-body";
    this.node.append(head, this.body);

    this.search.addEventListener("input", () => {
      this.history = [];
      this.current = null;
      this.renderIndex();
    });
    this.search.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const first = searchDocs(this.search.value)[0];
        if (first) this.show(first.name);
      }
    });
    this.renderIndex();
  }

  /** The term whose page is open, or null on the index. */
  get term(): string | null {
    return this.current;
  }

  /** Open the page for `name` (unknown names fall back to a search for it). */
  show(name: string): void {
    const e = langEntry(name);
    if (!e) {
      this.search.value = name;
      this.current = null;
      this.history = [];
      this.renderIndex();
      return;
    }
    if (this.current && this.current !== name) this.history.push(this.current);
    this.current = name;
    this.renderPage(e);
  }

  /** Back to the index with the search box focused. */
  focusSearch(): void {
    this.current = null;
    this.history = [];
    this.renderIndex();
    this.search.focus();
    this.search.select();
  }

  private back(): void {
    const prev = this.history.pop();
    this.current = null;
    if (prev) this.show(prev);
    else this.renderIndex();
  }

  // ---- index ----------------------------------------------------------------

  private renderIndex(): void {
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    const q = this.search.value.trim();
    if (q) {
      const hits = searchDocs(q);
      const count = document.createElement("div");
      count.className = "fxdocs-count";
      count.textContent = hits.length === 0 ? `Nothing matches “${q}”.` : `${hits.length} match${hits.length === 1 ? "" : "es"}`;
      this.body.append(count);
      const list = document.createElement("div");
      list.className = "fxdocs-list";
      for (const e of hits) list.append(this.row(e));
      this.body.append(list);
      return;
    }
    const intro = document.createElement("p");
    intro.className = "fxdocs-intro";
    intro.textContent = `${LANG.length} terms. Right-click a word in the code (or select it on a phone) to jump to its page.`;
    this.body.append(intro);
    for (const g of docsByCategory()) {
      const sec = document.createElement("section");
      sec.className = "fxdocs-cat";
      const h = document.createElement("h3");
      h.textContent = g.label;
      const list = document.createElement("div");
      list.className = "fxdocs-list";
      for (const e of g.entries) list.append(this.row(e));
      sec.append(h, list);
      this.body.append(sec);
    }
  }

  private row(e: LangEntry): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fxdocs-row";
    b.dataset["term"] = e.name;
    const name = document.createElement("code");
    name.className = "fxdocs-row-name";
    name.textContent = e.name;
    const sum = document.createElement("span");
    sum.className = "fxdocs-row-sum";
    sum.textContent = e.summary;
    b.append(name, sum);
    b.addEventListener("click", () => this.show(e.name));
    return b;
  }

  // ---- term page --------------------------------------------------------------

  private renderPage(e: LangEntry): void {
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    const page = document.createElement("article");
    page.className = "fxdocs-page";

    const nav = document.createElement("div");
    nav.className = "fxdocs-nav";
    const prev = this.history[this.history.length - 1];
    nav.append(Button({ label: prev ? `Back to ${prev}` : "All terms", icon: "back", variant: "quiet", onClick: () => this.back() }));
    page.append(nav);

    const title = document.createElement("h2");
    title.className = "fxdocs-title";
    const code = document.createElement("code");
    code.textContent = e.name;
    title.append(code);
    page.append(title);

    const badges = document.createElement("div");
    badges.className = "fxdocs-badges";
    const badge = (text: string, cls = ""): void => {
      const s = document.createElement("span");
      s.className = `fxdocs-badge${cls ? ` ${cls}` : ""}`;
      s.textContent = text;
      badges.append(s);
    };
    badge(kindLabel(e.kind));
    if (e.ty) badge(e.ty, "fxdocs-badge--type");
    if (e.scope === "update") badge("update() only", "fxdocs-badge--scope");
    if (e.scope === "driver") badge("drivers only", "fxdocs-badge--scope");
    if (e.scope === "reserved") badge("reserved", "fxdocs-badge--scope");
    if (e.constant) badge("works in constants");
    page.append(badges);

    if (e.sigs.length > 0) {
      const sigs = document.createElement("div");
      sigs.className = "fxdocs-sigs";
      for (const s of e.sigs) {
        const pre = document.createElement("pre");
        pre.className = "fxdocs-sig";
        pre.innerHTML = highlight(s); // highlight() escapes everything
        sigs.append(pre);
      }
      page.append(sigs);
    }

    const summary = document.createElement("p");
    summary.className = "fxdocs-summary";
    summary.textContent = e.summary;
    page.append(summary);

    if (e.doc) {
      const doc = document.createElement("div");
      doc.className = "fxdocs-doc";
      doc.append(renderMarkdown(e.doc));
      page.append(doc);
    }

    const where = scopeText(e.scope);
    if (where || e.cost) {
      const facts = document.createElement("dl");
      facts.className = "fxdocs-facts";
      const fact = (k: string, v: string): void => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        facts.append(dt, dd);
      };
      if (where) fact("Where", where);
      if (e.cost) fact("Cost on the lamp", e.cost);
      page.append(facts);
    }

    if (e.example) page.append(this.example(e.example));

    const related = e.related.filter((r) => langEntry(r));
    if (related.length > 0) {
      const h = document.createElement("h3");
      h.textContent = "Related";
      const chips = document.createElement("div");
      chips.className = "fxdocs-related";
      for (const r of related) chips.append(Chip({ label: r, onClick: () => this.show(r) }));
      page.append(h, chips);
    }
    this.body.append(page);
  }

  private example(src: string): HTMLElement {
    const box = document.createElement("section");
    box.className = "fxdocs-example";
    const h = document.createElement("h3");
    h.textContent = "Example";
    const pre = document.createElement("pre");
    pre.className = "fxdocs-code";
    pre.innerHTML = highlight(src); // escaped by highlight()
    const actions = document.createElement("div");
    actions.className = "fxdocs-actions";
    const program = exampleIsProgram(src);
    if (!program) {
      actions.append(Button({ label: "Insert", icon: "plus", onClick: () => this.opts.onInsert(src) }));
    }
    actions.append(Button({ label: "Copy", ...(program ? {} : { variant: "quiet" as const }), onClick: () => this.opts.onCopy(src) }));
    box.append(h, pre, actions);
    if (program) {
      const note = document.createElement("p");
      note.className = "fxdocs-note";
      note.textContent = "A whole effect: copy it into a new effect to try it.";
      box.append(note);
    }
    return box;
  }
}
