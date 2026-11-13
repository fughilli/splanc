/**
 * Hardware Setup: network LED outputs and the Ethernet port they go out of
 * (docs/design/p4-ethernet-ddp.md). Shown only when the board reports network
 * channels / Ethernet caps (the P4).
 *
 * A network output is an LED channel (2..) after the GPIO strips, streaming to a
 * pixel controller over DDP (WLED and most bridges, no setup) or Art-Net (170
 * pixels per universe, optional ArtSync). The page builds:
 *  - outputCard: one card per network output with everything about it: name,
 *    protocol, address, port, Art-Net universe + sync, LED count, capture mode
 *    and color order (the host page's check flow, passed in as hooks), Remove.
 *    Target edits are a draft applied together (one set_network_output); the LED
 *    count applies on change like a strip's.
 *  - addOutputCard: discovered WLED boards (Add prefills the LED count) and a
 *    manual form (protocol, address, LED count).
 *  - ethernetCard: the port's PHY, pins, addressing and live status. A draft,
 *    applied at once, since every change restarts the port.
 */

import { Button, Card, toast } from "../kit";
import type { LedMapperClient } from "../../net/client";
import type { HardwareChannel } from "../../net/proto";
import {
  ARTNET_MAX_UNIVERSE,
  IP_MODES,
  IP_MODE_LABELS,
  NET_PROTOCOL_LABELS,
  PHY_LABELS,
  artnetUniverses,
  defaultPort,
  describeOutput,
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
  type NetProtocol,
  type NetworkOutput,
} from "../../net/ethernet";

export const FIRST_NET_CHANNEL = 2;

export interface NetworkDeps {
  /** The connected client, or null (after toasting "connect first"). */
  client: () => LedMapperClient | null;
  /** Ethernet caps, or null on a board with network channels but no Ethernet. */
  caps: EthernetCaps | null;
  /** Network LED channels the board has (BoardCapabilities.netChannels). */
  netChannels: number;
  state: EthernetState | null;
  /** The device's channels (network ones carry ledType "ddp"). */
  channels: HardwareChannel[];
  /** Board-wide LED limit (0 = unknown). */
  maxLeds: number;
  /** Sets a channel's LED count (the host page's set_hardware_config path). */
  setLedCount: (channel: number, n: number) => Promise<boolean>;
  /** A new state arrived: store it and re-render. */
  onState: (st: EthernetState) => void;
  /** Re-render without new state (a draft or scan changed). */
  rerender: () => void;
  /** The host page's capture-mode row for a channel. */
  captureModeRow: (channel: number) => HTMLElement | null;
  /** The host page's color-order row + check flow, appended to `g`. */
  appendColorOrder: (g: HTMLElement, cfg: HardwareChannel) => void;
}

// Drafts survive re-renders; one device page at a time.
let ethDraft: EthernetConfig | null = null;
let ethDraftBase = "";
const outDrafts = new Map<number, { base: string; o: NetworkOutput }>();
let found: DiscoveredController[] = [];
let scanning = false;
let manual: { protocol: NetProtocol; ip: string; leds: string } = { protocol: "ddp", ip: "", leds: "" };

/** Forget drafts and scan results (the page closed or the device changed). */
export function resetNetworkSection(): void {
  ethDraft = null;
  ethDraftBase = "";
  outDrafts.clear();
  found = [];
  scanning = false;
  manual = { protocol: "ddp", ip: "", leds: "" };
}

/** Every network channel in use: a target set, or LEDs counted on it. */
export function networkChannels(d: Pick<NetworkDeps, "state" | "channels">): number[] {
  const set = new Set<number>();
  for (const o of d.state?.outputs ?? []) set.add(o.channel);
  for (const c of d.channels) if (c.channel >= FIRST_NET_CHANNEL) set.add(c.channel);
  return [...set].sort((a, b) => a - b);
}

/** The first network channel with neither a target nor LEDs. */
export function freeChannel(used: number[], netChannels: number): number | null {
  for (let ch = FIRST_NET_CHANNEL; ch < FIRST_NET_CHANNEL + netChannels; ch++) {
    if (!used.includes(ch)) return ch;
  }
  return null;
}

/** Why an output can't be saved as it stands, or "". */
export function outputProblem(o: NetworkOutput): string {
  if (o.ip === 0) return "Enter the controller's address.";
  if (o.port < 0 || o.port > 65535) return "The port must be 1–65535 (empty = the default).";
  if (o.protocol === "artnet" && (o.universe < 0 || o.universe > ARTNET_MAX_UNIVERSE))
    return `The universe must be 0–${ARTNET_MAX_UNIVERSE}.`;
  return "";
}

