/**
 * Map browser (design doc §4/§5.5 / §7.4) — search/filter/sort the local map
 * library, tap a row to open Map Detail, ⋯ for CRUD, FAB "+ New" → capture.
 * NEW screen (no equivalent in main.ts).
 */

import { ActionGrid, Button, Chip, EmptyState, IconButton, Sheet, toast, icon } from "../kit";
import { mapStore, renderThumbnail, isThumbnailStale, type StoredMapSummary } from "../../store/mapStore";
import {
  decodeLibraryBundle,
  looksLikeLibraryBundle,
  type ConflictMode,
} from "../../store/mapBundle";
import { appendGrouped, openFolderPicker } from "./folders";
import { appState } from "../app/state";
import { prefs } from "../../store/prefs";
import type { Router, Screen } from "../app/router";

type Sort = "updated" | "name" | "leds";

export function MapBrowserScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--maps";

  let search = "";
  let activeTags: string[] = [];
  let sort: Sort = "updated";

  // -- library actions (import / export-all) — reachable even when empty.
  const actions = document.createElement("div");
  actions.className = "maps-actions";
  actions.append(
    Button({
      label: "Import",
      icon: "upload",
      variant: "quiet",
      onClick: () => void importFromFile(),
    }),
    Button({
      label: "Export library",
      icon: "download",
      variant: "quiet",
      onClick: () => void exportLibrary(),
    }),
  );

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
  fab.addEventListener("click", () => startNewMap());

  // "New map": confirm the LED count before opening the camera. The strip
  // length drives the code-book, so it must be right before the flashing
  // starts — the capture screen has no way to change it mid-walk (FUG-62).
  function startNewMap(): void {
    const prefill =
      prefs.getCaptureLedCount() ?? appState.client?.welcome?.codeParams.ledCount ?? 64;
    const sheet = Sheet("New map");
    const label = document.createElement("label");
    label.className = "k-field";
    const cap = document.createElement("span");
    cap.className = "k-field-label";
    cap.textContent = "Number of LEDs on the fixture";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.inputMode = "numeric";
    input.value = String(prefill);
    label.append(cap, input);
    const hint = document.createElement("p");
    hint.className = "sheet-hint metric";
    hint.textContent = "This is the strip length the device will flash and map.";
    const go = Button({
      label: "Start mapping",
      icon: "camera",
      block: true,
      onClick: () => {
        const n = Math.max(1, Math.round(parseInt(input.value, 10) || prefill));
        prefs.setCaptureLedCount(n);
        sheet.close();
        router.navigate(`/capture?leds=${n}`);
      },
    });
    sheet.body.append(label, hint, go);
    input.focus();
    input.select();
  }

  // Prompt for a file, then route it: a multi-map library bundle opens the
  // conflict-mode chooser; a single-map .binpb imports straight into the
  // library (same store path as a device pull) and opens.
  async function importFromFile(): Promise<void> {
    const file = await pickFile(".binpb,.mapbundle,application/octet-stream");
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksLikeLibraryBundle(bytes)) {
        openImportSheet(bytes);
        return;
      }
      const id = await mapStore.importBundle(bytes, { source: "import" });
      toast("Map imported");
      await refresh();
      router.navigate(`/map/${id}`);
    } catch (e) {
      toast(`Import failed: ${e instanceof Error ? e.message : e}`, { error: true });
    }
  }

  // Ask how same-name collisions should be handled, then import the bundle.
  function openImportSheet(bytes: Uint8Array): void {
    let count = 0;
    try {
      count = decodeLibraryBundle(bytes).length;
    } catch (e) {
      toast(`Import failed: ${e instanceof Error ? e.message : e}`, { error: true });
      return;
    }
    const sheet = Sheet(`Import ${count} map${count === 1 ? "" : "s"}`);
    const run = async (mode: ConflictMode, folder?: string): Promise<void> => {
      sheet.close();
      try {
        const opts = folder === undefined ? { mode } : { mode, folder };
        const r = await mapStore.importLibraryBundle(bytes, opts);
        const bits = [];
        if (r.imported) bits.push(`${r.imported} added`);
        if (r.overwritten) bits.push(`${r.overwritten} overwritten`);
        toast(bits.length ? `Imported (${bits.join(", ")})` : "Nothing to import");
        await refresh();
      } catch (e) {
        toast(`Import failed: ${e instanceof Error ? e.message : e}`, { error: true });
      }
    };
    sheet.body.append(
      ActionGrid([
        {
          label: "Overwrite same-name",
          icon: "download",
          onClick: () => void run("overwrite"),
        },
        {
          label: "Keep both (rename)",
          icon: "map",
          onClick: () => void run("rename"),
        },
        {
          label: "Into new folder…",
          icon: "folder",
          onClick: () => {
            sheet.close();
            void mapStore.folders().then((existing) =>
              openFolderPicker({
                title: "Import into folder",
                current: "",
                existing,
                onPick: (folder) => void run("folder", folder),
              }),
            );
          },
        },
      ]),
    );
  }

  async function exportLibrary(): Promise<void> {
    try {
      const all = await mapStore.list();
      if (all.length === 0) {
        toast("No maps to export", { error: true });
        return;
      }
      const bytes = await mapStore.exportLibraryBundle();
      downloadBytes(bytes, "maps.mapbundle");
    } catch (e) {
      toast(`Export failed: ${e instanceof Error ? e.message : e}`, { error: true });
    }
  }

  el.append(actions, searchWrap, tagRow, listEl);

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
              ? Button({ label: "New map", icon: "plus", onClick: () => startNewMap() })
              : undefined,
        }),
      );
      return;
    }
    appendGrouped(listEl, rows, (m) => m.folder, row, { scope: "maps" });
  }

  function row(m: StoredMapSummary): HTMLElement {
    const r = document.createElement("div");
    r.className = "map-row";
    r.addEventListener("click", () => router.navigate(`/map/${m.id}`));

    const thumb = document.createElement("div");
    thumb.className = "map-thumb";
    // Show the cached image immediately when present (even if stale, to avoid an
    // icon flash), otherwise a placeholder icon.
    if (m.thumbnail) {
      const img = document.createElement("img");
      img.src = m.thumbnail;
      thumb.appendChild(img);
    } else {
      thumb.appendChild(icon("map"));
    }
    // (Re-)render lazily on first view when the thumbnail is missing or was
    // produced by an older engine (design doc §5.4/§9.7) — so a framing change
    // like FUG-81 retroactively refreshes thumbnails cached by the old grid/
    // triad renderer.
    if (isThumbnailStale(m)) void lazyThumb(m.id, thumb);

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
    const act = (fn: () => void) => (): void => {
      sheet.close();
      fn();
    };
    sheet.body.append(
      ActionGrid([
        {
          label: "Rename",
          icon: "edit",
          onClick: act(() => void editText("Rename", m.name, (v) => mapStore.rename(m.id, v).then(refresh))),
        },
        {
          label: "Description",
          icon: "edit",
          onClick: act(() =>
            void editText("Description", m.description, (v) => mapStore.setDescription(m.id, v).then(refresh)),
          ),
        },
        {
          label: "Tags",
          icon: "tag",
          onClick: act(() =>
            void editText("Tags (space-separated)", m.tags.join(" "), (v) =>
              mapStore.setTags(m.id, v.split(/\s+/)).then(refresh),
            ),
          ),
        },
        {
          label: "Move",
          icon: "folder",
          onClick: act(() =>
            void mapStore.folders().then((existing) =>
              openFolderPicker({
                current: m.folder ?? "",
                existing,
                onPick: (folder) => void mapStore.setFolder(m.id, folder).then(refresh),
              }),
            ),
          ),
        },
        {
          label: "Duplicate",
          icon: "map",
          onClick: act(() =>
            void mapStore.duplicate(m.id).then(() => {
              toast("Duplicated");
              void refresh();
            }),
          ),
        },
        { label: "Export", icon: "download", onClick: act(() => void exportMap(m)) },
        {
          label: "Delete",
          icon: "trash",
          variant: "danger",
          onClick: () => {
            if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return;
            sheet.close();
            void mapStore.delete(m.id).then(() => {
              toast("Deleted");
              void refresh();
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

/** Open the OS file picker and resolve with the chosen file (or null). */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const done = (f: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    // Cancelling the dialog fires no 'change'; window regains focus instead.
    window.addEventListener(
      "focus",
      () => setTimeout(() => done(input.files?.[0] ?? null), 300),
      { once: true },
    );
    document.body.append(input);
    input.click();
  });
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
