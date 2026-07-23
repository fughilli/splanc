/**
 * Shared folder helpers for the map / effect / device libraries: a "move to
 * folder" picker sheet and a grouping renderer that lays items out under folder
 * headers. Folders are implicit — a folder "exists" while any item references it
 * (no separate folder store, no empty-folder bookkeeping).
 */

import { Button, Sheet, icon } from "../kit";

/** Open a sheet to choose a folder for an item (or create a new one / ungroup).
 * `current` is the item's folder (""=ungrouped); `existing` the known folders. */
export function openFolderPicker(opts: {
  title?: string;
  current: string;
  existing: string[];
  onPick: (folder: string) => void;
}): void {
  const sheet = Sheet(opts.title ?? "Move to folder");
  sheet.body.className = "folder-picker";
  const pick = (folder: string): void => {
    sheet.close();
    opts.onPick(folder);
  };

  const list = document.createElement("div");
  list.className = "folder-list";
  const mkRow = (label: string, folder: string, ic: Parameters<typeof icon>[0]): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "folder-row" + (folder === opts.current ? " folder-row--on" : "");
    b.append(icon(ic));
    const s = document.createElement("span");
    s.textContent = label;
    b.appendChild(s);
    b.addEventListener("click", () => pick(folder));
    return b;
  };
  list.appendChild(mkRow("Ungrouped", "", "close"));
  for (const f of opts.existing) list.appendChild(mkRow(f, f, "folder"));

  const newWrap = document.createElement("div");
  newWrap.className = "folder-new";
  const input = document.createElement("input");
  input.className = "sheet-input";
  input.placeholder = "New folder name…";
  const commit = (): void => {
    const name = input.value.trim();
    if (name) pick(name);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });
  newWrap.append(input, Button({ label: "Create", onClick: commit }));

  sheet.body.append(list, newWrap);
}

const COLLAPSE_KEY = "ledmapper.foldersCollapsed";
function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function writeCollapsed(s: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s]));
  } catch {
    /* non-fatal */
  }
}

/**
 * Append `items` to `listEl`, grouped under COLLAPSIBLE folder headers. Folders
 * come first (alphabetical), each with a header showing a chevron + item count;
 * clicking a header collapses/expands that folder (persisted per `opts.scope`).
 * Ungrouped items follow (under an "Ungrouped" header only when folders exist,
 * else laid out flat). Headers span the full row so this works with both the
 * mobile flex list and the wide-screen card grid; collapse just hides the item
 * nodes, leaving the responsive layout intact.
 */
export function appendGrouped<T>(
  listEl: HTMLElement,
  items: T[],
  getFolder: (item: T) => string | undefined,
  renderItem: (item: T) => Node,
  opts: { scope: string },
): void {
  const groups = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const it of items) {
    const f = (getFolder(it) ?? "").trim();
    if (f) {
      const arr = groups.get(f) ?? [];
      arr.push(it);
      groups.set(f, arr);
    } else {
      ungrouped.push(it);
    }
  }
  const hasFolders = groups.size > 0;
  const collapsed = readCollapsed();

  const section = (folder: string, arr: T[], muted = false): void => {
    const key = `${opts.scope}:${folder}`;
    let isCollapsed = collapsed.has(key);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "folder-header" + (muted ? " folder-header--muted" : "");
    const chev = icon("chevron");
    chev.classList.add("folder-chevron");
    header.append(chev);
    if (!muted) header.append(icon("folder"));
    const label = document.createElement("span");
    label.className = "folder-header-name";
    label.textContent = folder;
    const count = document.createElement("span");
    count.className = "folder-count";
    count.textContent = String(arr.length);
    header.append(label, count);
    listEl.appendChild(header);

    const nodes: HTMLElement[] = [];
    for (const it of arr) {
      const node = renderItem(it) as HTMLElement;
      node.hidden = isCollapsed;
      nodes.push(node);
      listEl.appendChild(node);
    }

    const apply = (): void => {
      header.classList.toggle("folder-header--collapsed", isCollapsed);
      for (const n of nodes) n.hidden = isCollapsed;
    };
    apply();
    header.addEventListener("click", () => {
      isCollapsed = !isCollapsed;
      if (isCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      writeCollapsed(collapsed);
      apply();
    });
  };

  for (const folder of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    section(folder, groups.get(folder)!);
  }
  if (ungrouped.length > 0) {
    if (hasFolders) section("Ungrouped", ungrouped, true);
    else for (const it of ungrouped) listEl.appendChild(renderItem(it));
  }
}
