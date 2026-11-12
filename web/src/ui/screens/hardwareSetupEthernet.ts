/**
 * Hardware Setup: the P4 player's Ethernet port and its network LED outputs
 * (docs/design/p4-ethernet-ddp.md). Shown only when the board reports Ethernet
 * caps (hardware_config_state.board.ethernet).
 *
 * Two cards:
 *  - Ethernet: on/off, the PHY model and its pins, the RMII clock, addressing
 *    (LED network / DHCP client / static) and the live link status. Edits are a
 *    draft; "Apply" sends the whole config at once, since every change restarts
 *    the port.
 *  - WLED boards: "Find boards" (discover_controllers), the boards found with an
 *    Add button, and the outputs in use. Each output is an LED channel (2..)
 *    after the GPIO strips; its LED count is the channel's (set_hardware_config).
 */

import { Button, Card, toast } from "../kit";
import type { LedMapperClient } from "../../net/client";
import type { HardwareChannel } from "../../net/proto";
import {
  IP_MODES,
  IP_MODE_LABELS,
  PHY_LABELS,
  errorText,
  ipToString,
  isHostAddress,
  maskFromPrefix,
  parseIp,
  prefixLength,
  statusText,
  type DiscoveredController,
  type EthernetCaps,
  type EthernetConfig,
  type EthernetState,
} from "../../net/ethernet";

export interface EthernetSectionDeps {
  /** The connected client, or null (after toasting "connect first"). */
  client: () => LedMapperClient | null;
  caps: EthernetCaps;
  /** Network LED channels the board has (BoardCapabilities.netChannels). */
  netChannels: number;
  state: EthernetState | null;
  /** The device's channels (the network ones carry ledType "ddp"). */
  channels: HardwareChannel[];
  /** Sets a channel's LED count (the host page's set_hardware_config path). */
  setLedCount: (channel: number, n: number) => Promise<boolean>;
  /** A new state arrived: store it and re-render. */
  onState: (st: EthernetState) => void;
}

const FIRST_NET_CHANNEL = 2;

/** Draft edits survive re-renders (keyed by nothing: one device page at a time). */
let draft: EthernetConfig | null = null;
let draftBase = "";
let found: DiscoveredController[] = [];
let scanning = false;

/** Forget the draft and the scan results (the page closed or the device changed). */
export function resetEthernetSection(): void {
  draft = null;
  draftBase = "";
  found = [];
  scanning = false;
}

export function ethernetGroups(d: EthernetSectionDeps): HTMLElement[] {
  // Restart the draft when the device's config changed under it.
  const base = JSON.stringify(d.state?.config ?? d.caps.defaults);
  if (draft === null || base !== draftBase) {
    draft = { ...(d.state?.config ?? d.caps.defaults) };
    draftBase = base;
  }
  return [ethernetCard(d, draft), outputsCard(d)];
}

// -- Ethernet ---------------------------------------------------------------

