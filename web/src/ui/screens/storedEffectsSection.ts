/**
 * Device settings: the "Stored effects" section (firmware feature
 * "effect_store"; docs/design/effect-store.md). Lists the compiled effects kept
 * on the device, opens one (loads it onto deck A and makes it the running
 * effect, which the device also resumes on boot), shows the opened effect's
 * uniforms as live controls, and deletes one.
 *
 * Effects get into the store from the effect editor ("Store on device") or any
 * client sending submit_effect{store: true}: the device needn't have come from
 * this phone's library, so the controls come from the manifest the device
 * reports, not from a local source.
 */

import { Button, confirmDialog, toast } from "../kit";
import { UniformPanel } from "../../effects/editor/uniform-panel";
import {
  displayName,
  normalizeStoredEffects,
  storeErrorText,
  storeUsage,
  storedEffectDetail,
  uniformsFromManifest,
  type StoredEffects,
} from "../../net/effectStore";
import type {
  EffectUniformsMessage,
  StoredEffectListMessage,
  UniformValueFlat,
} from "../../net/proto";

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

export function StoredEffectsSection(client: StoredEffectsClient): HTMLElement {
  const el = document.createElement("div");
  el.className = "stored-effects";
  let store: StoredEffects | null = null;
  let opened: string | null = null;
  let busy = false;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

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
      const text = document.createElement("div");
      const name = document.createElement("div");
      name.className = "stored-effects-name";
      name.textContent = displayName(e);
      const detail = document.createElement("div");
      detail.className = "muted stored-effects-detail";
      detail.textContent = storedEffectDetail(e);
      text.append(name, detail);
      const btns = document.createElement("div");
      btns.className = "btn-row";
      btns.append(
        Button({
          label: opened === e.effectId ? "Opened" : "Open",
          variant: opened === e.effectId ? "quiet" : "primary",
          disabled: busy,
          onClick: () => void open(e.effectId),
        }),
        Button({ label: "Delete", variant: "danger", disabled: busy, onClick: () => void remove(e.effectId) }),
      );
      li.append(text, btns);
      list.append(li);
    }
    el.append(list);
    if (opened !== null) el.append(panelHost);
  };

  const run = async (what: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      await what();
    } catch (e) {
      toast(storeErrorText(e), { error: true });
    } finally {
      busy = false;
      render();
    }
  };

  const refresh = (): Promise<void> =>
    run(async () => {
      store = normalizeStoredEffects(await client.listStoredEffects());
    });

  const open = (effectId: string): Promise<void> =>
    run(async () => {
      await client.loadStoredEffect(effectId, 0, true);
      // The device now runs it: its manifest + live values drive the controls.
      const u = await client.getEffectUniforms();
      panel.setManifest(uniformsFromManifest(u.manifest));
      panel.hydrate(u.current.map((x) => ({ slot: x.slot, value: x.value })));
      opened = effectId;
      store = normalizeStoredEffects(await client.listStoredEffects());
      toast(`Playing ${displayName(store.effects.find((x) => x.effectId === effectId) ?? { name: "", effectId })}`);
    });

  const remove = async (effectId: string): Promise<void> => {
    const e = store?.effects.find((x) => x.effectId === effectId);
    const ok = await confirmDialog({
      title: "Delete stored effect?",
      message: `Remove “${e ? displayName(e) : effectId}” from the device? What is playing keeps playing.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      store = normalizeStoredEffects(await client.deleteStoredEffect(effectId));
      if (opened === effectId) opened = null;
    });
  };

  render();
  void refresh();
  return el;
}
