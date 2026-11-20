/**
 * Effects browser (the #/effects tab) — the effect library workspace: browse,
 * create, edit, and test shader effects. Replaces the old pulse/flood-simulator
 * Effects tab.
 *
 * This is the app's home (docs/ux/oobe-review.md): a fixture card on top (what
 * the app is connected to, and the next step), then the library in sections —
 * Starters, Examples, Your effects. Tapping an effect plays it on the fixture
 * and opens the tune sheet (effectTune.ts); the code editor is one step in from
 * there (or the row's ⋯ menu). Search + tag chips (the user's own tags) filter
 * to a flat list. A circular "+" FAB creates a new effect, and a "?" tip offers
 * AI setup until a provider is configured.
 */

import { ActionGrid, Button, Chip, EmptyState, HelpTip, IconButton, Sheet, confirmDialog, toast, icon } from "../kit";
import type { HelpTipHandle } from "../kit";
import { effectStore, isBuiltinEffect, type StoredEffect } from "../../store/effectStore";
import { deviceEffects } from "../../store/deviceEffects";
import { deviceStore } from "../../store/deviceStore";
import { appState } from "../app/state";
import { EffectPreviewTiles } from "./effectPreviewTiles";
import { appendGrouped, openFolderPicker } from "./folders";
import { isAiConfigured } from "../../effects/ai/provider";
import { openModelSetup } from "./aiTierSheet";
import { setTabMenuItems } from "../app/tabMenu";
import { prefs } from "../../store/prefs";
import { getAppearance } from "../../store/appearance";
import { effectSections, fixtureCard, isExample, isStarter, starterBlurb, userTags } from "../../effects/quickPlay";
import { nowPlaying } from "../../store/nowPlaying";
import { openEffectTune } from "./effectTune";
import { openDeviceSheet } from "./deviceSheet";
import { installEffectsHomeStyles } from "./effectsHome.css";
import type { Router, Screen } from "../app/router";

type Sort = "updated" | "name";

