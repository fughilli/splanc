/**
 * Device settings: the "Wi-Fi rejoin" section (the "wifi_policy" feature;
 * docs/design/wifi-rejoin-policy.md). Mode (auto / fixed / manual / offline),
 * that mode's timing fields, "Rejoin now", and the live link status.
 *
 * Leaving the network on purpose (manual / offline) asks first. While a fresh
 * firmware update is still unconfirmed the firmware refuses those modes (it
 * needs the network to prove itself); the section says so and only offers
 * "go offline anyway" (force) behind a second, explicit confirmation.
 *
 * Works over whatever transport the client already uses: an offline unit is
 * reachable over the BLE player transport only, and this is how it comes back.
 */

import { Button, Chip, Field, confirmDialog, choiceDialog, toast } from "../kit";
import {
  OTA_PENDING_WARNING,
  WIFI_MODES,
  formatDuration,
  formatWifiStatus,
  parseWholeNumber,
  wifiModeConfirmation,
  wifiModeNeedsConfirmedUpdate,
  type WifiMode,
  type WifiPolicy,
  type WifiPolicyRequest,
} from "../../net/wifiPolicy";

export interface WifiPolicyClient {
  getWifiPolicy(): Promise<WifiPolicy>;
  setWifiPolicy(req: WifiPolicyRequest): Promise<WifiPolicy>;
}

const MODE_LABEL: Record<WifiMode, string> = { auto: "Auto", fixed: "Fixed", manual: "Manual", offline: "Offline" };
const MODE_HINT: Record<WifiMode, string> = {
  auto: "Rescans soon after losing the network, backing off to the cap; slows down after a long absence.",
  fixed: "Rescans at a steady interval while the network is missing.",
  manual: "Never looks for the network on its own — only when you tap Rejoin now.",
  offline: "Forward-deployed: Wi-Fi radio off, credentials kept. Change it over Bluetooth or the console.",
};

interface NumField {
  key: "scanCapS" | "decayAfterH" | "sparseIntervalS" | "intervalS";
  label: string;
  min: number;
  max: number;
  modes: WifiMode[];
}
const FIELDS: NumField[] = [
  { key: "scanCapS", label: "Longest wait between scans (s)", min: 10, max: 86400, modes: ["auto"] },
  { key: "decayAfterH", label: "Slow down after unseen for (h, 0 = never)", min: 0, max: 100000, modes: ["auto"] },
  { key: "sparseIntervalS", label: "Slowed scan interval (s)", min: 60, max: 86400, modes: ["auto"] },
  { key: "intervalS", label: "Scan interval (s)", min: 10, max: 86400, modes: ["fixed"] },
];