function ethernetCard(d: EthernetSectionDeps, c: EthernetConfig): HTMLElement {
  const g = group("Ethernet");
  const st = d.state;
  const status = document.createElement("div");
  status.className = "hw-hint";
  status.textContent = st ? statusText(st) : "Reading Ethernet state…";
  if (st?.mac) status.textContent += ` · MAC ${st.mac}`;
  g.append(status);

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = c.enabled;
  enabled.addEventListener("change", () => {
    c.enabled = enabled.checked;
    rerender(d);
  });
  g.append(row("Enabled", "Drive WLED boards over this player's wired port.", enabled));

  const phys = d.caps.phys.length ? d.caps.phys : ["ip101"];
  g.append(
    row(
      "PHY",
      "The Ethernet chip on the board or the add-on module.",
      select(
        phys.map((p) => ({ value: p, label: PHY_LABELS[p] ?? p })),
        c.phy,
        (v) => (c.phy = v),
      ),
    ),
    row(
      "PHY address",
      "Its MDIO address (often 0 or 1). Empty = scan for it.",
      numberInput(c.phyAddr < 0 ? "" : String(c.phyAddr), 0, 31, (v) => (c.phyAddr = v ?? -1)),
    ),
    row("MDC pin", "The management clock GPIO.", numberInput(String(c.mdcGpio), 0, 54, (v) => (c.mdcGpio = v ?? c.mdcGpio))),
    row("MDIO pin", "The management data GPIO.", numberInput(String(c.mdioGpio), 0, 54, (v) => (c.mdioGpio = v ?? c.mdioGpio))),
    row(
      "PHY reset pin",
      "The GPIO wired to the PHY's reset. Empty = none.",
      numberInput(c.phyResetGpio < 0 ? "" : String(c.phyResetGpio), 0, 54, (v) => (c.phyResetGpio = v ?? -1)),
    ),
    row(
      "50 MHz clock",
      "Most PHY modules drive the RMII clock into GPIO50. If the P4 must make it, it " +
        "goes out on the pin you pick, which the board must loop back to GPIO50.",
      select(
        [
          { value: "in", label: "From the PHY, into GPIO50" },
          { value: "out", label: "From the P4" },
        ],
        c.clock,
        (v) => {
          c.clock = v === "out" ? "out" : "in";
          rerender(d);
        },
      ),
    ),
  );
  if (c.clock === "out") {
    g.append(
      row("Clock out pin", "The GPIO the P4 drives the 50 MHz clock on.", numberInput(String(Math.max(0, c.clockGpio)), 0, 54, (v) => (c.clockGpio = v ?? c.clockGpio))),
    );
  }
  g.append(
    row(
      "Addresses",
      "LED network: the player is the network's DHCP server, for a cable or switch with " +
        "only WLED boards on it. DHCP client: join a router's network.",
      select(
        IP_MODES.map((m) => ({ value: m, label: IP_MODE_LABELS[m] })),
        c.ipMode,
        (v) => {
          c.ipMode = v as EthernetConfig["ipMode"];
          rerender(d);
        },
      ),
    ),
  );
  if (c.ipMode !== "dhcp_client") {
    g.append(
      row("Address", "This player's address on the LED network.", ipInput(c.ip, (v) => (c.ip = v))),
      row(
        "Prefix",
        "Subnet size (24 = 255.255.255.0).",
        numberInput(String(prefixLength(c.netmask) ?? 24), 8, 30, (v) => (c.netmask = maskFromPrefix(v ?? 24))),
      ),
    );
    if (c.ipMode === "static") {
      g.append(row("Gateway", "Empty = none.", ipInput(c.gateway, (v) => (c.gateway = v), true)));
    }
  }
  const pins = `RMII data pins (fixed): ${d.caps.rmiiGpios.join(", ")}. They can't drive LED strips while Ethernet is on.`;
  const pinNote = document.createElement("div");
  pinNote.className = "hw-row-hint";
  pinNote.textContent = pins;
  g.append(pinNote);

  const actions = document.createElement("div");
  actions.className = "hw-test-actions";
  actions.append(
    Button({ label: "Apply", variant: "primary", onClick: () => void apply(d, c) }),
    Button({
      label: "Board defaults",
      variant: "quiet",
      onClick: () => {
        draft = { ...d.caps.defaults, enabled: c.enabled };
        rerender(d);
      },
    }),
  );
  g.append(actions);
  return g;
}

/** Client-side checks before the device's own; returns why not, or "". */
export function configProblem(c: EthernetConfig): string {
  if (c.mdcGpio === c.mdioGpio) return "MDC and MDIO must be different pins.";
  if (c.ipMode !== "dhcp_client") {
    if (prefixLength(c.netmask) === null) return "That prefix isn't a valid subnet.";
    if (!isHostAddress(c.ip, c.netmask)) return `${ipToString(c.ip)} isn't a usable address in that subnet.`;
    if (c.ipMode === "static" && c.gateway !== 0 && (c.gateway & c.netmask) !== (c.ip & c.netmask))
      return "The gateway must be in the same subnet.";
  }
  return "";
}

