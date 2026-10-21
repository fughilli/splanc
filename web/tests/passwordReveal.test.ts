/**
 * "Show password" eye toggle (kit PasswordReveal): the Wi-Fi password in the
 * add-device sheet and the AI settings' API keys start hidden; the eye button
 * flips cleartext on/off without changing the value, never takes focus from the
 * input or moves its caret, never submits, and announces its state
 * (aria-label + aria-pressed). Picking a saved network keeps the visibility.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { asFake, fire, installFakeDom, typeInto, type FakeElement } from "./fakeDom";

const dom = installFakeDom();

import { PasswordReveal } from "../src/ui/kit";
import { prefs } from "../src/store/prefs";
import { openAddDevice } from "../src/ui/screens/addDevice";
import { all, clearOverlays } from "./deviceFakes";

beforeEach(() => {
  dom.document.hidden = true;
  localStorage.clear();
});

afterEach(() => {
  clearOverlays();
  localStorage.clear();
});

function make(): { input: FakeElement; toggle: FakeElement; el: FakeElement; h: ReturnType<typeof PasswordReveal> } {
  const raw = document.createElement("input");
  const h = PasswordReveal(raw);
  document.body.appendChild(h.el);
  return { input: asFake(h.input), toggle: asFake(h.toggle), el: asFake(h.el), h };
}

test("PasswordReveal starts hidden with an accessible, non-submitting eye button", () => {
  const { input, toggle, el, h } = make();
  try {
    assert.equal(input.getAttribute("type"), "password");
    assert.equal(input.parentElement, el, "input lives inside the wrapper");
    assert.equal(toggle.parentElement, el, "toggle sits in the same wrapper (right end, via CSS)");
    assert.ok(el.classList.contains("k-pw"));
    assert.equal(toggle.getAttribute("type"), "button", "never submits a form");
    assert.equal(toggle.getAttribute("aria-label"), "Show password");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.ok(toggle.querySelector("use[href='#ic-eye']"), "shows the eye icon");
    assert.equal(h.shown(), false);
    // Phone keyboards must not "fix" a cleartext password.
    assert.equal(input.getAttribute("autocapitalize"), "off");
    assert.equal(input.getAttribute("autocorrect"), "off");
    assert.equal(input.getAttribute("spellcheck"), "false");
    assert.equal(input.getAttribute("autocomplete"), "off");
  } finally {
    el.remove();
  }
});

test("tapping the eye toggles cleartext without touching the value", () => {
  const { input, toggle, el, h } = make();
  try {
    typeInto(input, "hunter22");
    toggle.click();
    assert.equal(input.getAttribute("type"), "text");
    assert.equal(input.value, "hunter22");
    assert.equal(toggle.getAttribute("aria-label"), "Hide password");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.ok(toggle.querySelector("use[href='#ic-eye-off']"), "shows the eye-off icon");
    assert.equal(h.shown(), true);
    assert.ok(el.classList.contains("k-pw--shown"));

    toggle.click();
    assert.equal(input.getAttribute("type"), "password");
    assert.equal(input.value, "hunter22");
    assert.equal(toggle.getAttribute("aria-label"), "Show password");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(h.shown(), false);
  } finally {
    el.remove();
  }
});

test("pressing the eye keeps focus and the caret in the input", () => {
  const { input, toggle, el } = make();
  try {
    typeInto(input, "abcdef");
    input.focus();
    input["selectionStart"] = 2;
    input["selectionEnd"] = 4;
    const restored: Array<[number, number]> = [];
    input["setSelectionRange"] = (a: number, b: number) => restored.push([a, b]);

    const down = fire(toggle, "pointerdown");
    const mouse = fire(toggle, "mousedown");
    assert.equal(down.defaultPrevented, true, "pointerdown must not move focus to the button");
    assert.equal(mouse.defaultPrevented, true, "nor the compat mousedown");
    toggle.click();

    assert.equal(document.activeElement, input as unknown as Element, "focus stayed in the input");
    assert.deepEqual(restored, [[2, 4]], "selection restored after the type swap");
  } finally {
    el.remove();
  }
});

test("add-device Wi-Fi password has the eye toggle, and picking a saved network keeps visibility", () => {
  prefs.addWifi({ ssid: "Attic", password: "upstairs1" });
  prefs.addWifi({ ssid: "HomeNet", password: "hunter22" });
  openAddDevice("manual");

  const [ssid, pass] = all(".wifi-sheet .sheet-input");
  assert.ok(ssid && pass);
  assert.equal(pass.getAttribute("type"), "password", "hidden by default");
  assert.equal(pass.getAttribute("autocomplete"), "new-password", "keeps password managers out");
  assert.equal(pass.getAttribute("autocapitalize"), "off");
  assert.equal(ssid.getAttribute("autocapitalize"), "off", "SSIDs are case-sensitive");
  const toggle = asFake(pass.parentElement).querySelector(".k-pw-toggle");
  assert.ok(toggle, "eye toggle next to the password");
  assert.ok(asFake(pass.parentElement).classList.contains("sheet-pw"));

  const firstValue = pass.value;
  toggle.click();
  assert.equal(pass.getAttribute("type"), "text");
  assert.equal(pass.value, firstValue, "toggling keeps the value");

  // Pick the other saved network: the value swaps, visibility stays shown.
  const other = all(".wifi-pick").find((b) => b.textContent !== ssid.value);
  assert.ok(other);
  other.click();
  const [, pass2] = all(".wifi-sheet .sheet-input");
  assert.equal(pass2, pass, "same input, not rebuilt");
  assert.notEqual(pass.value, firstValue);
  assert.equal(pass.getAttribute("type"), "text", "picking a saved network keeps cleartext on");
});
