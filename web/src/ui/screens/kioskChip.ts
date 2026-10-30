/**
 * Floating kiosk countdown ("Back to the show in 1:42 if you stop playing")
 * shown on every screen EXCEPT play mode (which has its own big one) while the
 * connected device is in kiosk mode — notably the effects workspace and Acid
 * Mode, so a visitor (or the owner) is never surprised by the idle revert. A
 * revert there is announced with a toast.
 */

import { kioskStore } from "../../halloween/kioskStore";
import { PLAY_PATH } from "../../halloween/playSession";
import { countdownLine, countdownTicking, formatCountdown } from "../../net/kiosk";
import { attractDisplayName } from "../../halloween/playLogic";
import { appState } from "../app/state";
import { toast } from "../kit";
import { installPlayStyles } from "./playMode.css";

let installed = false;

export function installKioskChip(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  installPlayStyles();
  kioskStore.start();
  const chip = document.createElement("div");
  chip.className = "kiosk-chip";
  chip.setAttribute("role", "status");
  chip.hidden = true;
  document.body.appendChild(chip);
  const onPlay = (): boolean => location.hash.replace(/^#/, "").split("?")[0] === PLAY_PATH;
  const render = (): void => {
    const on = kioskStore.active && appState.status.state === "connected" && !onPlay();
    chip.hidden = !on;
    // Acid Mode owns the bottom (its mic): a compact chip between its pill and exit.
    const top = location.hash.replace(/^#/, "").split("?")[0] === "/acid";
    chip.classList.toggle("kiosk-chip--top", top);
    if (!on) return;
    const st = kioskStore.status;
    chip.textContent =
      top && countdownTicking(st)
        ? `⏳ Show in ${formatCountdown(kioskStore.remaining())}`
        : `⏳ ${top && st?.attractActive ? "Show is on" : countdownLine(kioskStore.remaining(), st)}`;
  };
  kioskStore.subscribe(render);
  kioskStore.onRevert((s) => {
    if (!onPlay()) toast(`Back to the show${s.attractName ? ` (${attractDisplayName(s.attractName)})` : ""} — nobody was playing`, {
        ms: 5000,
      });
  });
  window.addEventListener("hashchange", render);
  window.setInterval(render, 500);
  render();
}