const ledsOn = (d: NetworkDeps, ch: number): number =>
  Math.max(0, d.channels.find((c) => c.channel === ch)?.ledCount ?? 0);

function outputFor(d: NetworkDeps, ch: number): NetworkOutput {
  return (
    d.state?.outputs.find((o) => o.channel === ch) ?? {
      channel: ch,
      protocol: "ddp",
      ip: 0,
      port: 0,
      name: "",
      universe: 0,
      sync: false,
    }
  );
}

// -- one network output -------------------------------------------------------

export function outputCard(d: NetworkDeps, ch: number): HTMLElement {
  const live = outputFor(d, ch);
  const base = JSON.stringify(live);
  let entry = outDrafts.get(ch);
  if (!entry || entry.base !== base) {
    entry = { base, o: { ...live } };
    outDrafts.set(ch, entry);
  }
  const o = entry.o;
  const dirty = JSON.stringify(o) !== base;
  const leds = ledsOn(d, ch);

  const g = group(`Channel ${ch} · ${live.name || (live.ip ? ipToString(live.ip) : "network output")}`);
  const summary = document.createElement("div");
  summary.className = "hw-hint";
  summary.textContent = live.ip
    ? `${describeOutput(live, leds)}. ${leds > 0 ? `${leds} LEDs.` : "Set its LED count."}`
    : "No controller set: enter its address and save.";
  g.append(summary);

  g.append(
    row(
      "Name",
      "Shown here and in the LED layout.",
      textInput(o.name, "e.g. DISTIRA", (v) => {
        o.name = v;
        d.rerender();
      }),
    ),
    row(
      "Protocol",
      o.protocol === "artnet"
        ? "Art-Net: 170 LEDs per universe. Set the controller to the same start universe."
        : "DDP: WLED takes it with Receive UDP realtime on; nothing else to set.",
      select(
        (Object.keys(NET_PROTOCOL_LABELS) as NetProtocol[]).map((p) => ({ value: p, label: NET_PROTOCOL_LABELS[p] })),
        o.protocol,
        (v) => {
          o.protocol = v === "artnet" ? "artnet" : "ddp";
          d.rerender();
        },
      ),
    ),
    row(
      "Address",
      "The controller's IPv4 address. A subnet broadcast (x.x.x.255) works for Art-Net.",
      ipInput(o.ip, (v) => {
        o.ip = v;
        d.rerender();
      }),
    ),
    row(
      "Port",
      `Empty = the default (${defaultPort(o.protocol)}).`,
      numberInput(o.port ? String(o.port) : "", 1, 65535, (v) => {
        o.port = v ?? 0;
        d.rerender();
      }, String(defaultPort(o.protocol))),
    ),
  );
  if (o.protocol === "artnet") {
    const n = artnetUniverses(leds);
    g.append(
      row(
        "Start universe",
        leds > 0
          ? `This output takes ${n} universe${n === 1 ? "" : "s"}: ${o.universe}–${o.universe + n - 1}.`
          : "The first universe (a 15-bit port address).",
        numberInput(String(o.universe), 0, ARTNET_MAX_UNIVERSE, (v) => {
          o.universe = v ?? 0;
          d.rerender();
        }),
      ),
      row(
        "ArtSync",
        "Send ArtSync after each frame, for controllers set to wait for it (smoother across universes).",
        checkbox(o.sync, (v) => {
          o.sync = v;
          d.rerender();
        }),
      ),
    );
  }
  const saveRow = document.createElement("div");
  saveRow.className = "hw-test-actions";
  const save = Button({ label: live.ip ? "Save target" : "Save", variant: dirty ? "primary" : "quiet", onClick: () => void saveOutput(d, o) });
  if (!dirty) (save as HTMLButtonElement).disabled = true;
  saveRow.append(save);
  if (dirty) {
    saveRow.append(
      Button({
        label: "Discard",
        variant: "quiet",
        onClick: () => {
          outDrafts.delete(ch);
          d.rerender();
        },
      }),
    );
  }
  g.append(saveRow);

  g.append(
    row(
      "LED count",
      "How many LEDs this controller drives. They follow the channels before it in the LED order.",
      numberInput(leds > 0 ? String(leds) : "", 0, d.maxLeds || 100000, (v) => {
        void d.setLedCount(ch, v ?? 0);
      }, "not set"),
    ),
  );
  const cap = d.captureModeRow(ch);
  if (cap) g.append(cap);
  const cfg = d.channels.find((c) => c.channel === ch);
  if (cfg) {
    const note = document.createElement("div");
    note.className = "hw-row-hint";
    note.textContent =
      "Color order: WLED and most controllers apply their strip's own, so leave it at RGB unless the check shows colors swapped.";
    g.append(note);
    d.appendColorOrder(g, cfg);
  }

  const actions = document.createElement("div");
  actions.className = "hw-test-actions";
  actions.append(Button({ label: "Remove output", variant: "quiet", onClick: () => void removeOutput(d, ch) }));
  g.append(actions);
  return g;
}

