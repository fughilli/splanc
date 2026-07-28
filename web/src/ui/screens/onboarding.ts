/**
 * Onboarding screen (design doc §4.1 / §7.4) — get from "fresh install" to a
 * linked device (or an explicit offline start) in the fewest taps.
 *
 * The add-device affordances are the SAME two no-text icon buttons the device
 * sheet uses (Bluetooth / manual address), driving the shared add-device flow
 * (Wi-Fi picker → BLE chooser or manual entry, see addDevice.ts). BLE is shown
 * only where Web Bluetooth exists; manual + skip are always offered.
 */

import { Button, Card, IconButton } from "../kit";
import { bleAvailable } from "../../net/improv";
import { openAddDevice } from "./addDevice";
import type { Router, Screen } from "../app/router";

export function OnboardingScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--onboard";

  const intro = document.createElement("p");
  intro.className = "screen-sub";
  intro.textContent = "Set up a player, or skip and work offline — you can add a device later.";

  const done = (): void => router.navigate("/maps");

  const addLabel = document.createElement("div");
  addLabel.className = "device-add-label";
  addLabel.textContent = "Add device…";
  const addRow = document.createElement("div");
  addRow.className = "device-add-row onboard-add";
  if (bleAvailable()) {
    addRow.append(
      IconButton("bluetooth", { title: "Add device (Bluetooth)", onClick: () => openAddDevice("ble", done) }),
    );
  }
  addRow.append(
    IconButton("link", { title: "Enter address manually", onClick: () => openAddDevice("manual", done) }),
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

  const skip = Button({ label: "Skip — work offline", variant: "quiet", block: true, onClick: done });

  el.append(headline("Set up your player"), intro, Card(card), skip);
  return { el };
}

function headline(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "screen-headline";
  h.textContent = text;
  return h;
}