/** The section; `onState` sees every state the device reports (the card's line). */
export function WifiPolicySection(client: WifiPolicyClient, onState?: (p: WifiPolicy) => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "wifi-policy";
  let cur: WifiPolicy | null = null;
  let sel: WifiMode = "auto";
  let busy = false;
  const inputs = new Map<NumField["key"], HTMLInputElement>();

  const adopt = (p: WifiPolicy): void => {
    cur = p;
    sel = p.mode;
    onState?.(p);
    render();
  };

  const render = (): void => {
    el.replaceChildren();
    inputs.clear();
    const h = document.createElement("div");
    h.className = "device-detail-cap wifi-policy-title";
    h.textContent = "Wi-Fi rejoin";
    el.append(h);
    if (!cur) {
      const p = document.createElement("div");
      p.className = "wifi-policy-status";
      p.textContent = "Reading Wi-Fi settings…";
      el.append(p);
      return;
    }
    const status = document.createElement("div");
    status.className = "wifi-policy-status";
    const extra = cur.scans > 0 && cur.state === "searching" ? ` · ${cur.scans} scans` : "";
    status.textContent = formatWifiStatus(cur) + extra;
    el.append(status);

    if (cur.otaPending) el.append(warnCard(OTA_PENDING_WARNING));

    const chips = document.createElement("div");
    chips.className = "wifi-policy-modes";
    for (const m of WIFI_MODES) {
      chips.append(
        Chip({
          label: MODE_LABEL[m],
          on: m === sel,
          onClick: () => {
            sel = m;
            render();
          },
        }),
      );
    }
    el.append(chips);
    const hint = document.createElement("div");
    hint.className = "device-detail-cap";
    hint.textContent = MODE_HINT[sel];
    el.append(hint);

    for (const f of FIELDS) {
      if (!f.modes.includes(sel)) continue;
      const fld = Field({ label: f.label, type: "number", value: String(cur[f.key]) });
      fld.input.inputMode = "numeric";
      fld.input.min = String(f.min);
      fld.input.max = String(f.max);
      inputs.set(f.key, fld.input);
      el.append(fld.el);
    }

    const btns = document.createElement("div");
    btns.className = "wifi-policy-btns";
    const apply = Button({ label: "Apply", variant: "primary", disabled: busy, onClick: () => void doApply() });
    btns.append(apply);
    if (sel !== "offline" && cur.mode !== "offline") {
      btns.append(Button({ label: "Rejoin now", variant: "quiet", disabled: busy, onClick: () => void doRejoin() }));
    }
    el.append(btns);
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      toast(`Wi-Fi settings: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  };

  /** The update-pending warning; true only after BOTH confirmations. */
  const confirmForce = async (to: WifiMode): Promise<boolean> => {
    const pick = await choiceDialog({
      title: "Update awaiting confirmation",
      message:
        `${OTA_PENDING_WARNING} Confirm the update first, while the device is still online, ` +
        `then switch to ${MODE_LABEL[to]}.`,
      choices: [
        { id: "stay", label: "Stay online", variant: "primary" },
        { id: "force", label: to === "offline" ? "Go offline anyway" : "Switch anyway", variant: "danger" },
      ],
    });
    if (pick !== "force") return false;
    return confirmDialog({
      title: "Skip the update check?",
      message:
        "Without a network the update is confirmed on rendering alone, so its Wi-Fi is never checked. " +
        "If it later can't rejoin, recover the device over Bluetooth, the console or USB.",
      confirmLabel: to === "offline" ? "Go offline anyway" : "Switch anyway",
      danger: true,
    });
  };

  const doApply = (): Promise<void> =>
    run(async () => {
      if (!cur) return;
      const req: WifiPolicyRequest = { mode: sel };
      for (const f of FIELDS) {
        const input = inputs.get(f.key);
        if (!input) continue;
        const n = parseWholeNumber(input.value);
        if (n === null || n < f.min || n > f.max) {
          toast(`${f.label}: enter ${f.min}–${f.max}`, { error: true });
          return;
        }
        req[f.key] = n;
      }
      const ask = wifiModeConfirmation(cur.mode, sel);
      if (ask) {
        const ok = await confirmDialog({
          ...ask,
          confirmLabel: sel === "offline" ? "Go offline" : "Switch to manual",
          danger: sel === "offline",
        });
        if (!ok) return;
      }
      // Known up front: warn before sending (the firmware would refuse anyway).
      if (wifiModeNeedsConfirmedUpdate(sel) && sel !== cur.mode && cur.otaPending) {
        if (!(await confirmForce(sel))) return;
        req.force = true;
      }
      let r = await client.setWifiPolicy(req);
      if (r.refused === "ota_pending" && !req.force) {
        adopt(r);
        if (!(await confirmForce(sel))) return;
        r = await client.setWifiPolicy({ ...req, force: true });
      }
      adopt(r);
      if (r.refused) {
        toast(`Not applied: ${r.refused === "ota_pending" ? "an update is awaiting confirmation" : r.refused}`, {
          error: true,
        });
      } else if (r.mode === "offline") {
        toast("Offline mode on — use Bluetooth or the console to change it");
      } else {
        toast("Wi-Fi settings saved");
      }
    });

  const doRejoin = (): Promise<void> =>
    run(async () => {
      const r = await client.setWifiPolicy({ rejoinNow: true });
      adopt(r);
      toast(r.nextScanS > 0 ? `Rejoining — next scan in ${formatDuration(r.nextScanS)}` : "Rejoining…");
    });

  render();
  void client.getWifiPolicy().then(adopt, (e: unknown) => {
    el.replaceChildren();
    const p = document.createElement("div");
    p.className = "device-detail-cap";
    p.textContent = `Wi-Fi settings unavailable (${e instanceof Error ? e.message : String(e)})`;
    el.append(p);
  });
  return el;
}

function warnCard(text: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "k-card wifi-policy-warn";
  card.style.borderColor = "var(--warn)";
  card.textContent = text;
  return card;
}