async function saveOutput(d: NetworkDeps, o: NetworkOutput): Promise<void> {
  const problem = outputProblem(o);
  if (problem) {
    toast(problem, { error: true });
    return;
  }
  const client = d.client();
  if (!client) return;
  try {
    const st = await client.setNetworkOutput(o);
    if (st.error) toast(errorText(st.error), { error: true });
    else toast(`Channel ${o.channel} → ${describeOutput(o, ledsOn(d, o.channel))}`);
    outDrafts.delete(o.channel);
    d.onState(st);
  } catch {
    toast("Failed to save the output", { error: true });
  }
}

async function removeOutput(d: NetworkDeps, ch: number): Promise<void> {
  const client = d.client();
  if (!client) return;
  try {
    const st = await client.setNetworkOutput({ ...outputFor(d, ch), ip: 0, name: "" });
    outDrafts.delete(ch);
    d.onState(st);
    if (ledsOn(d, ch) > 0) await d.setLedCount(ch, 0);
    toast(`Channel ${ch} removed`);
  } catch {
    toast("Failed to remove the output", { error: true });
  }
}

// -- adding outputs -------------------------------------------------------------

export function addOutputCard(d: NetworkDeps): HTMLElement {
  const g = group("Add a network output");
  const used = networkChannels(d);
  const free = freeChannel(used, d.netChannels);
  const hint = document.createElement("div");
  hint.className = "hw-hint";
  hint.textContent =
    free === null
      ? `All ${d.netChannels} network outputs are in use. Remove one to add another.`
      : "A network output drives a pixel controller over Ethernet. Its LEDs come after the " +
        "channels above in the LED order, so mapping and effects cover them like a strip.";
  g.append(hint);
  if (free === null) return g;

  // Discovery (WLED over mDNS), only with Ethernet.
  if (d.caps) {
    const inUse = new Set((d.state?.outputs ?? []).map((o) => o.ip));
    for (const b of found) {
      const add = Button({
        label: inUse.has(b.ip) ? "Added" : "Add",
        onClick: () => void addOutput(d, { protocol: "ddp", ip: b.ip, name: b.name, leds: b.ledCount }),
      });
      if (inUse.has(b.ip)) (add as HTMLButtonElement).disabled = true;
      g.append(
        row(
          b.name || ipToString(b.ip),
          `WLED${b.version ? ` ${b.version}` : ""} at ${ipToString(b.ip)}${b.ledCount ? ` · ${b.ledCount} LEDs` : ""}`,
          add,
        ),
      );
    }
    const find = document.createElement("div");
    find.className = "hw-test-actions";
    find.append(
      Button({
        label: scanning ? "Looking…" : found.length ? "Look again" : "Find WLED boards",
        variant: "primary",
        onClick: () => void discover(d),
      }),
    );
    g.append(find);
  }

  // Manual.
  g.append(
    row(
      "Protocol",
      "DDP for WLED; Art-Net for Art-Net nodes and controllers.",
      select(
        (Object.keys(NET_PROTOCOL_LABELS) as NetProtocol[]).map((p) => ({ value: p, label: NET_PROTOCOL_LABELS[p] })),
        manual.protocol,
        (v) => (manual.protocol = v === "artnet" ? "artnet" : "ddp"),
      ),
    ),
    row("Address", "The controller's IPv4 address.", textInput(manual.ip, "192.168.50.2", (v) => (manual.ip = v))),
    row("LED count", "How many LEDs it drives.", textInput(manual.leds, "e.g. 1260", (v) => (manual.leds = v), "numeric")),
  );
  const add = document.createElement("div");
  add.className = "hw-test-actions";
  add.append(
    Button({
      label: `Add on channel ${free}`,
      onClick: () => {
        const ip = parseIp(manual.ip);
        if (ip === null) {
          toast("Enter the controller's address, like 192.168.50.2", { error: true });
          return;
        }
        const n = manual.leds.trim() === "" ? 0 : Math.round(Number(manual.leds));
        if (!Number.isFinite(n) || n < 0) {
          toast("The LED count must be a whole number", { error: true });
          return;
        }
        void addOutput(d, { protocol: manual.protocol, ip, name: "", leds: n });
      },
    }),
  );
  g.append(add);
  return g;
}

