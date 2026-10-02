/**
 * Visual output calibration — colour correction (PR-20, FUG-75): the per-channel
 * gamma + white-balance LUTs the device applies on the strip write path, and the
 * PWA surface that dials them in (ui/screens/colorCorrection.ts).
 *
 * colorCorrection.test.ts covers the LUT's qualitative properties and the wire
 * message. This suite pins:
 *   - the web mirror is the FIRMWARE's table (firmware/player_app/
 *     color_correction.h kWs2812b + build_lut), sampled value-for-value;
 *   - the reverse transfer and the curve-drag solver are exact inverses;
 *   - the screen: presets push live to the device (debounced, RAM-only, never
 *     a flash write per drag); Save commits; leaving with unsaved curves asks to
 *     save or discard (and discard restores the device); the live toggle; each
 *     device remembers its own curves; dragging the plot reshapes the nearest
 *     channel; white-balance levels; the palette preview renders exactly the
 *     device LUT; and the colour-test gradient loads with live controls.
 * The compiler wasm is not available under node, so the colour-test flow runs
 * with fx/preview's compileScript replaced.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { installFakeDom, asFake, fire, textOf, typeInto, type FakeElement } from "./fakeDom";
import * as preview from "../src/fx/preview";
import {
  DEFAULT_PROFILE,
  GAMMA_MAX,
  GAMMA_MIN,
  PRESETS,
  balanceFactors,
  buildLut,
  gammaForPoint,
  inverseLut,
  transfer,
  type GammaProfile,
} from "../src/color/correction";
import { COLOR_TEST_ID, COLOR_TEST_SOURCE } from "../src/color/colorTestEffect";
import type { LedMapperClient } from "../src/net/client";
import type { Router, Screen } from "../src/ui/app/router";

// The screen modules are imported lazily (after this) so they see the fake DOM.
installFakeDom();

const preset = (id: string): GammaProfile => PRESETS.find((p) => p.id === id)!.profile;

// -- the LUT math --------------------------------------------------------------

test("the default profile and its LUT are the firmware's WS2812B table [rr:PR-20]", () => {
  // kWs2812b: gamma 2.8, luminance at the middle of the datasheet mcd bins
  // (R 550–700, G 1100–1400, B 200–400).
  assert.deepEqual(DEFAULT_PROFILE, {
    gamma: [2.8, 2.8, 2.8],
    luminance: [(550 + 700) / 2, (1100 + 1400) / 2, (200 + 400) / 2],
  });
  assert.equal(PRESETS[0]!.id, "ws2812b");

  // build_lut: clamp(ceil((v/255)^gamma * 255 * min_lum/lum)), sampled.
  const at = [1, 16, 32, 64, 96, 128, 160, 192, 224, 254, 255];
  const [r, g, b] = buildLut(DEFAULT_PROFILE);
  assert.deepEqual(at.map((v) => r[v]), [1, 1, 1, 3, 8, 18, 34, 56, 86, 122, 123]);
  assert.deepEqual(at.map((v) => g[v]), [1, 1, 1, 2, 4, 9, 17, 28, 43, 61, 62]);
  assert.deepEqual(at.map((v) => b[v]), [1, 1, 1, 6, 17, 38, 70, 116, 178, 253, 255]);
  // A non-positive gamma is treated as linear, as on the device.
  const lin = buildLut({ gamma: [0, -2, 1], luminance: [1, 1, 1] });
  for (const ch of lin) for (const v of at) assert.equal(ch[v], v);
});

test("the reverse transfer is the smallest input that reaches each output level [rr:PR-20]", () => {
  for (const id of ["ws2812b", "gamma22", "punchy"]) {
    for (const fwd of buildLut(preset(id))) {
      const inv = inverseLut(fwd);
      const top = fwd[255]!;
      for (let o = 0; o < 256; o++) {
        const v = inv[o]!;
        if (o <= top) {
          assert.ok(fwd[v]! >= o, `${id}: input ${v} does not reach ${o}`);
          assert.ok(v === 0 || fwd[v - 1]! < o, `${id}: ${v - 1} already reaches ${o}`);
        } else {
          assert.equal(v, 255, `${id}: unreachable level ${o} saturates`);
        }
      }
      // Undoing then redoing the correction is the identity on reachable levels.
      for (let v = 0; v < 256; v++) assert.equal(fwd[inv[fwd[v]!]!], fwd[v]);
    }
  }
});

test("a dragged point solves the channel's gamma, including white-balanced channels [rr:PR-20]", () => {
  const p: GammaProfile = { gamma: [2.8, 2.8, 2.8], luminance: [625, 1250, 300] };
  const gains = balanceFactors(p);
  for (const [c, x, y] of [
    [0, 0.5, 0.1],
    [1, 0.3, 0.01],
    [2, 0.7, 0.45],
  ] as const) {
    const g = gammaForPoint(x, y, gains[c]!);
    const q: GammaProfile = { gamma: [...p.gamma], luminance: [...p.luminance] };
    q.gamma[c] = g;
    assert.ok(Math.abs(transfer(q, c, x) - y) < 1e-9, `channel ${c} curve misses the dragged point`);
  }
  // Out-of-reach targets clamp to the authoring range instead of exploding.
  assert.equal(gammaForPoint(0.5, 0.9999, 1), GAMMA_MIN);
  assert.equal(gammaForPoint(0.5, 1e-6, 1), GAMMA_MAX);
});

// -- the colour-correction screen -------------------------------------------------

interface CcPush {
  gamma: number[] | null;
  luminance: number[] | null;
  commit: boolean | null;
}

/** A connected player that records what the screen sends it. */
class CcClient {
  readonly isConnected = true;
  readonly pushes: CcPush[] = [];
  readonly effects: { id: string; fxb: Uint8Array; activate: boolean }[] = [];
  readonly uniforms: { slot: number; value: number[] }[][] = [];
  async setColorCorrection(cc: {
    gamma?: number[];
    luminance?: number[];
    commit?: boolean;
  }): Promise<unknown> {
    this.pushes.push({
      gamma: cc.gamma ? [...cc.gamma] : null,
      luminance: cc.luminance ? [...cc.luminance] : null,
      commit: cc.commit ?? null,
    });
    return {};
  }
  async setBrightness(): Promise<unknown> {
    return {};
  }
  setUniforms(values: { slot: number; value: number[] }[]): boolean {
    this.uniforms.push(values.map((v) => ({ slot: v.slot, value: [...v.value] })));
    return true;
  }
  async submitEffect(id: string, fxb: Uint8Array, activate: boolean): Promise<unknown> {
    this.effects.push({ id, fxb, activate });
    return {};
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

let deviceSeq = 0;

/** Open the screen for a (fresh, unless `deviceUrl` is given) active device.
 * Callers enable fake timers first (the push debounce + toasts run on them). */
async function openScreen(
  t: TestContext,
  client: CcClient | null,
  deviceUrl = `wss://10.0.7.${++deviceSeq}/ws`,
): Promise<{ screen: Screen; el: FakeElement; deviceUrl: string }> {
  const { appState } = await import("../src/ui/app/state");
  const { deviceStore } = await import("../src/store/deviceStore");
  const { ColorCorrectionScreen } = await import("../src/ui/screens/colorCorrection");
  deviceStore.setActive(deviceStore.upsert(deviceUrl, "Porch").id);
  appState.client = client as unknown as LedMapperClient | null;
  const screen = ColorCorrectionScreen({ navigate() {} } as unknown as Router);
  t.after(() => {
    screen.onUnmount?.();
    appState.client = null;
  });
  return { screen, el: asFake(screen.el), deviceUrl };
}

function pickPreset(el: FakeElement, id: string): void {
  const sel = el.querySelector("select.cc-select")!;
  typeInto(sel, id, true);
}

function selectedPreset(el: FakeElement): string | undefined {
  return el
    .querySelectorAll("select.cc-select option")
    .find((o) => o.hasAttribute("selected"))?.value;
}

function slider(el: FakeElement, label: string): { input: FakeElement; shown: string } {
  const s = el.querySelectorAll(".k-slider").find((k) => textOf(k.querySelector("span")) === label);
  assert.ok(s, `no slider "${label}"`);
  return { input: s.querySelector("input")!, shown: textOf(s.querySelector(".k-slider-val")) };
}

function button(el: FakeElement, label: string): FakeElement {
  const b = el.querySelectorAll("button").find((x) => textOf(x) === label);
  assert.ok(b, `no button "${label}"`);
  return b;
}

function toastsSaying(text: string): number {
  return asFake(document.body)
    .querySelectorAll(".k-toast")
    .filter((n) => textOf(n) === text).length;
}

test("choosing a preset previews it on the strip live — debounced and not written to flash [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CcClient();
  const { el } = await openScreen(t, client);
  assert.equal(selectedPreset(el), "ws2812b", "a fresh device starts on the WS2812B default");

  pickPreset(el, "gamma22");
  t.mock.timers.tick(199);
  assert.equal(client.pushes.length, 0, "debounced: nothing sent mid-gesture");
  t.mock.timers.tick(1);
  assert.deepEqual(client.pushes, [{ gamma: [2.2, 2.2, 2.2], luminance: [1, 1, 1], commit: false }]);

  // A burst of changes collapses into one push of the final curves.
  pickPreset(el, "punchy");
  t.mock.timers.tick(100);
  pickPreset(el, "linear");
  t.mock.timers.tick(200);
  assert.equal(client.pushes.length, 2);
  assert.deepEqual(client.pushes[1], { gamma: [1, 1, 1], luminance: [1, 1, 1], commit: false });
});

test("Save commits the curves to the device and stays green until the next edit [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CcClient();
  const { el } = await openScreen(t, client);
  pickPreset(el, "punchy");
  const before = toastsSaying("Saved to device");

  button(el, "Save to device").click();
  await flush();
  assert.deepEqual(client.pushes.at(-1), { gamma: [3, 3, 3], luminance: [1, 1, 1], commit: true });
  assert.equal(toastsSaying("Saved to device"), before + 1);
  assert.ok(el.querySelector("button.cc-save")!.classList.contains("cc-save--ok"));

  typeInto(slider(el, "R gamma").input, "2.5");
  const save = el.querySelector("button.cc-save")!;
  assert.ok(!save.classList.contains("cc-save--ok"), "an edit un-greens Save");
});

