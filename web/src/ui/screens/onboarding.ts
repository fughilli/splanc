/**
 * Onboarding screen (design doc §4.1 / §7.4) — get from "fresh install" to a
 * linked device (or an explicit offline start) in the fewest taps, wrapping the
 * two gnarly realities from main.ts: BLE Improv provisioning and self-signed
 * wss cert trust.
 *
 * Behavior preserved from main.ts: the WiFi form is pre-filled from the cache;
 * BLE is shown only where supported; on provision success we bind to the player
 * (appState.connect) whose boot flow surfaces the cert-trust step in the device
 * sheet; Skip lands directly in Maps.
 */

import { Button, Card, Field, toast } from "../kit";
import {
  bleAvailable,
  provisionViaBle,
  requestImprovDevice,
  wsUrlFromRedirect,
} from "../../net/improv";
import { prefs } from "../../store/prefs";
import { appState } from "../app/state";
import type { Router } from "../app/router";
import type { Screen } from "../app/router";

export function OnboardingScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--onboard";

  const cached = prefs.getWifi();
  const ssid = Field({ label: "Wi-Fi network (SSID)", value: cached.ssid, placeholder: "HomeNet" });
  const pass = Field({ label: "Wi-Fi password", type: "password", value: cached.password });

  const intro = document.createElement("p");
  intro.className = "screen-sub";
  intro.textContent = "Set up a player, or skip and work offline — you can add a device later.";

  const status = document.createElement("div");
  status.className = "onboard-status metric";
  const setStatus = (s: string): void => {
    status.textContent = s;
  };

  const ble = Button({
    label: "Connect via Bluetooth",
    icon: "bluetooth",
    block: true,
    onClick: () => void provision(),
  });

  const manual = Button({
    label: "Enter address manually",
    icon: "link",
    variant: "quiet",
    block: true,
    onClick: () => {
      const url = prompt("Player address (wss://host:port):", "wss://");
      if (!url) return;
      if (!/^wss?:\/\//.test(url)) {
        toast("Address must start with ws:// or wss://", { error: true });
        return;
      }
      appState.connect(url);
      router.navigate("/maps");
    },
  });

  const skip = Button({
    label: "Skip — work offline",
    variant: "quiet",
    block: true,
    onClick: () => router.navigate("/maps"),
  });

  const form = document.createElement("div");
  form.className = "onboard-form";
  if (bleAvailable()) {
    form.append(ssid.el, pass.el, ble);
    const or = document.createElement("div");
    or.className = "onboard-or";
    or.textContent = "or";
    form.append(or, manual, skip);
  } else {
    // BLE unsupported (iOS / non-Chrome): offer manual + skip only (§4.1).
    const note = document.createElement("p");
    note.className = "screen-sub";
    note.textContent = "Bluetooth setup isn't available in this browser.";
    form.append(note, manual, skip);
  }

  el.append(headline("Set up your player"), intro, Card(form), status);

  async function provision(): Promise<void> {
    ble.disabled = true;
    setStatus("");
    try {
      // Chooser FIRST: requestDevice needs the click's (unconsumed) user
      // gesture — even a prompt() beforehand eats it. The form fields already
      // hold the credentials, so there's no prompt() to steal it now.
      const device = await requestImprovDevice();
      const netSsid = ssid.input.value.trim();
      if (!netSsid) {
        toast("Enter a Wi-Fi network name", { error: true });
        ble.disabled = false;
        return;
      }
      const password = pass.input.value;
      const urls = await provisionViaBle(device, netSsid, password, setStatus);
      // Cache only after the device reports it JOINED.
      prefs.setWifi({ ssid: netSsid, password });
      const target = urls.map((u) => wsUrlFromRedirect(u)).find((u) => u !== null);
      if (!target) throw new Error(`player joined, but sent no usable address (${urls})`);
      setStatus(`player provisioned at ${target} — connecting…`);
      // Bind to the player. Its self-signed cert can't be prompted for over a
      // WebSocket; appState.connect surfaces the one-time trust step in the
      // device sheet, and the client's auto-reconnect completes on accept.
      appState.connect(target);
      router.navigate("/maps");
    } catch (e) {
      setStatus(`Player setup failed: ${e instanceof Error ? e.message : e}`);
      ble.disabled = false;
    }
  }

  return { el };
}

function headline(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "screen-headline";
  h.textContent = text;
  return h;
}