async function addOutput(
  d: NetworkDeps,
  a: { protocol: NetProtocol; ip: number; name: string; leds: number },
): Promise<void> {
  const client = d.client();
  if (!client) return;
  const ch = freeChannel(networkChannels(d), d.netChannels);
  if (ch === null) {
    toast(`This player drives at most ${d.netChannels} network outputs`, { error: true });
    return;
  }
  try {
    const st = await client.setNetworkOutput({
      channel: ch,
      protocol: a.protocol,
      ip: a.ip,
      port: 0,
      name: a.name,
      universe: 0,
      sync: false,
    });
    d.onState(st);
    if (st.error) {
      toast(errorText(st.error), { error: true });
      return;
    }
    manual = { protocol: "ddp", ip: "", leds: "" };
    if (a.leds > 0) await d.setLedCount(ch, a.leds);
    else toast(`Added on channel ${ch}: set its LED count`);
  } catch {
    toast("Failed to add the output", { error: true });
  }
}

async function discover(d: NetworkDeps): Promise<void> {
  const client = d.client();
  if (!client || scanning) return;
  scanning = true;
  d.rerender();
  try {
    const r = await client.discoverControllers();
    found = r.controllers;
    if (r.error) toast(errorText(r.error), { error: true });
    else if (found.length === 0) toast("No WLED boards answered yet. Try again in a moment.");
  } catch {
    toast("Discovery failed", { error: true });
  } finally {
    scanning = false;
    d.rerender();
  }
}

// -- Ethernet -------------------------------------------------------------------