test("leaving with unsaved curves asks first; Discard puts the device back on the saved curves [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CcClient();
  const { screen, el } = await openScreen(t, client);

  // Nothing changed: leave without a prompt.
  assert.equal(await screen.beforeLeave!(), true);

  pickPreset(el, "punchy");
  t.mock.timers.tick(200);
  const leaving = screen.beforeLeave!();
  const dialogs = asFake(document.body).querySelectorAll(".k-confirm");
  const dialog = dialogs.at(-1)!;
  assert.equal(textOf(dialog.querySelector(".k-confirm-title")), "Unsaved changes");
  button(dialog, "Discard").click();
  assert.equal(await leaving, true);
  // The device is restored (live, RAM-only) to the curves it had saved.
  assert.deepEqual(client.pushes.at(-1), {
    gamma: [...DEFAULT_PROFILE.gamma],
    luminance: [...DEFAULT_PROFILE.luminance],
    commit: false,
  });
  assert.equal(selectedPreset(el), "ws2812b");

  // Save from the prompt commits instead.
  pickPreset(el, "gamma22");
  const again = screen.beforeLeave!();
  button(asFake(document.body).querySelectorAll(".k-confirm").at(-1)!, "Save").click();
  assert.equal(await again, true);
  assert.deepEqual(client.pushes.at(-1), { gamma: [2.2, 2.2, 2.2], luminance: [1, 1, 1], commit: true });
});

