/**
 * Ethernet + network LED outputs (docs/design/p4-ethernet-ddp.md): the P4
 * player's wired port and the WLED boards it streams DDP to, as LED channels
 * 2.. after its GPIO strips.
 *
 * Pure (no DOM): the wire <-> app shape conversion the client uses, IPv4
 * helpers and the status wording the Hardware Setup page shows. Unit-tested in
 * tests/ethernet.test.ts.
 *
 * IPv4 addresses ride the wire as fixed32 numbers holding the four octets
 * big-endian (192.168.50.1 = 0xC0A83201).
 */

import { b64ToBytes } from "./proto";

export type PhyId = "ip101" | "lan8720" | "rtl8201" | "dp83848" | "ksz80xx";
export const PHY_LABELS: Record<string, string> = {
  ip101: "IP101 (P4-NANO, P4 Function EV)",
  lan8720: "LAN8720 module",
  rtl8201: "RTL8201 module",
  dp83848: "DP83848 module",
  ksz80xx: "KSZ80xx module",
};

export type RmiiClock = "in" | "out";
export type IpMode = "dhcp_client" | "static" | "dhcp_server";
export const IP_MODES: IpMode[] = ["dhcp_server", "dhcp_client", "static"];
export const IP_MODE_LABELS: Record<IpMode, string> = {
  dhcp_server: "LED network (hand out addresses)",
  dhcp_client: "DHCP client (join a router)",
  static: "Static address",
};

/** The Ethernet config, app side (proto EthernetConfig). */
export interface EthernetConfig {
  enabled: boolean;
  phy: string;
  /** MDIO address of the PHY; -1 = scan. */
  phyAddr: number;
  mdcGpio: number;
  mdioGpio: number;
  /** -1 = none. */
  phyResetGpio: number;
  clock: RmiiClock;
  clockGpio: number;
  ipMode: IpMode;
  ip: number;
  netmask: number;
  gateway: number;
}

export type NetProtocol = "ddp" | "artnet";
export const NET_PROTOCOL_LABELS: Record<NetProtocol, string> = {
  ddp: "DDP (WLED, most pixel bridges)",
  artnet: "Art-Net",
};

/** One network output (proto NetworkOutput): an LED channel streaming to a
 * controller. Its LED count lives with the channel (hardware_config_state). */
export interface NetworkOutput {
  channel: number;
  protocol: NetProtocol;
  ip: number;
  /** 0 = the protocol default (4048 for DDP, 6454 for Art-Net). */
  port: number;
  name: string;
  /** Art-Net: the first universe (15-bit port address). */
  universe: number;
  /** Art-Net: an ArtSync after each frame. */
  sync: boolean;
}

/** The device's Ethernet state (proto EthernetState), normalized. */
export interface EthernetState {
  config: EthernetConfig;
  outputs: NetworkOutput[];
  linkUp: boolean;
  speedMbps: number;
  fullDuplex: boolean;
  ip: number;
  netmask: number;
  gateway: number;
  /** "aa:bb:cc:dd:ee:ff", or "" if not reported. */
  mac: string;
  /** "" or a machine code: why bring-up failed or a request was refused. */
  error: string;
  txFrames: number;
  txErrors: number;
}

/** A controller discovery found (proto DiscoveredController). */
export interface DiscoveredController {
  name: string;
  ip: number;
  mac: string;
  ledCount: number;
  version: string;
  kind: string;
}

/** What the board can do (proto EthernetCaps), from hardware_config_state.board. */
export interface EthernetCaps {
  phys: string[];
  defaults: EthernetConfig;
  rmiiGpios: number[];
}

export const DDP_PORT = 4048;
export const ARTNET_PORT = 6454;
/** Pixels one Art-Net universe carries (510 of its 512 channels). */
export const ARTNET_PX_PER_UNIVERSE = 170;
export const ARTNET_MAX_UNIVERSE = 0x7fff;

export function defaultPort(p: NetProtocol): number {
  return p === "artnet" ? ARTNET_PORT : DDP_PORT;
}

/** Universes an Art-Net output of `leds` LEDs takes. */
export function artnetUniverses(leds: number): number {
  return Math.max(1, Math.ceil(Math.max(0, leds) / ARTNET_PX_PER_UNIVERSE));
}