async function apply(d: EthernetSectionDeps, c: EthernetConfig): Promise<void> {
  const problem = configProblem(c);
  if (problem) {
    toast(problem, { error: true });
    return;
  }
  const client = d.client();
  if (!client) return;
  try {
    const st = await client.setEthernetConfig(c);
    if (st.error) toast(errorText(st.error), { error: true });
    else toast(c.enabled ? "Ethernet settings applied" : "Ethernet off");
    d.onState(st);
  } catch {
    toast("Failed to apply the Ethernet settings", { error: true });
  }
}

// -- WLED boards ------------------------------------------------------------

function outputsCard(d: EthernetSectionDeps): HTMLElement {
  const g = group("WLED boards");
  const st = d.state;
  const hint = document.createElement("div");
  hint.className = "hw-hint";
  hint.textContent =
    "Each board is an LED channel after the strips: mapping and effects treat its LEDs as " +
    "the next part of the fixture. Turn on Receive UDP realtime in WLED (Config → Sync " +
    "Interfaces); DDP needs nothing else.";
  g.append(hint);

  const counts = new Map(d.channels.map((x) => [x.channel, x.ledCount]));
  const outputs = st?.outputs ?? [];
  for (const o of outputs) {
    const n = counts.get(o.channel) ?? 0;
    const r = row(
      `Channel ${o.channel}${o.name ? ` · ${o.name}` : ""}`,
      `${ipToString(o.ip)}${o.port ? `:${o.port}` : ""} over DDP`,
      outputControls(d, o.channel, n),
    );
    g.append(r);
  }
  if (outputs.length === 0) {
    const none = document.createElement("div");
    none.className = "hw-row-hint";
    none.textContent = "No boards added yet.";
    g.append(none);
  }
  if (st && st.config.enabled) {
    const tx = document.createElement("div");
    tx.className = "hw-row-hint";
    tx.textContent = `Frames sent: ${st.txFrames}${st.txErrors ? `, send errors: ${st.txErrors}` : ""}`;
    g.append(tx);
  }

  // Discovery results.
  const inUse = new Set(outputs.map((o) => o.ip));
  for (const b of found) {
    const add = Button({
      label: inUse.has(b.ip) ? "Added" : "Add",
      onClick: () => void addBoard(d, b.ip, b.name, b.ledCount),
    });
    if (inUse.has(b.ip)) (add as HTMLButtonElement).disabled = true;
    g.append(
      row(
        b.name || ipToString(b.ip),
        `${ipToString(b.ip)}${b.ledCount ? ` · ${b.ledCount} LEDs` : ""}${b.version ? ` · WLED ${b.version}` : ""}`,
        add,
      ),
    );
  }

  const manual = ipInput(0, () => {}, true);
  (manual as HTMLInputElement).placeholder = "192.168.50.107";
  const actions = document.createElement("div");
  actions.className = "hw-test-actions";
  actions.append(
    Button({
      label: scanning ? "Looking…" : found.length ? "Look again" : "Find boards",
      variant: "primary",
      onClick: () => void discover(d),
    }),
    manual,
    Button({
      label: "Add by address",
      onClick: () => {
        const ip = parseIp((manual as HTMLInputElement).value);
        if (ip === null) {
          toast("Enter the board's address, like 192.168.50.107", { error: true });
          return;
        }
        void addBoard(d, ip, "", 0);
      },
    }),
  );
  g.append(actions);
  return g;
}

function outputControls(d: EthernetSectionDeps, channel: number, ledCount: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "6px";
  wrap.style.alignItems = "center";
  const n = numberInput(ledCount > 0 ? String(ledCount) : "", 0, 100000, (v) => {
    void d.setLedCount(channel, v ?? 0);
  });
  (n as HTMLInputElement).placeholder = "LEDs";
  (n as HTMLInputElement).style.width = "6em";
  wrap.append(
    n,
    Button({
      label: "Remove",
      variant: "quiet",
      onClick: () => void removeOutput(d, channel),
    }),
  );
  return wrap;
}

