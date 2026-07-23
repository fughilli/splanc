/**
 * Map browser (design doc §4/§5.5 / §7.4) — search/filter/sort the local map
 * library, tap a row to open Map Detail, ⋯ for CRUD, FAB "+ New" → capture.
 * NEW screen (no equivalent in main.ts).
 */

import { Button, Chip, EmptyState, IconButton, Sheet, toast, icon } from "../kit";
import { mapStore, renderThumbnail, type StoredMapSummary } from "../../store/mapStore";
import { appendGrouped, openFolderPicker } from "./folders";
import type { Router, Screen } from "../app/router";

type Sort = "updated" | "name" | "leds";

export function MapBrowserScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--maps";

  let search = "";
  let activeTags: string[] = [];
  let sort: Sort = "updated";

  // -- search + sort controls
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
    ["leds", "LEDs"],
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

  const tagRow = document.createElement("div");
  tagRow.className = "maps-tags";

  const listEl = document.createElement("div");
  listEl.className = "maps-list";

  // Circular icon-only FAB. Lives on document.body (NOT inside `el`): the
  // `.screen` enter animation applies a `transform`, which would make this
  // `position: fixed` button anchor to the animating screen and visibly snap
  // into place. Body-mounted, it's anchored to the viewport from frame one.
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab";
  fab.title = "New map";
  fab.setAttribute("aria-label", "New map");
  fab.appendChild(icon("plus"));
  fab.addEventListener("click", () => router.navigate("/capture"));

  el.append(searchWrap, tagRow, listEl);

  async function refresh(): Promise<void> {
    const all = await mapStore.list();
    // Tag chips from all maps (not the filtered set) so filtering never hides
    // the very chip that would clear the filter.
    const tagCounts = new Map<string, number>();
    for (const m of all) for (const t of m.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    tagRow.innerHTML = "";
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

    const rows = await mapStore.list({ search, tags: activeTags, sort });
    listEl.innerHTML = "";
    if (rows.length === 0) {
      listEl.append(
        EmptyState({
          icon: "map",
          title: all.length === 0 ? "No maps yet — map a fixture" : "No maps match your search",
          action:
            all.length === 0
              ? Button({ label: "New map", icon: "plus", onClick: () => router.navigate("/capture") })
              : undefined,
        }),
      );
      return;
    }
    appendGrouped(listEl, rows, (m) => m.folder, row);
  }

  function row(m: StoredMapSummary): HTMLElement {
    const r = document.createElement("div");
    r.className = "map-row";
    r.addEventListener("click", () => router.navigate(`/map/${m.id}`));

    const thumb = document.createElement("div");
    thumb.className = "map-thumb";
    if (m.thumbnail) {
      const img = document.createElement("img");
      img.src = m.thumbnail;
      thumb.appendChild(img);
    } else {
      thumb.appendChild(icon("map"));
      // Lazy thumbnail: render a fresh one on first view (design doc §5.4/§9.7).
      void lazyThumb(m.id, thumb);
    }

    const info = document.createElement("div");
    info.className = "map-info";
    const name = document.createElement("div");
    name.className = "map-name";
    name.textContent = m.name;
    const meta = document.createElement("div");
    meta.className = "map-meta metric";
    meta.textContent = `${m.ledCount} LEDs · rms ${m.rmsReprojPx.toFixed(1)}px · ${shortDate(m.updatedAt)}`;
    info.append(name, meta);
    if (m.tags.length > 0) {
      const tags = document.createElement("div");
      tags.className = "map-rowtags";
      tags.textContent = m.tags.map((t) => `#${t}`).join(" ");
      info.append(tags);
    }

    const more = IconButton("more", {
      title: "More",
      onClick: () => {},
    });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      openContextSheet(m);
    });

    r.append(thumb, info, more);
    return r;
  }

  function openContextSheet(m: StoredMapSummary): void {
    const sheet = Sheet(m.name);
    const item = (label: string, ic: NonNullable<Parameters<typeof Button>[0]["icon"]>, fn: () => void): HTMLElement =>
      Button({ label, icon: ic, variant: "quiet", block: true, onClick: fn });
    sheet.body.className = "context-sheet";
    sheet.body.append(
      item("Rename", "edit", () => {
        sheet.close();
        void editText("Rename", m.name, (v) => mapStore.rename(m.id, v).then(refresh));
      }),
      item("Edit description", "edit", () => {
        sheet.close();
        void editText("Description", m.description, (v) => mapStore.setDescription(m.id, v).then(refresh));
      }),
      item("Tags", "tag", () => {
        sheet.close();
        void editText("Tags (space-separated)", m.tags.join(" "), (v) =>
          mapStore.setTags(m.id, v.split(/\s+/)).then(refresh),
        );
      }),
      item("Move to folder…", "folder", () => {
        sheet.close();
        void mapStore.folders().then((existing) =>
          openFolderPicker({
            current: m.folder ?? "",
            existing,
            onPick: (folder) => void mapStore.setFolder(m.id, folder).then(refresh),
          }),
        );
      }),
      item("Duplicate", "map", () => {
        sheet.close();
        void mapStore.duplicate(m.id).then(() => {
          toast("Duplicated");
          void refresh();
        });
      }),
      item("Export .binpb", "download", () => {
        sheet.close();
        void exportMap(m);
      }),
      Button({
        label: "Delete",
        icon: "trash",
        variant: "danger",
        block: true,
        onClick: () => {
          if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return;
          sheet.close();
          void mapStore.delete(m.id).then(() => {
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

async function lazyThumb(id: string, thumb: HTMLElement): Promise<void> {
  const rec = await mapStore.get(id);
  if (!rec) return;
  const url = await renderThumbnail(rec.map).catch(() => "");
  if (!url) return;
  await mapStore.setThumbnail(id, url);
  thumb.innerHTML = "";
  const img = document.createElement("img");
  img.src = url;
  thumb.appendChild(img);
}

async function exportMap(m: StoredMapSummary): Promise<void> {
  try {
    const bytes = await mapStore.exportBundle(m.id);
    downloadBytes(bytes, `${m.name.replace(/[^\w.-]+/g, "_") || "map"}.binpb`);
  } catch (e) {
    toast(`Export failed: ${e instanceof Error ? e.message : e}`, { error: true });
  }
}

export function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Simple single-field editor in a bottom sheet. */
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
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