test("with live update off edits stay local; switching it on resyncs the strip at once [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CcClient();
  const { el } = await openScreen(t, client);
  el.querySelector("button.k-switch")!.click(); // live off
  pickPreset(el, "gamma22");
  t.mock.timers.tick(1000);
  assert.equal(client.pushes.length, 0);

  el.querySelector("button.k-switch")!.click(); // live on again
  assert.deepEqual(client.pushes, [{ gamma: [2.2, 2.2, 2.2], luminance: [1, 1, 1], commit: false }]);
});

test("each device reopens on its own last curves [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = await openScreen(t, null);
  pickPreset(first.el, "punchy");
  typeInto(slider(first.el, "G gamma").input, "2.4");

  // Reopen for the same device: the tweak is still there (shown as Custom).
  const again = await openScreen(t, null, first.deviceUrl);
  assert.equal(selectedPreset(again.el), "__custom");
  assert.equal(slider(again.el, "R gamma").shown, "3.00");
  assert.equal(slider(again.el, "G gamma").shown, "2.40");

  // Another device is unaffected.
  const other = await openScreen(t, null);
  assert.equal(selectedPreset(other.el), "ws2812b");
  assert.equal(slider(other.el, "G gamma").shown, "2.80");
  // Offline, Save is unavailable rather than silently dropped.
  assert.ok(button(other.el, "Connect a device to save").hasAttribute("disabled"));
});