/** "DDP → 192.168.50.2" / "Art-Net → 10.0.0.9, universes 3–10" for a summary line. */
export function describeOutput(o: NetworkOutput, leds: number): string {
  const addr = `${ipToString(o.ip)}${o.port && o.port !== defaultPort(o.protocol) ? `:${o.port}` : ""}`;
  if (o.protocol !== "artnet") return `DDP → ${addr}`;
  const n = artnetUniverses(leds);
  const range = n > 1 ? `universes ${o.universe}–${o.universe + n - 1}` : `universe ${o.universe}`;
  return `Art-Net → ${addr}, ${range}${o.sync ? ", ArtSync" : ""}`;
}

// -- IPv4 ---------------------------------------------------------------------

/** A wire IPv4 (u32, octets big-endian) -> "a.b.c.d". */
export function ipToString(ip: number): string {
  const v = ip >>> 0;
  return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

/** "a.b.c.d" -> the wire u32, or null if it isn't a dotted quad. */
export function parseIp(s: string): number | null {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return (((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0);
}

/** A netmask's prefix length, or null if it isn't contiguous ones then zeros. */
export function prefixLength(mask: number): number | null {
  const m = mask >>> 0;
  if (m === 0) return null;
  let n = 0;
  while (n < 32 && (m & (0x80000000 >>> n)) !== 0) n++;
  const rebuilt = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return rebuilt === m ? n : null;
}

/** "/24" -> 255.255.255.0 as a wire u32. */
export function maskFromPrefix(n: number): number {
  return n <= 0 ? 0 : (0xffffffff << (32 - Math.min(n, 32))) >>> 0;
}

/** Is `ip` a usable host address in the subnet `ip/mask`? */
export function isHostAddress(ip: number, mask: number): boolean {
  if (prefixLength(mask) === null) return false;
  const host = (ip & ~mask) >>> 0;
  const first = ip >>> 24;
  return host !== 0 && host !== ~mask >>> 0 && first !== 0 && first !== 127 && first < 224;
}

// -- wire <-> app -------------------------------------------------------------

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** proto3 JSON gives bytes as base64; show a MAC as aa:bb:... */
export function macFromWire(v: unknown): string {
  let b: Uint8Array | null = null;
  if (v instanceof Uint8Array) b = v;
  else if (typeof v === "string" && v.length > 0) {
    try {
      b = b64ToBytes(v);
    } catch {
      b = null;
    }
  }
  if (!b || b.length !== 6) return "";
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(":");
}

export function protocolFromWire(v: unknown): NetProtocol {
  return v === 1 || v === "NET_PROTOCOL_ARTNET" ? "artnet" : "ddp";
}

export function protocolToWire(p: NetProtocol): string {
  return p === "artnet" ? "NET_PROTOCOL_ARTNET" : "NET_PROTOCOL_DDP";
}

function clockFromWire(v: unknown): RmiiClock {
  return v === 1 || v === "RMII_CLOCK_OUT" ? "out" : "in";
}

function ipModeFromWire(v: unknown): IpMode {
  if (v === 1 || v === "IP_MODE_STATIC") return "static";
  if (v === 2 || v === "IP_MODE_DHCP_SERVER") return "dhcp_server";
  return "dhcp_client";
}

const IP_MODE_TO_WIRE: Record<IpMode, string> = {
  dhcp_client: "IP_MODE_DHCP_CLIENT",
  static: "IP_MODE_STATIC",
  dhcp_server: "IP_MODE_DHCP_SERVER",
};

/** A wire EthernetConfig (proto3 JSON: zeros omitted) -> the app shape. */
export function configFromWire(c: unknown): EthernetConfig {
  const o = (c ?? {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    phy: str(o.phy) || "ip101",
    phyAddr: num(o.phyAddr),
    mdcGpio: num(o.mdcGpio),
    mdioGpio: num(o.mdioGpio),
    phyResetGpio: num(o.phyResetGpio),
    clock: clockFromWire(o.clock),
    clockGpio: num(o.clockGpio),
    ipMode: ipModeFromWire(o.ipMode),
    ip: num(o.ip) >>> 0,
    netmask: num(o.netmask) >>> 0,
    gateway: num(o.gateway) >>> 0,
  };
}

/** The app shape -> a wire EthernetConfig (every field: the device replaces the
 * whole config). */
export function configToWire(c: EthernetConfig): Record<string, unknown> {
  return {
    enabled: c.enabled,
    phy: c.phy,
    phyAddr: c.phyAddr,
    mdcGpio: c.mdcGpio,
    mdioGpio: c.mdioGpio,
    phyResetGpio: c.phyResetGpio,
    clock: c.clock === "out" ? "RMII_CLOCK_OUT" : "RMII_CLOCK_EXT_IN",
    clockGpio: c.clockGpio,
    ipMode: IP_MODE_TO_WIRE[c.ipMode],
    ip: c.ip >>> 0,
    netmask: c.netmask >>> 0,
    gateway: c.gateway >>> 0,
  };
}

export function stateFromWire(m: unknown): EthernetState {
  const o = (m ?? {}) as Record<string, unknown>;
  const outputs = Array.isArray(o.outputs) ? o.outputs : [];
  return {
    config: configFromWire(o.config),
    outputs: outputs.map((x) => {
      const p = (x ?? {}) as Record<string, unknown>;
      return {
        channel: num(p.channel),
        protocol: protocolFromWire(p.protocol),
        ip: num(p.ip) >>> 0,
        port: num(p.port),
        name: str(p.name),
        universe: num(p.universe),
        sync: p.sync === true,
      };
    }),
    linkUp: o.linkUp === true,
    speedMbps: num(o.speedMbps),
    fullDuplex: o.fullDuplex === true,
    ip: num(o.ip) >>> 0,
    netmask: num(o.netmask) >>> 0,
    gateway: num(o.gateway) >>> 0,
    mac: macFromWire(o.mac),
    error: str(o.error),
    txFrames: num(o.txFrames),
    txErrors: num(o.txErrors),
  };
}

export function controllersFromWire(m: unknown): { controllers: DiscoveredController[]; error: string } {
  const o = (m ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.controllers) ? o.controllers : [];
  return {
    controllers: list.map((x) => {
      const c = (x ?? {}) as Record<string, unknown>;
      return {
        name: str(c.name),
        ip: num(c.ip) >>> 0,
        mac: macFromWire(c.mac),
        ledCount: num(c.ledCount),
        version: str(c.version),
        kind: str(c.kind) || "wled",
      };
    }),
    error: str(o.error),
  };
}

export function capsFromWire(e: unknown): EthernetCaps | null {
  if (e === null || e === undefined || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  return {
    phys: Array.isArray(o.phys) ? o.phys.filter((x): x is string => typeof x === "string") : [],
    defaults: configFromWire(o.defaults),
    rmiiGpios: Array.isArray(o.rmiiGpios) ? o.rmiiGpios.filter((x): x is number => typeof x === "number") : [],
  };
}

/** The GPIOs an enabled config takes: the fixed RMII bus, MDC, MDIO, reset and
 * a clock-out pin. Shown as busy in the LED pin picker. */
export function busyPins(c: EthernetConfig, caps: EthernetCaps | null): number[] {
  if (!c.enabled) return [];
  const pins = [...(caps?.rmiiGpios ?? []), c.mdcGpio, c.mdioGpio, c.phyResetGpio];
  if (c.clock === "out") pins.push(c.clockGpio);
  return [...new Set(pins.filter((p) => p >= 0))];
}

// -- wording ------------------------------------------------------------------

const ERRORS: Record<string, string> = {
  phy_not_found: "No PHY answered. Check the PHY model, its MDIO address and the MDC/MDIO pins.",
  bad_phy: "That PHY model or MDIO address isn't supported.",
  bad_pin: "A pin is out of range or used twice.",
  pin_in_use: "An LED strip uses one of these pins. Move the strip or pick other pins.",
  bad_address: "That address, netmask or gateway doesn't work together.",
  bad_channel: "That output channel doesn't exist on this player.",
  emac_init: "The Ethernet controller didn't start (check the RMII clock).",
  netif: "The network interface didn't start.",
  no_link: "No Ethernet link: check the cable.",
  no_ethernet: "This player has no Ethernet.",
  bad_message: "The player didn't understand the request.",
};

export function errorText(code: string): string {
  return code === "" ? "" : (ERRORS[code] ?? `Error: ${code}`);
}

/** One line for the status row. */
export function statusText(s: EthernetState): string {
  if (!s.config.enabled) return "Off";
  if (s.error) return errorText(s.error);
  if (!s.linkUp) return "No link: check the cable";
  const speed = `${s.speedMbps} Mbps${s.fullDuplex ? "" : " half duplex"}`;
  const pfx = prefixLength(s.netmask);
  const addr = s.ip ? `${ipToString(s.ip)}${pfx !== null ? `/${pfx}` : ""}` : "waiting for an address";
  return `Link up, ${speed}, ${addr}`;
}
