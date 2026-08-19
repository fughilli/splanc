/**
 * Effects browser (the #/effects tab) — the effect library workspace: browse,
 * create, edit, and test shader effects. Replaces the old pulse/flood-simulator
 * Effects tab.
 *
 * Mirrors the map browser: a search box, tag chips, a list of saved effects
 * (tap → open the in-shell editor at #/effects/edit/:id), a circular "+" FAB to
 * create a new effect, an EmptyState with a "New effect" action, and a
 * discoverable "AI key" affordance that opens the BYO-key sheet.
 */

import { ActionGrid, Button, Chip, EmptyState, HelpTip, IconButton, Sheet, confirmDialog, toast, icon } from "../kit";
import type { HelpTipHandle } from "../kit";
import { effectStore, isBuiltinEffect, type StoredEffect } from "../../store/effectStore";
import { EffectPreviewTiles } from "./effectPreviewTiles";
import { appendGrouped, openFolderPicker } from "./folders";
import { openAiKeySheet } from "./aiKeySheet";
import { getApiKey } from "../../effects/ai/generate";
import { setTabMenuItems } from "../app/tabMenu";
import { prefs } from "../../store/prefs";
import { getAppearance } from "../../store/appearance";
import type { Router, Screen } from "../app/router";

type Sort = "updated" | "name";

export function EffectsBrowserScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--effects-lib";

  let search = "";
  let activeTags: string[] = [];
  let sort: Sort = "updated";

  // Lazily renders each effect's 64×64 preview clip into its thumbnail when the
  // row scrolls into view, one render at a time (FUG-80).
  const tiles = new EffectPreviewTiles();

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

  // -- AI key affordance: a compact floating "?" help tip, shown ONLY until a
  // key is configured. Once a key is saved, AI generation just works, so the
  // hint disappears (managing/clearing the key stays in the editor's ⋯ menu).
  const aiHelp = document.createElement("div");
  aiHelp.className = "fxlib-aihelp";
  // Track the live tip so we can drop its document-level dismiss listener when
  // the screen unmounts while it's still expanded (it defaults to open).
  let aiTip: HelpTipHandle | null = null;
  function renderAiHelp(): void {
    aiTip?.close();
    aiTip = null;
    aiHelp.replaceChildren();
    if (getApiKey()) return; // key configured → nothing to prompt
    if (prefs.getAiHintDismissed()) return; // user dismissed it once → gone for good
    const tip = HelpTip({
      label: "About AI generation",
      title: "AI generation",
      body: "Generate effects from a text prompt with your own Anthropic API key — stored only in this browser and sent directly to Anthropic.",
      align: "right",
      // First-run hint: no key configured yet, so surface it expanded on arrival
      // rather than hiding it behind a "?" the user has to discover.
      defaultOpen: true,
      // Once the user dismisses it (outside tap / Escape / tapping "?"), record
      // that and drop the affordance for good — it won't pop again.
      onDismiss: () => {
        prefs.setAiHintDismissed();
        renderAiHelp();
      },
      action: {
        label: "Add AI key",
        icon: "sparkles",
        onClick: () => openAiKeySheet(() => renderAiHelp()),
      },
    });
    aiTip = tip;
    aiHelp.appendChild(tip.el);
  }
  renderAiHelp();

  // Toolbar row: the search field takes the space; the "?" tip floats at its end.
  const toolbar = document.createElement("div");
  toolbar.className = "fxlib-toolbar";
  // (The "Connect debug server" affordance moved to Settings ▸ Debugging, so it's
  // no longer in the effects ⋯ menu.)
  toolbar.append(searchWrap, aiHelp);

  const tagRow = document.createElement("div");
  tagRow.className = "maps-tags";

  const listEl = document.createElement("div");
  listEl.className = "maps-list";

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

  el.append(toolbar, tagRow, listEl);

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
    // Rebuilding the list: drop the old tiles' observers/URLs before re-observing.
    tiles.reset();
    listEl.replaceChildren();

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
    appendGrouped(listEl, rows, (e) => e.folder, row, { scope: "effects" });
  }

  function row(e: StoredEffect): HTMLElement {
    const r = document.createElement("div");
    r.className = "map-row";
    r.addEventListener("click", () => router.navigate(`/effects/edit/${e.id}`));

    const thumb = document.createElement("div");
    thumb.className = "map-thumb";
    thumb.appendChild(icon("sparkles"));
    // Lazily swap the placeholder icon for a looping 64×64 preview clip — gated
    // behind the experimental "Render FX previews" flag (off by default: the
    // preview rendering is slow/buggy on mobile). Off keeps the static icon.
    if (getAppearance().renderFxPreviews) tiles.observe(thumb, e.id, e.source);

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
    const act = (fn: () => void) => (): void => {
      sheet.close();
      fn();
    };
    // Built-in starters are immutable: open read-only and drop the in-place
    // mutators (Rename/Tags) — Duplicate makes an editable fork.
    const builtin = isBuiltinEffect(e.id);
    sheet.body.append(
      ActionGrid([
        {
          label: builtin ? "Open" : "Edit",
          icon: "edit",
          onClick: act(() => router.navigate(`/effects/edit/${e.id}`)),
        },
        ...(builtin
          ? []
          : [
              {
                label: "Rename",
                icon: "edit" as const,
                onClick: act(() =>
                  void editText("Rename", e.name, (v) => effectStore.rename(e.id, v).then(refresh)),
                ),
              },
              {
                label: "Tags",
                icon: "tag" as const,
                onClick: act(() =>
                  void editText("Tags (space-separated)", e.tags.join(" "), (v) =>
                    effectStore.setTags(e.id, v.split(/\s+/)).then(refresh),
                  ),
                ),
              },
            ]),
        {
          label: "Move",
          icon: "folder",
          onClick: act(() =>
            void effectStore.folders().then((existing) =>
              openFolderPicker({
                current: e.folder ?? "",
                existing,
                onPick: (folder) => void effectStore.setFolder(e.id, folder).then(refresh),
              }),
            ),
          ),
        },
        {
          label: "Duplicate",
          icon: "sparkles",
          onClick: act(() =>
            void effectStore.duplicate(e.id).then(() => {
              toast("Duplicated");
              void refresh();
            }),
          ),
        },
        {
          label: "Delete",
          icon: "trash",
          variant: "danger",
          onClick: () => {
            void confirmDialog({
              title: "Delete effect",
              message: `Delete "${e.name}"? This cannot be undone.`,
              confirmLabel: "Delete",
              danger: true,
            }).then((ok) => {
              if (!ok) return;
              sheet.close();
              void effectStore.delete(e.id).then(() => {
                toast("Deleted");
                void refresh();
              });
            });
          },
        },
      ]),
    );
  }

  return {
    el,
    onMount: () => {
      document.body.appendChild(fab);
      setTabMenuItems([]);
      void refresh();
    },
    onUnmount: () => {
      aiTip?.close();
      fab.remove();
      tiles.dispose();
      setTabMenuItems([]);
    },
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