/** The first network channel with no target. */
export function freeChannel(usedChannels: number[], netChannels: number): number | null {
  for (let ch = FIRST_NET_CHANNEL; ch < FIRST_NET_CHANNEL + netChannels; ch++) {
    if (!usedChannels.includes(ch)) return ch;
  }
  return null;
}

async function addBoard(d: EthernetSectionDeps, ip: number, name: string, ledCount: number): Promise<void> {
  const client = d.client();
  if (!client) return;
  const ch = freeChannel((d.state?.outputs ?? []).map((o) => o.channel), d.netChannels);
  if (ch === null) {
    toast(`This player drives at most ${d.netChannels} boards`, { error: true });
    return;
  }
  try {
    const st = await client.setNetworkOutput({ channel: ch, ip, port: 0, name });
    if (st.error) {
      toast(errorText(st.error), { error: true });
      d.onState(st);
      return;
    }
    d.onState(st);
    if (ledCount > 0) await d.setLedCount(ch, ledCount);
    else toast(`Added on channel ${ch}: set its LED count`);
  } catch {
    toast("Failed to add the board", { error: true });
  }
}

async function removeOutput(d: EthernetSectionDeps, channel: number): Promise<void> {
  const client = d.client();
  if (!client) return;
  try {
    const st = await client.setNetworkOutput({ channel, ip: 0, port: 0, name: "" });
    d.onState(st);
    await d.setLedCount(channel, 0);
  } catch {
    toast("Failed to remove the board", { error: true });
  }
}

async function discover(d: EthernetSectionDeps): Promise<void> {
  const client = d.client();
  if (!client || scanning) return;
  scanning = true;
  rerender(d);
  try {
    const r = await client.discoverControllers();
    found = r.controllers;
    if (r.error) toast(errorText(r.error), { error: true });
    else if (found.length === 0) toast("No WLED boards answered yet. Try again in a moment.");
  } catch {
    toast("Discovery failed", { error: true });
  } finally {
    scanning = false;
    rerender(d);
  }
}

function rerender(d: EthernetSectionDeps): void {
  if (d.state) d.onState(d.state);
}

// -- builders ---------------------------------------------------------------

function numberInput(value: string, min: number, max: number, onSet: (v: number | null) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "hw-select";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.inputMode = "numeric";
  input.value = value;
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    if (raw === "") return onSet(null);
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < min || n > max) {
      toast(`Enter ${min}–${max}`, { error: true });
      input.value = value;
      return;
    }
    onSet(n);
  });
  return input;
}

function ipInput(ip: number, onSet: (v: number) => void, allowEmpty = false): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hw-select";
  input.inputMode = "decimal";
  input.value = ip ? ipToString(ip) : "";
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    if (raw === "" && allowEmpty) return onSet(0);
    const v = parseIp(raw);
    if (v === null) {
      toast("Enter an address like 192.168.50.1", { error: true });
      input.value = ip ? ipToString(ip) : "";
      return;
    }
    onSet(v);
  });
  return input;
}

function select(
  options: Array<{ value: string; label: string }>,
  value: string,
  onPick: (v: string) => void,
): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "hw-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onPick(sel.value));
  return sel;
}

function group(legend: string): HTMLElement {
  const card = Card();
  card.classList.add("hw-group");
  const l = document.createElement("div");
  l.className = "hw-legend";
  l.textContent = legend;
  card.appendChild(l);
  return card;
}

function row(name: string, hint: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "hw-row";
  const label = document.createElement("div");
  label.className = "hw-row-label";
  const n = document.createElement("div");
  n.className = "hw-row-name";
  n.textContent = name;
  const h = document.createElement("div");
  h.className = "hw-row-hint";
  h.textContent = hint;
  label.append(n, h);
  const ctl = document.createElement("div");
  ctl.className = "hw-row-ctl";
  ctl.appendChild(control);
  r.append(label, ctl);
  return r;
}
