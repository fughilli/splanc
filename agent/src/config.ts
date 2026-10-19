/**
 * The hub's persistent state (docs/design/agent-multi-fixture.md §1-2), one JSON
 * file in `$SPLANC_CONFIG_DIR` (default `~/.config/splanc/hub.json`):
 *
 * - players: every player the hub has seen, keyed by MAC (last host, name,
 *   firmware, TLS pin) — so a fresh run finds them again even when mDNS doesn't;
 * - groups: named rooms/groups of players;
 * - poses: each fixture's pose in its room's frame, until the firmware can hold
 *   it itself (the `fixture_pose` feature).
 *
 * Writes are atomic (temp + rename) and best-effort: a read-only home must not
 * stop the bridge, it just forgets between runs.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RememberedPlayer {
  host: string;
  name?: string;
  fw?: string;
  pin?: string;
  lastSeen?: string;
}

/** A fixture's pose in its room frame: p_room = translation + scale * R(rotation) p_map. */
export interface Pose {
  room: string;
  /** Metres. */
  translation: [number, number, number];
  /** Unit quaternion [x, y, z, w]. */
  rotation: [number, number, number, number];
  scale: number;
}

export interface HubConfig {
  players: Record<string, RememberedPlayer>;
  groups: Record<string, string[]>;
  poses: Record<string, Pose>;
}

export function configPath(): string {
  const dir = process.env["SPLANC_CONFIG_DIR"] ?? join(homedir(), ".config", "splanc");
  return join(dir, "hub.json");
}

export function loadConfig(path = configPath()): HubConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HubConfig>;
    return { players: raw.players ?? {}, groups: raw.groups ?? {}, poses: raw.poses ?? {} };
  } catch {
    return { players: {}, groups: {}, poses: {} };
  }
}

export function saveConfig(cfg: HubConfig, path = configPath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export function cacheDir(): string {
  return process.env["SPLANC_CACHE_DIR"] ?? join(homedir(), ".cache", "splanc");
}