test("dragging the plot reshapes the nearest channel's curve through the pointer [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CcClient();
  const { el } = await openScreen(t, client);
  const plot = el.querySelector("canvas.cc-plot")!;
  plot.rect = { x: 0, y: 0, width: 320, height: 220 }; // CSS size == the drawing size
  // Plot space: x = (px − 10) / 300, y = 1 − (py − 10) / 200.
  const at = (x: number, y: number): Record<string, number> => ({
    clientX: 10 + x * 300,
    clientY: 10 + (1 - y) * 200,
    pointerId: 7,
  });
  // At x=0.5 the curves sit at B≈0.14, R≈0.07, G≈0.03: y=0.3 grabs blue.
  fire(plot, "pointerdown", at(0.5, 0.3));
  fire(plot, "pointermove", at(0.5, 0.25));
  fire(plot, "pointerup", at(0.5, 0.25));
  t.mock.timers.tick(200);

  const pushed = client.pushes.at(-1)!;
  assert.deepEqual(pushed.gamma!.slice(0, 2), [2.8, 2.8], "red/green untouched");
  const blue = pushed.gamma![2]!;
  assert.ok(Math.abs(blue - 2) < 1e-9, `blue gamma ${blue} should pass through (0.5, 0.25)`);
  assert.equal(slider(el, "B gamma").shown, "2.00", "the slider follows the drag on release");
});

test("on a gain-normalised profile a white-balance level dims just that channel's white [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CcClient();
  const { el } = await openScreen(t, client);
  pickPreset(el, "gamma22"); // equal luminance: every channel at 100%
  assert.equal(slider(el, "G level").shown, "100%");
  typeInto(slider(el, "G level").input, "0.5");
  t.mock.timers.tick(200);
  const p = client.pushes.at(-1)!;
  const [r, g, b] = buildLut({
    gamma: p.gamma as GammaProfile["gamma"],
    luminance: p.luminance as GammaProfile["luminance"],
  });
  assert.deepEqual([r[255], g[255], b[255]], [255, 128, 255]);
});

