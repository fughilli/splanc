/**
 * The on-device effect store, app side (src/net/effectStore.ts,
 * docs/design/effect-store.md): the wire arms through the real proto boundary,
 * the reply normalization and wording, the manifest -> uniform controls step, and
 * the device sheet's "Stored effects" section on the fake DOM: list, open (load
 * onto deck A, then the opened effect's uniforms as live controls that commit),
 * and delete.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { flushAsync } from "./onDeviceFakes";
import { installFakeDom, asFake, fire, textOf } from "./fakeDom";

installFakeDom();

import { decodeClient, decodeServer, encodeClient, encodeServer } from "../src/net/proto";
import {
  deviceHasEffectStore,
  displayName,
  normalizeStoredEffects,
  storeErrorText,
  storeUsage,
  storedEffectDetail,
  uniformsFromManifest,
} from "../src/net/effectStore";
import { StoredEffectsSection, type StoredEffectsClient } from "../src/ui/screens/storedEffectsSection";
import type { StoredEffectListMessage } from "../src/net/proto";

type CMsg = Parameters<typeof encodeClient>[0];
type SMsg = Parameters<typeof encodeServer>[0];

test("effect store arms round-trip", () => {
  const store = { type: "submit_effect", effectId: "plasma", fxb: new Uint8Array([1, 2, 3]), store: true, name: "Plasma" };
  const back = decodeClient(encodeClient(store as unknown as CMsg)) as unknown as typeof store;
  assert.equal(back.store, true);
  assert.equal(back.name, "Plasma");
  assert.deepEqual([...back.fxb], [1, 2, 3]);
  const load = { type: "load_stored_effect", effectId: "plasma", deck: 1, activate: true } as const;
  assert.deepEqual(decodeClient(encodeClient(load as unknown as CMsg)), load);
  assert.deepEqual(decodeClient(encodeClient({ type: "list_stored_effects" } as unknown as CMsg)), {
    type: "list_stored_effects",
  });
  const del = { type: "delete_stored_effect", effectId: "plasma" } as const;
  assert.deepEqual(decodeClient(encodeClient(del as unknown as CMsg)), del);
  const list = {
    type: "stored_effect_list",
    effects: [{ effectId: "plasma", name: "Plasma", fxbBytes: 812, uniforms: ["tint", "speed"], decks: [0] }],
    capacity: 8,
  } as const;
  assert.deepEqual(decodeServer(encodeServer(list as unknown as SMsg)), list);
});

test("normalizeStoredEffects fills proto3 defaults and sorts by name", () => {
  const s = normalizeStoredEffects({
    type: "stored_effect_list",
    effects: [{ effectId: "zz", name: "Aurora" }, { effectId: "aa" }, { effectId: "mm", name: "Breathe", decks: [1] }],
    capacity: 8,
  });
  assert.deepEqual(
    s.effects.map((e) => [displayName(e), e.fxbBytes, e.uniforms, e.decks]),
    [
      ["aa", 0, [], []],
      ["Aurora", 0, [], []],
      ["Breathe", 0, [], [1]],
    ],
  );
  assert.equal(storeUsage(s), "3 of 8 stored");
  assert.deepEqual(normalizeStoredEffects(undefined), { effects: [], capacity: 0 });
});

test("detail line, feature flag, error wording", () => {
  assert.equal(
    storedEffectDetail({ effectId: "a", name: "", fxbBytes: 2150, uniforms: ["speed", "tint"], decks: [0] }),
    "2.1 KB · speed, tint · on deck A",
  );
  assert.equal(storedEffectDetail({ effectId: "a", name: "", fxbBytes: 300, uniforms: [], decks: [1] }), "300 B · on deck B");
  assert.ok(deviceHasEffectStore({ features: ["effects", "effect_store"] }));
  assert.ok(!deviceHasEffectStore({ features: ["effects"] }));
  assert.ok(!deviceHasEffectStore(null));
  assert.match(storeErrorText({ code: "store_full" }), /full/);
  assert.match(storeErrorText(new Error("boom")), /boom/);
});

test("uniformsFromManifest: the compiler JSON, tolerant of junk", () => {
  const m = new TextEncoder().encode(
    JSON.stringify([
      { name: "speed", slot: 3, width: 1, ui: "slider", default: [1], min: 0, max: 4 },
      { name: "tint", slot: 0, width: 3, ui: "color", default: [1, 0, 0] },
      { slot: 9 },
    ]),
  );
  assert.deepEqual(
    uniformsFromManifest(m).map((u) => [u.name, u.slot]),
    [
      ["speed", 3],
      ["tint", 0],
    ],
  );
  assert.deepEqual(uniformsFromManifest(new TextEncoder().encode("{not json")), []);
  assert.deepEqual(uniformsFromManifest(undefined), []);
});

function fakeClient() {
  let effects = [
    { effectId: "plasma", name: "Plasma", fxbBytes: 900, uniforms: ["speed"], decks: [] as number[] },
    { effectId: "hot-spots", name: "Hot spots", fxbBytes: 1200, uniforms: [], decks: [] as number[] },
  ];
  const calls: string[] = [];
  const committed: { slot: number; value: number[] }[][] = [];
  const live: [number, number[]][] = [];
  const reply = (): StoredEffectListMessage => ({ type: "stored_effect_list", effects: effects.map((e) => ({ ...e })), capacity: 8 });
  const client: StoredEffectsClient = {
    listStoredEffects: async () => (calls.push("list"), reply()),
    loadStoredEffect: async (id, deck, activate) => {
      calls.push(`load ${id} ${deck} ${activate}`);
      effects = effects.map((e) => ({ ...e, decks: e.effectId === id ? [0] : [] }));
      return { type: "result_ready" };
    },
    deleteStoredEffect: async (id) => {
      calls.push(`delete ${id}`);
      effects = effects.filter((e) => e.effectId !== id);
      return reply();
    },
    getEffectUniforms: async () => ({
      type: "effect_uniforms",
      effectId: "plasma",
      manifest: new TextEncoder().encode(
        JSON.stringify([{ name: "speed", slot: 3, width: 1, ui: { kind: "slider" }, default: [1], min: 0, max: 4 }]),
      ),
      current: [{ slot: 3, value: [2] }],
    }),
    setUniforms: (values) => (committed.push(values), true),
    live: { setUniform: (slot, value) => void live.push([slot, value]) },
  };
  return { client, calls, committed, live };
}

test("Stored effects section: list, open with live uniforms, delete", async () => {
  const f = fakeClient();
  const el = asFake(StoredEffectsSection(f.client));
  await flushAsync();
  const rows = el.querySelectorAll(".stored-effects-row");
  assert.deepEqual(
    rows.map((r) => textOf(r.querySelector(".stored-effects-name"))),
    ["Hot spots", "Plasma"],
  );
  assert.match(textOf(el), /2 of 8 stored/);

  // Open: loads onto deck A, activated, and shows its uniforms as controls.
  const plasmaRow = () => el.querySelectorAll(".stored-effects-row").find((r) => r.dataset["effectId"] === "plasma")!;
  const openBtn = plasmaRow().querySelectorAll("button").find((b) => textOf(b) === "Open")!;
  fire(openBtn, "click");
  await flushAsync();
  assert.ok(f.calls.includes("load plasma 0 true"));
  assert.match(textOf(plasmaRow()), /on deck A/);
  const slider = el.querySelector(".stored-effects-uniforms input");
  assert.ok(slider, "the opened effect's uniform panel is shown");
  // A move goes out live at once, then commits once the controls are quiet.
  (slider as unknown as { value: string }).value = "3";
  fire(slider!, "input");
  assert.deepEqual(f.live.at(-1)?.[0], 3);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(f.committed.length, 1);
  assert.equal(f.committed[0]![0]!.slot, 3);

  // Delete asks first; confirmed, the row goes.
  const delBtn = plasmaRow().querySelectorAll("button").find((b) => textOf(b) === "Delete")!;
  fire(delBtn, "click");
  await flushAsync();
  const confirm = asFake(document.body).querySelectorAll("button").find((b) => textOf(b) === "Delete" && b !== delBtn);
  assert.ok(confirm, "a confirmation dialog");
  fire(confirm!, "click");
  await flushAsync();
  assert.ok(f.calls.includes("delete plasma"));
  assert.deepEqual(
    el.querySelectorAll(".stored-effects-row").map((r) => r.dataset["effectId"]),
    ["hot-spots"],
  );
  assert.equal(el.querySelector(".stored-effects-uniforms"), null, "the deleted effect's controls go too");
});
