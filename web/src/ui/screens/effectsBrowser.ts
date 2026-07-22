/**
 * Effects browser (the #/effects tab) — the effect library workspace: browse,
 * create, edit, and test shader effects. Replaces the old Effects tab (which was
 * only the pulse/flood simulator; that lives on as a "Built-in: Pulse/Flood"
 * entry that opens the preserved sim at #/effects/pulse).
 *
 * Mirrors the map browser: a search box, tag chips, a list of saved effects
 * (tap → open the in-shell editor at #/effects/edit/:id), a circular "+" FAB to
 * create a new effect, an EmptyState with a "New effect" action, and a
 * discoverable "AI key" affordance that opens the BYO-key sheet.
 */

import { Button, Card, Chip, EmptyState, IconButton, Sheet, toast, icon } from "../kit";
import { effectStore, type StoredEffect } from "../../store/effectStore";
import { openAiKeySheet } from "./aiKeySheet";
import { getApiKey } from "../../effects/ai/generate";
import type { Router, Screen } from "../app/router";

type Sort = "updated" | "name";

export function EffectsBrowserScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--effects-lib";

  let search = "";
  let activeTags: string[] = [];
  let sort: Sort = "updated";

  // -- search + sort --------------------------------------------------------
  const searchWrap = document.createElement("div");
  searchWrap.className = "maps-search";
  searchWrap.appendChild(icon("search"));
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "search name / #tag …";
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    void refresh();
  });
  searchWrap.appendChild(searchInput);
  const sortSel = document.createElement("select");
  sortSel.className = "maps-sort";
  for (const [v, label] of [
    ["updated", "Recent"],
    ["name", "Name"],
  ] as [Sort, string][]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sortSel.appendChild(o);
  }
  sortSel.addEventListener("change", () => {
    sort = sortSel.value as Sort;
    void refresh();
  });
  searchWrap.appendChild(sortSel);

  // -- AI key affordance ----------------------------------------------------
  const aiKeyCard = Card();
  aiKeyCard.className = "k-card fxlib-aikey";
  function renderAiKeyCard(): void {
    aiKeyCard.replaceChildren();
    const info = document.createElement("div");
    info.className = "fxlib-aikey-info";
    const title = document.createElement("div");
    title.className = "fxlib-aikey-title";
    title.textContent = "AI generation";
    const sub = document.createElement("div");
    sub.className = "fxlib-aikey-sub";
    sub.textContent = getApiKey()
      ? "Anthropic key set — used only in your browser."
      : "Add your Anthropic key to generate effects with AI.";
    info.append(title, sub);
    const btn = Button({
      label: getApiKey() ? "Manage key" : "Add AI key",
      icon: "sparkles",
      variant: "quiet",
      onClick: () => openAiKeySheet(() => renderAiKeyCard()),
    });
    aiKeyCard.append(info, btn);
  }
  renderAiKeyCard();

  const tagRow = document.createElement("div");
  tagRow.className = "maps-tags";

  const listEl = document.createElement("div");
  listEl.className = "maps-list";

  // -- built-in pulse/flood entry (preserves the old Effects-tab sim) -------
  function builtinRow(): HTMLElement {
    const r = document.createElement("div");
    r.className = "map-row";
    r.addEventListener("click", () => router.navigate("/effects/pulse"));
    const thumb = document.createElement("div");
    thumb.className = "map-thumb";
    thumb.appendChild(icon("sparkles"));
    const info = document.createElement("div");
    info.className = "map-info";
    const name = document.createElement("div");
    name.className = "map-name";
    name.textContent = "Built-in: Pulse / Flood";
    const meta = document.createElement("div");
    meta.className = "map-meta metric";
    meta.textContent = "Offline preview over a selected map";
    info.append(name, meta);
    const go = IconButton("play", { title: "Preview" });
    r.append(thumb, info, go);
    return r;
  }

  // -- FAB (body-mounted, exactly like the map browser) ---------------------
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab";
  fab.title = "New effect";
  fab.setAttribute("aria-label", "New effect");
  fab.appendChild(icon("plus"));
  fab.addEventListener("click", () => void newEffect());

  async function newEffect(): Promise<void> {
    const id = await effectStore.create({ name: "New effect" });
    router.navigate(`/effects/edit/${id}`);
  }

  el.append(searchWrap, aiKeyCard, tagRow, listEl);

  async function refresh(): Promise<void> {
    const all = await effectStore.list();
    const tagCounts = new Map<string, number>();
    for (const e of all) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    tagRow.replaceChildren();
    for (const [tag] of [...tagCounts.entries()].sort()) {
      tagRow.appendChild(
        Chip({
          label: `#${tag}`,
          on: activeTags.includes(tag),
          onClick: () => {
            activeTags = activeTags.includes(tag)
              ? activeTags.filter((t) => t !== tag)
              : [...activeTags, tag];
            void refresh();
          },
        }),
      );
    }

    const rows = await effectStore.list({ search, tags: activeTags, sort });
    listEl.replaceChildren();
    // Built-in pulse/flood preview always available at the top (only when not
    // filtering, so it doesn't fight a #tag / search query).
    if (!search && activeTags.length === 0) listEl.appendChild(builtinRow());

    if (rows.length === 0 && all.length === 0) {
      listEl.append(
        EmptyState({
          icon: "sparkles",
          title: "No effects yet — create one",
          action: Button({ label: "New effect", icon: "plus", onClick: () => void newEffect() }),
        }),
      );
      return;
    }
    if (rows.length === 0) {
      listEl.append(EmptyState({ icon: "sparkles", title: "No effects match your search" }));
      return;
    }
    for (const e of rows) listEl.append(row(e));
  }

  function row(e: StoredEffect): HTMLElement {
    const r = document.createElement("div");
    r.className = "map-row";
    r.addEventListener("click", () => router.navigate(`/effects/edit/${e.id}`));

    const thumb = document.createElement("div");
    thumb.className = "map-thumb";
    thumb.appendChild(icon("sparkles"));

    const info = document.createElement("div");
    info.className = "map-info";
    const name = document.createElement("div");
    name.className = "map-name";
    name.textContent = e.name;
    const meta = document.createElement("div");
    meta.className = "map-meta metric";
    meta.textContent = shortDate(e.updatedAt);
    info.append(name, meta);
    if (e.tags.length > 0) {
      const tags = document.createElement("div");
      tags.className = "map-rowtags";
      tags.textContent = e.tags.map((t) => `#${t}`).join(" ");
      info.append(tags);
    }

    const more = IconButton("more", { title: "More" });
    more.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openContextSheet(e);
    });

    r.append(thumb, info, more);
    return r;
  }

  function openContextSheet(e: StoredEffect): void {
    const sheet = Sheet(e.name);
    sheet.body.className = "context-sheet";
    const item = (
      label: string,
      ic: NonNullable<Parameters<typeof Button>[0]["icon"]>,
      fn: () => void,
    ): HTMLElement => Button({ label, icon: ic, variant: "quiet", block: true, onClick: fn });
    sheet.body.append(
      item("Edit", "edit", () => {
        sheet.close();
        router.navigate(`/effects/edit/${e.id}`);
      }),
      item("Rename", "edit", () => {
        sheet.close();
        void editText("Rename", e.name, (v) => effectStore.rename(e.id, v).then(refresh));
      }),
      item("Tags", "tag", () => {
        sheet.close();
        void editText("Tags (space-separated)", e.tags.join(" "), (v) =>
          effectStore.setTags(e.id, v.split(/\s+/)).then(refresh),
        );
      }),
      item("Duplicate", "sparkles", () => {
        sheet.close();
        void effectStore.duplicate(e.id).then(() => {
          toast("Duplicated");
          void refresh();
        });
      }),
      Button({
        label: "Delete",
        icon: "trash",
        variant: "danger",
        block: true,
        onClick: () => {
          if (!confirm(`Delete "${e.name}"? This cannot be undone.`)) return;
          sheet.close();
          void effectStore.delete(e.id).then(() => {
            toast("Deleted");
            void refresh();
          });
        },
      }),
    );
  }

  return {
    el,
    onMount: () => {
      document.body.appendChild(fab);
      void refresh();
    },
    onUnmount: () => fab.remove(),
  };
}

function editText(title: string, value: string, save: (v: string) => Promise<void> | void): void {
  const sheet = Sheet(title);
  const input = document.createElement("input");
  input.className = "sheet-input";
  input.value = value;
  const btn = Button({
    label: "Save",
    block: true,
    onClick: () => {
      void Promise.resolve(save(input.value.trim())).then(() => sheet.close());
    },
  });
  sheet.body.append(input, btn);
  input.focus();
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