test("the palette preview shows exactly what the device LUT outputs for the current curves [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { el } = await openScreen(t, new CcClient());
  const bar = (caption: string): FakeElement =>
    el
      .querySelectorAll(".cc-sim-row")
      .find((r) => textOf(r.querySelector(".cc-sim-cap")) === caption)!
      .querySelector("canvas")!;
  const captured = new Map<string, Uint8ClampedArray>();
  for (const cap of [
    "Grayscale — on device (forward)",
    "Grayscale — reverse",
    "Hue sweep — input",
    "Hue sweep — on device (forward)",
  ]) {
    const ctx = bar(cap).getContext("2d")!;
    ctx["createImageData"] = (w: number, h: number) => {
      const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      captured.set(cap, img.data);
      return img;
    };
  }
  pickPreset(el, "punchy"); // repaints the preview for the new curves
  const [fR, fG, fB] = buildLut(preset("punchy"));
  const fwd = captured.get("Grayscale — on device (forward)")!;
  const rev = captured.get("Grayscale — reverse")!;
  const hueIn = captured.get("Hue sweep — input")!;
  const hueOut = captured.get("Hue sweep — on device (forward)")!;
  const [iR, iG, iB] = [inverseLut(fR), inverseLut(fG), inverseLut(fB)];
  for (let x = 0; x < 256; x++) {
    assert.deepEqual([...fwd.subarray(x * 4, x * 4 + 4)], [fR[x], fG[x], fB[x], 255], `grey ${x}`);
    assert.deepEqual([...rev.subarray(x * 4, x * 4 + 3)], [iR[x], iG[x], iB[x]], `reverse ${x}`);
    const [hr, hg, hb] = [hueIn[x * 4]!, hueIn[x * 4 + 1]!, hueIn[x * 4 + 2]!];
    assert.deepEqual([...hueOut.subarray(x * 4, x * 4 + 3)], [fR[hr], fG[hg], fB[hb]], `hue ${x}`);
  }
});

test("the colour-test gradient loads onto the strip with live endpoint, start and span controls [rr:PR-20]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The documented controls: two endpoint colours, the first lit LED, the span.
  assert.match(COLOR_TEST_SOURCE, /uniform vec3 colorA : color/);
  assert.match(COLOR_TEST_SOURCE, /uniform vec3 colorB : color/);
  assert.match(COLOR_TEST_SOURCE, /uniform float start : 0\.0 \.\. 255\.0/);
  assert.match(COLOR_TEST_SOURCE, /uniform float span : 1\.0 \.\. 256\.0/);

  const bytecode = new Uint8Array([0x46, 0x58, 0x42, 0x31, 1]);
  const compile = t.mock.method(preview, "compileScript", async (): Promise<preview.FxCompiled> => ({
    ok: true,
    bytecode,
    uniforms: [
      { name: "colorA", slot: 0, width: 3, ui: { kind: "color" }, default: [1, 0, 0] },
      { name: "colorB", slot: 3, width: 3, ui: { kind: "color" }, default: [0, 0, 1] },
      {
        name: "start",
        slot: 6,
        width: 1,
        ui: { kind: "slider", min: 0, max: 255, step: 1 },
        default: [0],
      },
      {
        name: "span",
        slot: 7,
        width: 1,
        ui: { kind: "slider", min: 1, max: 256, step: 1 },
        default: [10],
      },
    ],
    diagnostics: [],
  }));

  // Offline: nothing is compiled or sent, the user is told why.
  const offline = await openScreen(t, null);
  const before = toastsSaying("Connect a device first");
  button(offline.el, "Load color test").click();
  await flush();
  assert.equal(toastsSaying("Connect a device first"), before + 1);
  assert.equal(compile.mock.callCount(), 0);

  const client = new CcClient();
  const { el } = await openScreen(t, client);
  button(el, "Load color test").click();
  await flush();
  assert.deepEqual(compile.mock.calls[0]!.arguments, [COLOR_TEST_SOURCE]);
  assert.deepEqual(client.effects, [{ id: COLOR_TEST_ID, fxb: bytecode, activate: true }]);
  assert.deepEqual(client.uniforms[0], [
    { slot: 0, value: [1, 0, 0] },
    { slot: 3, value: [0, 0, 1] },
    { slot: 6, value: [0] },
    { slot: 7, value: [10] },
  ]);
  assert.ok(button(el, "Reload color test"));
  assert.deepEqual(
    el.querySelectorAll(".upanel-name").map(textOf),
    ["colorA", "colorB", "start", "span"],
  );

  // Tuning the span pushes just that uniform, live.
  const span = el
    .querySelectorAll(".upanel-row")
    .find((r) => textOf(r.querySelector(".upanel-name")) === "span")!;
  typeInto(span.querySelector("input[type=range]")!, "100");
  assert.deepEqual(client.uniforms.at(-1), [{ slot: 7, value: [100] }]);
});
