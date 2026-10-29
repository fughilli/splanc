/**
 * The 🎃 entry into Halloween play mode — on the FIRST screen (onboarding) and
 * at the top of the Device sheet for returning users. On the web the tap also
 * opens the Bluetooth chooser right away (it needs this click's gesture); in the
 * iPhone app play mode connects to the nearest fixture by itself.
 */

import { halloweenBleAvailable, isNativeBle } from "../../net/halloweenConnect";
import { playRoute, rememberedFixture, startPlayConnect } from "../../halloween/playSession";
import { appState } from "../app/state";
import { installPlayStyles } from "./playMode.css";

export function PumpkinButton(opts: { label?: string; onNavigate?: () => void } = {}): HTMLButtonElement {
  installPlayStyles();
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pumpkin-btn";
  const em = document.createElement("span");
  em.className = "pumpkin-btn-emoji";
  em.textContent = "🎃";
  const tx = document.createElement("span");
  tx.textContent = opts.label ?? "Play with the Halloween lights";
  b.append(em, tx);
  b.addEventListener("click", () => {
    const name = rememberedFixture();
    // Web: the chooser must be the first async call in this handler.
    if (!isNativeBle() && halloweenBleAvailable() && !appState.client?.isConnected) void startPlayConnect(name);
    opts.onNavigate?.();
    location.hash = `#${playRoute(name)}`;
  });
  return b;
}
