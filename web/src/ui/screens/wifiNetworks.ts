/**
 * Settings ▸ Wi-Fi networks (D-72): the saved networks the set-up sheet offers,
 * managed in one place. Reached from Settings ▸ Behavior and from the connect
 * picker.
 *
 * The list is in the user's order; the first is the default (filled in first
 * when setting up a fixture, and used by "Find over Bluetooth"). Tapping a
 * network opens its own sheet to edit the name or password, make it the default,
 * or delete it — one primary action there (Save), the rest secondary on their own
 * rows. A network a fixture rejected the password for is flagged here so it can
 * be fixed once.
 */

import { Button, PasswordReveal, Sheet, confirmDialog, toast } from "../kit";
import { savedNetworks, type SavedNetwork } from "../../store/savedNetworks";
import type { Router, Screen } from "../app/router";
import { installConnectStyles } from "./connectPicker.css";

export function WifiNetworksScreen(_router: Router): Screen {
  installConnectStyles();
  const el = document.createElement("div");
  el.className = "screen screen--wifi";

  const lead = document.createElement("p");
  lead.className = "screen-sub";
  lead.textContent =
    "Networks you entered when connecting a fixture are saved here. The first one is the default " +
    "for setting up new fixtures.";

  const list = document.createElement("div");
  list.className = "k-card wifi-net-list";

  const render = (): void => {
    const nets = savedNetworks.list();
    list.replaceChildren();
    if (nets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wifi-net-empty";
      empty.textContent = "No saved networks yet.";
      list.append(empty);
      return;
    }
    nets.forEach((n, i) => list.append(networkRow(n, i === 0)));
  };
  render();
  const unsub = savedNetworks.subscribe(render);

  const add = Button({
    label: "Add a network",
    icon: "plus",
    block: true,
    onClick: () => openNetworkEditor(null),
  });
  add.classList.add("wifi-net-add");

  el.append(lead, list, add);
  return { el, onUnmount: unsub };
}

function networkRow(n: SavedNetwork, isDefault: boolean): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "wifi-net";
  row.title = `Edit ${n.ssid}`;
  const info = document.createElement("div");
  info.className = "wifi-net-info";
  const ssid = document.createElement("div");
  ssid.className = "wifi-net-ssid";
  ssid.textContent = n.ssid;
  const meta = document.createElement("div");
  meta.className = "wifi-net-meta";
  meta.textContent = stateText(n);
  if (n.state === "rejected") meta.classList.add("wifi-net-meta--bad");
  info.append(ssid, meta);
  row.append(info);
  if (isDefault) {
    const badge = document.createElement("span");
    badge.className = "wifi-net-badge";
    badge.textContent = "Default";
    row.append(badge);
  }
  row.addEventListener("click", () => openNetworkEditor(n));
  return row;
}

export function stateText(n: SavedNetwork): string {
  if (n.state === "rejected") return "A fixture rejected this password. Tap to fix it.";
  if (n.state === "joined") return n.lastUsed ? `Joined · last used ${ago(n.lastUsed)}` : "Joined";
  if (n.state === "unverified") return "Not joined yet";
  return "Saved";
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** Edit (or, with null, add) one network in its own sheet. */
export function openNetworkEditor(n: SavedNetwork | null): void {
  installConnectStyles();
  const sheet = Sheet(n ? "Edit network" : "Add a network");
  sheet.body.className = "wifi-sheet";

  const ssidInput = document.createElement("input");
  ssidInput.className = "sheet-input";
  ssidInput.placeholder = "Wi-Fi network (SSID)";
  ssidInput.setAttribute("aria-label", "Wi-Fi network (SSID)");
  ssidInput.setAttribute("autocomplete", "off");
  ssidInput.setAttribute("autocapitalize", "off");
  ssidInput.setAttribute("autocorrect", "off");
  ssidInput.setAttribute("spellcheck", "false");
  ssidInput.value = n?.ssid ?? "";
  const passInput = document.createElement("input");
  passInput.className = "sheet-input";
  passInput.placeholder = "Wi-Fi password";
  passInput.setAttribute("aria-label", "Wi-Fi password");
  passInput.value = n?.password ?? "";
  const pass = PasswordReveal(passInput, { autocomplete: "new-password", className: "sheet-pw" });

  const status = document.createElement("div");
  status.className = "wifi-status metric";
  status.setAttribute("role", "status");
  if (n?.state === "rejected") {
    status.textContent = "A fixture rejected this password last time.";
    status.classList.add("wifi-status--error");
  }

  const save = Button({
    label: "Save",
    icon: "save",
    block: true,
    onClick: () => {
      const creds = { ssid: ssidInput.value.trim(), password: passInput.value };
      if (!creds.ssid) {
        status.textContent = "Enter the network name.";
        status.classList.add("wifi-status--error");
        ssidInput.focus();
        return;
      }
      if (n) savedNetworks.edit(n.ssid, creds);
      else savedNetworks.add(creds);
      sheet.close();
      toast(n ? "Network saved" : `Saved ${creds.ssid}`);
    },
  });
  sheet.body.append(ssidInput, pass.el, status, save);

  if (n) {
    const isDefault = savedNetworks.list()[0]?.ssid === n.ssid;
    if (!isDefault) {
      const def = Button({
        label: "Make default",
        variant: "quiet",
        block: true,
        onClick: () => {
          savedNetworks.makeDefault(n.ssid);
          sheet.close();
          toast(`${n.ssid} is now the default`);
        },
      });
      def.classList.add("wifi-secondary");
      sheet.body.append(def);
    }
    const del = Button({
      label: "Delete network",
      icon: "trash",
      variant: "quiet",
      block: true,
      onClick: () => {
        void confirmDialog({
          title: "Delete network?",
          message: `Forget "${n.ssid}" and its password on this device? Fixtures already on it stay connected.`,
          confirmLabel: "Delete",
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          savedNetworks.remove(n.ssid);
          sheet.close();
        });
      },
    });
    del.classList.add("wifi-secondary");
    sheet.body.append(del);
  }
  (n ? passInput : ssidInput).focus();
}