export function EffectsBrowserScreen(router: Router): Screen {
  installEffectsHomeStyles();
  const el = document.createElement("div");
  el.className = "screen screen--effects-lib";

  // Library names by id, for the fixture card's "Playing …" line.
  let namesById = new Map<string, string>();

  // -- fixture card: what the app is connected to + the one next step --------
  const card = document.createElement("section");
  card.className = "fxhome-card";
  function renderCard(): void {
    const devId = deviceStore.activeId();
    const playingId = appState.client?.isConnected ? nowPlaying.get(devId) : null;
    const m = fixtureCard({
      state: appState.status.state,
      deviceName: appState.client?.welcome?.deviceName || deviceStore.active()?.label || null,
      playing: playingId ? namesById.get(playingId) ?? null : null,
    });
    card.dataset["kind"] = m.kind;
    const head = document.createElement("div");
    head.className = "fxhome-card-head";
    const dot = document.createElement("span");
    dot.className = "fxhome-card-dot";
    const title = document.createElement("h2");
    title.className = "fxhome-card-title";
    title.textContent = m.title;
    head.append(dot, title);
    const body = document.createElement("p");
    body.className = "fxhome-card-body";
    body.textContent = m.body;
    card.replaceChildren(head, body);
    if (m.action) {
      card.append(Button({ label: m.action.label, block: true, onClick: () => openDeviceSheet() }));
    }
  }

  // Ask the device what it's running (an effect played from another phone, or
  // before this session) so the card + "Playing" badge are right on arrival.
  let askedClient: unknown = null;
  function hydratePlaying(): void {
    const c = appState.client;
    if (!c?.isConnected || askedClient === c) return;
    askedClient = c;
    const devId = deviceStore.activeId();
    void c
      .getEffectUniforms()
      .then((r) => {
        if (r.effectId && !nowPlaying.get(devId)) nowPlaying.set(devId, r.effectId);
      })
      .catch(() => undefined);
  }

  let search = "";
  let activeTags: string[] = [];
  let sort: Sort = "updated";

  // FUG-110: effects the app has pushed to the connected device (green badge +
  // the "On <device>" section). Recomputed each refresh; `row()` reads it.
  let onDeviceIds = new Set<string>();
  let deviceName = "";

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
    if (isAiConfigured()) return; // a provider configured → nothing to prompt
    if (prefs.getAiHintDismissed()) return; // user dismissed it once → gone for good
    const tip = HelpTip({
      label: "About AI generation",
      title: "AI generation",
      body: "Generate effects and map MIDI from a text prompt. Start free with OpenRouter's free models, or bring your own key, endpoint or on-device model.",
      align: "right",
      // First-run hint: nothing configured yet, so surface it expanded on arrival
      // rather than hiding it behind a "?" the user has to discover.
      defaultOpen: true,
      // Once the user dismisses it (outside tap / Escape / tapping "?"), record
      // that and drop the affordance for good — it won't pop again.
      onDismiss: () => {
        prefs.setAiHintDismissed();
        renderAiHelp();
      },
      action: {
        label: "Set up AI",
        icon: "sparkles",
        onClick: () => {
          void openModelSetup().then(() => renderAiHelp());
        },
      },
    });
    aiTip = tip;
    aiHelp.appendChild(tip.el);
  }
  renderAiHelp();

  // Toolbar row: the search field takes the space; the "?" tip floats at its end.
  const toolbar = document.createElement("div");
  toolbar.className = "fxlib-toolbar";
  // Show Mode (cue + crossfade) lives in the app-bar ⋯ menu as a tab-context
  // action. (The "Connect debug server" affordance moved to Settings ▸ Debugging.)
  const tabMenuItems = [
    {
      icon: "effect-to-device" as const,
      label: "Show mode (cue + crossfade)",
      onClick: () => router.navigate("/show"),
    },
  ];
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

  el.append(card, toolbar, tagRow, listEl);

  // Build the ephemeral "On <device>" section (FUG-110): the effects the app
  // has pushed to the currently-connected device, in most-recently-cued order.
  // Null when offline or nothing has been sent to this device yet.
  function deviceSection(all: StoredEffect[]): HTMLElement | null {
    if (onDeviceIds.size === 0) return null;
    const byId = new Map(all.map((e) => [e.id, e]));
    const devId = deviceStore.activeId();
    const ordered = deviceEffects
      .list(devId)
      .map((id) => byId.get(id))
      .filter((e): e is StoredEffect => e !== undefined);
    if (ordered.length === 0) return null;

    const section = document.createElement("div");
    section.className = "fxlib-devsection";
    const header = document.createElement("div");
    header.className = "fxlib-devsection-head";
    header.append(icon("device"));
    const label = document.createElement("span");
    label.textContent = `On ${deviceName || "device"}`;
    header.append(label);
    const count = document.createElement("span");
    count.className = "fxlib-devsection-count metric";
    count.textContent = String(ordered.length);
    header.append(count);
    section.append(header);
    for (const e of ordered) section.append(row(e));
    return section;
  }

  async function refresh(): Promise<void> {
    // Which effects live on the connected device (drives the badge + section).
    const devId = appState.client?.isConnected ? deviceStore.activeId() : null;
    onDeviceIds = new Set(devId ? deviceEffects.list(devId) : []);
    deviceName = appState.client?.welcome?.deviceName || deviceStore.active()?.label || "";

    const all = await effectStore.list();
    namesById = new Map(all.map((e) => [e.id, e.name]));
    renderCard();
    // Chips only for the user's own tags (plus any filter already on): the
    // seeded #starter/#demo/#test tags are what the sections already say.
    tagRow.replaceChildren();
    for (const tag of [...new Set([...userTags(all), ...activeTags])].sort()) {
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
    // Ephemeral device section first (only when unfiltered, so the search view
    // stays a flat match list), then the normal folder-grouped library.
    if (search || activeTags.length > 0) {
      appendGrouped(listEl, rows, (e) => e.folder, row, { scope: "effects" });
      return;
    }
    const section = deviceSection(all);
    if (section) listEl.append(section);
    for (const sec of effectSections(rows)) {
      const head = document.createElement("h3");
      head.className = "fxhome-section-head";
      head.dataset["section"] = sec.id;
      head.textContent = sec.title;
      listEl.append(head);
      if (sec.id === "mine") appendGrouped(listEl, sec.items, (e) => e.folder, row, { scope: "effects" });
      else for (const e of sec.items) listEl.append(row(e));
    }
  }

  function row(e: StoredEffect): HTMLElement {
    const r = document.createElement("div");
    r.className = "map-row";
    r.setAttribute("role", "button");
    r.tabIndex = 0;
    r.setAttribute("aria-label", `Play ${e.name}`);
    // Tap = play it on the fixture + tune (the editor is one step in).
    const open = (): void => openEffectTune(router, e);
    r.addEventListener("click", open);
    r.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
    const devId = appState.client?.isConnected ? deviceStore.activeId() : null;
    const isPlaying = devId !== null && nowPlaying.get(devId) === e.id;
    if (isPlaying) r.classList.add("fxhome-row--playing");

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
    // Green "on device" badge (FUG-110) when this effect has been pushed to the
    // connected device.
    if (onDeviceIds.has(e.id)) {
      const badge = document.createElement("span");
      badge.className = "fx-device-badge";
      badge.title = `On ${deviceName || "device"}`;
      badge.setAttribute("aria-label", `On ${deviceName || "device"}`);
      name.append(badge);
    }
    // Built-ins: one plain line about the look (their seed date means nothing).
    const blurb = starterBlurb(e.id);
    if (blurb) {
      const b = document.createElement("div");
      b.className = "fxhome-blurb";
      b.textContent = blurb;
      info.append(name, b);
    } else {
      const meta = document.createElement("div");
      meta.className = "map-meta metric";
      meta.textContent = shortDate(e.updatedAt);
      info.append(name, meta);
    }
    if (isPlaying) {
      const p = document.createElement("div");
      p.className = "fxhome-playing";
      p.textContent = "Playing";
      info.append(p);
    }
    if (e.tags.length > 0 && !isStarter(e) && !isExample(e)) {
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
          label: builtin ? "Open in editor" : "Edit",
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
                deviceEffects.forgetEverywhere(e.id); // no stale badge/section entry
                toast("Deleted");
                void refresh();
              });
            });
          },
        },
      ]),
    );
  }

  // Repaint the badge + device section when the device connection or the
  // on-device set changes (e.g. a cue from Show Mode, or a reconnect).
  const unsubs: Array<() => void> = [];

  return {
    el,
    onMount: () => {
      document.body.appendChild(fab);
      setTabMenuItems(tabMenuItems);
      unsubs.push(
        appState.subscribe(() => {
          hydratePlaying();
          void refresh();
        }),
      );
      unsubs.push(deviceEffects.subscribe(() => void refresh()));
      unsubs.push(nowPlaying.subscribe(() => void refresh()));
      hydratePlaying();
      void refresh();
    },
    onUnmount: () => {
      aiTip?.close();
      fab.remove();
      tiles.dispose();
      setTabMenuItems([]);
      for (const u of unsubs) u();
      unsubs.length = 0;
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
