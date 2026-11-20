/**
 * Onboarding screen (design doc §4.1 / §7.4) — get from "fresh install" to a
 * linked device (or an explicit offline start) in the fewest taps.
 *
 * The same two labelled actions as the device sheet (D-72): "Connect a fixture"
 * opens the connect picker (set up over Bluetooth, connect directly over
 * Bluetooth, or by network address), and "Flash a new device" sits on its own row
 * below it. Fixtures the app finds on the network by itself (net/discovery.ts)
 * are listed above them, one tap to connect — nothing to refresh or type.
 *
 * The bottom CTA tracks the shared connection: it reads "Skip — work offline"
 * until a device is connected (recalled on refresh or freshly added), then
 * flips to a solid "Continue" in the accent colour (and Connect steps down to a
 * secondary button, so the screen keeps one primary action). Either way it lands
 * on the Maps tab.
 */

import { Button, Card } from "../kit";
import { appState } from "../app/state";
import { discovery } from "../../net/discovery";
import { ConnectActions, FoundList } from "./connectPicker";
import type { Router, Screen } from "../app/router";

export function OnboardingScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--onboard";

  const intro = document.createElement("p");
  intro.className = "screen-sub";
  intro.textContent = "Connect a fixture, or skip and work offline — you can add one later.";

  const done = (): void => router.navigate("/maps");

  // Adding a device here does NOT whisk the user away — provisioning connects in
  // the background and the bottom CTA flips to "Continue" once it lands, so they
  // stay put and see it succeed. (The CTA is the one thing that navigates on.)
  const card = document.createElement("div");
  card.className = "onboard-add-card";
  const found = document.createElement("div");
  const actions = document.createElement("div");

  const ctaWrap = document.createElement("div");
  ctaWrap.className = "onboard-cta";
  const render = (): void => {
    const connected = appState.status.state === "connected";
    const fresh = discovery.view().fresh;
    found.replaceChildren();
    if (fresh.length > 0) {
      const cap = document.createElement("div");
      cap.className = "device-add-label";
      cap.textContent = "On this network";
      found.append(cap, FoundList(fresh));
    }
    // One primary per screen: found fixtures' Connect buttons (or Continue) take
    // the accent once there are any.
    actions.replaceChildren(ConnectActions({ quietConnect: connected || fresh.length > 0 }));
    ctaWrap.replaceChildren(
      connected
        ? Button({ label: "Continue", block: true, onClick: done })
        : Button({ label: "Skip — work offline", variant: "quiet", block: true, onClick: done }),
    );
  };
  card.append(found, actions);
  render();
  const unsubApp = appState.subscribe(render);
  const unsubFound = discovery.subscribe(render);
  const stopDiscovery = discovery.start();

  el.append(headline("Set up your device"), intro, Card(card), ctaWrap);
  return {
    el,
    onUnmount: () => {
      unsubApp();
      unsubFound();
      stopDiscovery();
    },
  };
}

function headline(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "screen-headline";
  h.textContent = text;
  return h;
}
