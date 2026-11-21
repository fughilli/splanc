/**
 * Device settings: the "Stored effects" section (firmware feature
 * "effect_store"; docs/design/effect-store.md). Lists the compiled effects kept
 * on the device; tapping one opens its own sheet, which plays it (loads it onto
 * deck A and makes it the running effect, which the device also resumes on
 * boot), then shows its uniforms as live controls, and deletes it.
 *
 * One primary action per screen: the list only opens an effect; the effect's
 * sheet has "Play on this device" as its primary and "Delete from device" on its
 * own row below the controls.
 *
 * Effects get into the store from the effect editor ("Store on device") or any
 * client sending submit_effect{store: true}: the device needn't have come from
 * this phone's library, so the controls come from the manifest the device
 * reports, not from a local source.
 */

import { Button, Sheet, confirmDialog, icon, toast } from "../kit";
import { UniformPanel } from "../../effects/editor/uniform-panel";
import {
  displayName,
  normalizeStoredEffects,
  storeErrorText,
  storeUsage,
  storedEffectDetail,
  uniformsFromManifest,
  type StoredEffectEntry,
  type StoredEffects,
} from "../../net/effectStore";
import type {
  EffectUniformsMessage,
  StoredEffectListMessage,
  UniformValueFlat,
} from "../../net/proto";
import { installStoredEffectsStyles } from "./storedEffects.css";

export interface StoredEffectsClient {
  listStoredEffects(): Promise<StoredEffectListMessage>;
  loadStoredEffect(effectId: string, deck?: number, activate?: boolean): Promise<unknown>;
  deleteStoredEffect(effectId: string): Promise<StoredEffectListMessage>;
  getEffectUniforms(effectId?: string, deck?: number): Promise<EffectUniformsMessage>;
  /** A committed set (persisted on the device: the opened effect boots with it). */
  setUniforms(values: UniformValueFlat[], commit?: boolean, deck?: number): boolean;
  readonly live: { setUniform(slot: number, value: number[], deck?: number): void };
}

/** Quiet time after the last control move before the values are committed. */
const COMMIT_AFTER_MS = 800;

/** Whether `e` is the running deck-A effect. */
const playing = (e: StoredEffectEntry): boolean => e.decks.includes(0);

export function StoredEffectsSection(client: StoredEffectsClient): HTMLElement {
  installStoredEffectsStyles();
  const el = document.createElement("div");
  el.className = "stored-effects";
  let store: StoredEffects | null = null;

  const render = (): void => {
    el.replaceChildren();
    const h = document.createElement("div");
    h.className = "device-detail-cap";
    h.textContent = "Stored effects";
    el.append(h);
    if (store === null) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Reading…";
      el.append(p);
      return;
    }
    const usage = document.createElement("p");
    usage.className = "muted stored-effects-usage";
    usage.textContent =
      store.effects.length === 0
        ? "None yet. Store one from the effect editor (Store on device)."
        : storeUsage(store);
    el.append(usage);
    const list = document.createElement("ul");
    list.className = "stored-effects-list";
    for (const e of store.effects) {
      const li = document.createElement("li");
      li.className = "stored-effects-row";
      li.dataset["effectId"] = e.effectId;
      // The whole row is the one control: it opens the effect's sheet.
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stored-effects-open";
      btn.setAttribute("aria-label", `Open ${displayName(e)}`);
      const text = document.createElement("div");
      text.className = "stored-effects-text";
      const name = document.createElement("div");
      name.className = "stored-effects-name";
      name.textContent = displayName(e);
      const detail = document.createElement("div");
      detail.className = "muted stored-effects-detail";
      detail.textContent = storedEffectDetail(e);
      text.append(name, detail);
      btn.append(text);
      if (playing(e)) {
        const badge = document.createElement("span");
        badge.className = "stored-effects-badge";
        badge.textContent = "Playing";
        btn.append(badge);
      }
      btn.append(icon("chevron"));
      btn.addEventListener("click", () => openSheet(e.effectId));
      li.append(btn);
      list.append(li);
    }
    el.append(list);
  };

  const refresh = async (): Promise<void> => {
    try {
      store = normalizeStoredEffects(await client.listStoredEffects());
    } catch (e) {
      toast(storeErrorText(e), { error: true });
    }
    render();
  };

  /** The effect's own sheet: play it, tune it, delete it. */
  const openSheet = (effectId: string): void => {
    const find = (): StoredEffectEntry | undefined => store?.effects.find((x) => x.effectId === effectId);
    const first = find();
    if (!first) return;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    let controls = false;
    const sheet = Sheet(displayName(first), {
      onClose: () => {
        if (commitTimer !== null) {
          clearTimeout(commitTimer);
          commitTimer = null;
          client.setUniforms(panel.values(), true);
        }
      },
    });
    sheet.body.classList.add("stored-effect-sheet");

    const panelHost = document.createElement("div");
    panelHost.className = "uniform-panel stored-effects-uniforms";
    const panel = new UniformPanel(panelHost, (slot, value) => {
      client.live.setUniform(slot, value);
      if (commitTimer !== null) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        commitTimer = null;
        client.setUniforms(panel.values(), true);
      }, COMMIT_AFTER_MS);
    });

    const draw = (): void => {
      const e = find();
      sheet.body.replaceChildren();
      if (!e) return;
      const detail = document.createElement("p");
      detail.className = "muted stored-effect-detail";
      detail.textContent = storedEffectDetail(e);
      sheet.body.append(detail);
      const isPlaying = playing(e) && controls;
      sheet.body.append(
        Button({
          label: isPlaying ? "Playing on this device" : "Play on this device",
          variant: isPlaying ? "quiet" : "primary",
          block: true,
          icon: "play",
          disabled: busy || isPlaying,
          onClick: () => void play(),
        }),
      );
      if (controls) {
        const cap = document.createElement("div");
        cap.className = "device-detail-cap stored-effect-controls-cap";
        cap.textContent = "Controls";
        sheet.body.append(cap, panelHost);
      }
      const del = Button({
        label: "Delete from device",
        variant: "quiet",
        block: true,
        disabled: busy,
        onClick: () => void remove(),
      });
      del.classList.add("stored-effect-delete");
      sheet.body.append(del);
    };

    const run = async (what: () => Promise<void>): Promise<void> => {
      if (busy) return;
      busy = true;
      draw();
      try {
        await what();
      } catch (e) {
        toast(storeErrorText(e), { error: true });
      } finally {
        busy = false;
        draw();
        render();
      }
    };

    const play = (): Promise<void> =>
      run(async () => {
        await client.loadStoredEffect(effectId, 0, true);
        // The device now runs it: its manifest + live values drive the controls.
        const u = await client.getEffectUniforms();
        panel.setManifest(uniformsFromManifest(u.manifest));
        panel.hydrate(u.current.map((x) => ({ slot: x.slot, value: x.value })));
        controls = true;
        store = normalizeStoredEffects(await client.listStoredEffects());
        toast(`Playing ${displayName(find() ?? { name: "", effectId })}`);
      });

    const remove = async (): Promise<void> => {
      const e = find();
      const ok = await confirmDialog({
        title: "Delete stored effect?",
        message: `Remove “${e ? displayName(e) : effectId}” from the device? What is playing keeps playing.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      await run(async () => {
        store = normalizeStoredEffects(await client.deleteStoredEffect(effectId));
      });
      if (!find()) sheet.close();
    };

    draw();
  };

  render();
  void refresh();
  return el;
}
