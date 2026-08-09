/**
 * Onboarding screen (design doc §4.1 / §7.4) — get from "fresh install" to a
 * linked device (or an explicit offline start) in the fewest taps.
 *
 * The add-device affordances are the SAME three no-text icon buttons the device
 * sheet uses (Bluetooth / manual address / flash a blank board over USB),
 * driving the shared add-device flow (Wi-Fi picker → BLE chooser or manual
 * entry, see addDevice.ts) and the lazily-loaded USB flasher (flashSheet.ts).
 * BLE is shown only where Web Bluetooth exists; manual, flash, and skip are
 * always offered.
 *
 * The bottom CTA tracks the shared connection: it reads "Skip — work offline"
 * until a device is connected (recalled on refresh or freshly added), then
 * flips to a solid "Continue" in the accent colour. Either way it lands on the
 * Maps tab.
 */

import { Button, Card, IconButton } from "../kit";
import { bleAvailable } from "../../net/improv";
import { appState } from "../app/state";
import { openAddDevice } from "./addDevice";
import type { Router, Screen } from "../app/router";

export function OnboardingScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--onboard";

  const intro = document.createElement("p");
  intro.className = "screen-sub";
  intro.textContent = "Set up a device, or skip and work offline — you can add one later.";

  const done = (): void => router.navigate("/maps");

  // Adding a device here does NOT whisk the user away — provisioning connects in
  // the background and the bottom CTA flips to "Continue" once it lands, so they
  // stay put and see it succeed. (The CTA is the one thing that navigates on.)
  const addLabel = document.createElement("div");
  addLabel.className = "device-add-label";
  addLabel.textContent = "Add device…";
  const addRow = document.createElement("div");
  addRow.className = "device-add-row onboard-add";
  if (bleAvailable()) {
    addRow.append(
      IconButton("bluetooth", { title: "Add device (Bluetooth)", onClick: () => openAddDevice("ble") }),
    );
  }
  addRow.append(
    IconButton("link", { title: "Enter address manually", onClick: () => openAddDevice("manual") }),
    // Flash a new/blank board over USB (WebSerial). The whole flasher — esptool-js
    // and the USB code — is loaded lazily so it never weighs on the main bundle.
    IconButton("chip", {
      title: "Flash new device (USB)",
      onClick: () => void import("./flashSheet").then((m) => m.openFlashSheet()),
    }),
  );

  const card = document.createElement("div");
  card.className = "onboard-add-card";
  card.append(addLabel, addRow);
  if (!bleAvailable()) {
    const note = document.createElement("p");
    note.className = "screen-sub";
    note.style.margin = "var(--sp-2) 0 0";
    note.textContent = "Bluetooth setup isn't available in this browser — enter the address manually.";
    card.append(note);
  }

  // Bottom CTA: reflects the shared connection status. A container we swap the
  // button into so a fresh/recalled connection flips "Skip" → accent "Continue"
  // without rebuilding the screen.
  const ctaWrap = document.createElement("div");
  ctaWrap.className = "onboard-cta";
  const renderCta = (): void => {
    const connected = appState.status.state === "connected";
    ctaWrap.replaceChildren(
      connected
        ? Button({ label: "Continue", block: true, onClick: done })
        : Button({ label: "Skip — work offline", variant: "quiet", block: true, onClick: done }),
    );
  };
  renderCta();
  const unsub = appState.subscribe(renderCta);

  el.append(headline("Set up your device"), intro, Card(card), ctaWrap);
  return { el, onUnmount: unsub };
}

function headline(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "screen-headline";
  h.textContent = text;
  return h;
}