export function ethernetCard(d: NetworkDeps): HTMLElement | null {
  const caps = d.caps;
  if (!caps) return null;
  const base = JSON.stringify(d.state?.config ?? caps.defaults);
  if (ethDraft === null || base !== ethDraftBase) {
    ethDraft = { ...(d.state?.config ?? caps.defaults) };
    ethDraftBase = base;
  }
  const c = ethDraft;
  const dirty = JSON.stringify(c) !== base;
  const st = d.state;

  const g = group("Ethernet");
  const status = document.createElement("div");
  status.className = "hw-hint";
  status.textContent = st ? statusText(st) : "Reading Ethernet state…";
  if (st?.mac) status.textContent += ` · MAC ${st.mac}`;
  if (st && st.config.enabled && (st.txFrames || st.txErrors))
    status.textContent += ` · ${st.txFrames} frames sent${st.txErrors ? `, ${st.txErrors} errors` : ""}`;
  g.append(status);

  g.append(
    row(
      "Enabled",
      "The wired port network outputs go out of.",
      checkbox(c.enabled, (v) => {
        c.enabled = v;
        d.rerender();
      }),
    ),
  );
  if (c.enabled) {
    g.append(
      row(
        "Addresses",
        "LED network: the player hands out addresses, for a cable or switch with only controllers " +
          "on it. DHCP client: join a router's network. Static: a fixed address.",
        select(
          IP_MODES.map((m) => ({ value: m, label: IP_MODE_LABELS[m] })),
          c.ipMode,
          (v) => {
            c.ipMode = v as EthernetConfig["ipMode"];
            d.rerender();
          },
        ),
      ),
    );
    if (c.ipMode !== "dhcp_client") {
      g.append(
        row("Address", "This player's address on that network.", ipInput(c.ip, (v) => (c.ip = v))),
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
    g.append(phyDetails(d, c, caps));
  }

  const actions = document.createElement("div");
  actions.className = "hw-test-actions";
  const apply = Button({ label: "Apply", variant: dirty ? "primary" : "quiet", onClick: () => void applyEthernet(d, c) });
  if (!dirty) (apply as HTMLButtonElement).disabled = true;
  actions.append(apply);
  if (dirty) {
    actions.append(
      Button({
        label: "Discard",
        variant: "quiet",
        onClick: () => {
          ethDraft = null;
          d.rerender();
        },
      }),
    );
  }
  g.append(actions);
  return g;
}

/** The PHY model and wiring: collapsed, since the board defaults usually fit. */
function phyDetails(d: NetworkDeps, c: EthernetConfig, caps: EthernetCaps): HTMLElement {
  const det = document.createElement("details");
  det.className = "hw-details";
  const sum = document.createElement("summary");
  sum.className = "hw-row-name";
  sum.textContent = `PHY: ${PHY_LABELS[c.phy] ?? c.phy}, MDC ${c.mdcGpio} / MDIO ${c.mdioGpio}`;
  det.append(sum);
  const phys = caps.phys.length ? caps.phys : ["ip101"];
  det.append(
    row(
      "PHY",
      "The Ethernet chip on the board or the add-on module.",
      select(phys.map((p) => ({ value: p, label: PHY_LABELS[p] ?? p })), c.phy, (v) => {
        c.phy = v;
        d.rerender();
      }),
    ),
    row(
      "PHY address",
      "Its MDIO address (often 0 or 1). Empty = scan for it.",
      numberInput(c.phyAddr < 0 ? "" : String(c.phyAddr), 0, 31, (v) => (c.phyAddr = v ?? -1), "scan"),
    ),
    row("MDC pin", "The management clock GPIO.", numberInput(String(c.mdcGpio), 0, 54, (v) => (c.mdcGpio = v ?? c.mdcGpio))),
    row("MDIO pin", "The management data GPIO.", numberInput(String(c.mdioGpio), 0, 54, (v) => (c.mdioGpio = v ?? c.mdioGpio))),
    row(
      "PHY reset pin",
      "The GPIO wired to the PHY's reset. Empty = none.",
      numberInput(c.phyResetGpio < 0 ? "" : String(c.phyResetGpio), 0, 54, (v) => (c.phyResetGpio = v ?? -1), "none"),
    ),
    row(
      "50 MHz clock",
      "Most PHYs drive the RMII clock into GPIO50. If the P4 makes it, it goes out on the pin " +
        "you pick, which the board must loop back to GPIO50.",
      select(
        [
          { value: "in", label: "From the PHY, into GPIO50" },
          { value: "out", label: "From the P4" },
        ],
        c.clock,
        (v) => {
          c.clock = v === "out" ? "out" : "in";
          d.rerender();
        },
      ),
    ),
  );
  if (c.clock === "out") {
    det.append(
      row("Clock out pin", "The GPIO the P4 drives the clock on.", numberInput(String(Math.max(0, c.clockGpio)), 0, 54, (v) => (c.clockGpio = v ?? c.clockGpio))),
    );
  }
  const pins = document.createElement("div");
  pins.className = "hw-row-hint";
  pins.textContent = `RMII data pins (fixed): ${caps.rmiiGpios.join(", ")}. LED strips can't use them while Ethernet is on.`;
  det.append(pins);
  det.append(
    Button({
      label: "Board defaults",
      variant: "quiet",
      onClick: () => {
        ethDraft = { ...caps.defaults, enabled: c.enabled, ipMode: c.ipMode, ip: c.ip, netmask: c.netmask, gateway: c.gateway };
        d.rerender();
      },
    }),
  );
  return det;
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

async function applyEthernet(d: NetworkDeps, c: EthernetConfig): Promise<void> {
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
    ethDraft = null;
    d.onState(st);
  } catch {
    toast("Failed to apply the Ethernet settings", { error: true });
  }
}

// -- builders -------------------------------------------------------------------

function numberInput(
  value: string,
  min: number,
  max: number,
  onSet: (v: number | null) => void,
  placeholder = "",
): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "hw-select";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.inputMode = "numeric";
  input.placeholder = placeholder;
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

function textInput(value: string, placeholder: string, onSet: (v: string) => void, mode = "text"): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hw-select";
  input.inputMode = mode as HTMLInputElement["inputMode"];
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener("change", () => onSet(input.value.trim()));
  return input;
}

function ipInput(ip: number, onSet: (v: number) => void, allowEmpty = false): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hw-select";
  input.inputMode = "decimal";
  input.placeholder = "192.168.50.2";
  input.value = ip ? ipToString(ip) : "";
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    if (raw === "" && allowEmpty) return onSet(0);
    const v = parseIp(raw);
    if (v === null) {
      toast("Enter an address like 192.168.50.2", { error: true });
      input.value = ip ? ipToString(ip) : "";
      return;
    }
    onSet(v);
  });
  return input;
}

function checkbox(value: boolean, onSet: (v: boolean) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => onSet(input.checked));
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
