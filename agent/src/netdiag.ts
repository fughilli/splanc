/**
 * Why can't this machine reach a player's IP? Linux-only hints from the kernel's
 * neighbour (ARP) table, added to connection errors so they say more than
 * EHOSTUNREACH / a timeout:
 *
 * - a PERMANENT entry for the IP: someone pinned it (`arp -s`, `ip neigh add|replace
 *   ... nud permanent`). Normal ARP never creates one, and on players that pick a
 *   random Wi-Fi MAC every boot a pinned entry is wrong after the next reboot:
 *   every packet to that IP goes to a MAC nobody has;
 * - an INCOMPLETE/FAILED entry: nothing answered ARP at that address — the player
 *   isn't there (any more).
 */

import { readFileSync } from "node:fs";

import { splitHost } from "./registry";

const ATF_COM = 0x2;
const ATF_PERM = 0x4;

export interface NeighEntry {
  ip: string;
  mac: string;
  dev: string;
  flags: number;
}

export function parseProcArp(text: string): NeighEntry[] {
  const out: NeighEntry[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    out.push({ ip: f[0]!, flags: Number.parseInt(f[2]!, 16) || 0, mac: f[3]!.toLowerCase(), dev: f[5]! });
  }
  return out;
}

/** A hint about `host`'s neighbour entry, or "" when there is nothing notable (or
 * no /proc/net/arp: not Linux). */
export function neighbourHint(host: string, read: () => string = () => readFileSync("/proc/net/arp", "utf8")): string {
  const [ip] = splitHost(host);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return "";
  let entries: NeighEntry[];
  try {
    entries = parseProcArp(read());
  } catch {
    return "";
  }
  const e = entries.find((x) => x.ip === ip);
  if (!e) return "";
  if (e.flags & ATF_PERM) {
    return (
      `this machine has a PERMANENT ARP entry for ${ip} -> ${e.mac} on ${e.dev} (pinned by hand: normal ARP never ` +
      `creates one). A player that picks a new Wi-Fi MAC each boot is unreachable through it: remove it with ` +
      `\`sudo ip neigh del ${ip} dev ${e.dev}\``
    );
  }
  if (!(e.flags & ATF_COM)) return `nothing answers ARP at ${ip} on ${e.dev}: no device has that address now`;
  return "";
}
