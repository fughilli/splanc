/**
 * Per-device "on device" effect tracking (FUG-110). The device runs two FX
 * decks in RAM; the app is the source of truth for the effect LIBRARY and
 * remembers which library effects it has pushed to each device, so the effects
 * browser can:
 *
 *   - show a green "on device" badge on any library effect sent to the
 *     currently-connected device, and
 *   - surface an ephemeral "On <device>" folder listing those effects.
 *
 * Ephemeral in the sense that it is keyed by the stable device id (idForUrl /
 * MAC), lives only in this browser's localStorage, and is cleared when the app
 * clears a device — it mirrors what the app has sent, not a device query (the
 * player only holds the two cued decks, not a browsable store).
 */

const KEY = "ledmapper.deviceEffects";

type State = Record<string, string[]>; // deviceId -> effect ids sent to it

type Listener = () => void;

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as State;
  } catch {
    return {};
  }
}

function write(state: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full / disabled — a non-persisted badge is a tolerable loss.
  }
}

class DeviceEffectStore {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Effect ids the app has pushed to `deviceId` (most-recent order kept). */
  list(deviceId: string | null | undefined): string[] {
    if (!deviceId) return [];
    return read()[deviceId] ?? [];
  }

  /** Whether `effectId` has been sent to `deviceId`. */
  has(deviceId: string | null | undefined, effectId: string): boolean {
    if (!deviceId) return false;
    return (read()[deviceId] ?? []).includes(effectId);
  }

  /** Record that `effectId` now lives on `deviceId` (idempotent, moves it to
   * the front so the folder lists most-recently-cued first). */
  markSent(deviceId: string | null | undefined, effectId: string): void {
    if (!deviceId || !effectId) return;
    const state = read();
    const cur = (state[deviceId] ?? []).filter((id) => id !== effectId);
    cur.unshift(effectId);
    state[deviceId] = cur;
    write(state);
    this.emit();
  }

  /** Forget that `effectId` is on `deviceId` (e.g. the effect was deleted). */
  unmark(deviceId: string | null | undefined, effectId: string): void {
    if (!deviceId) return;
    const state = read();
    const cur = (state[deviceId] ?? []).filter((id) => id !== effectId);
    if (cur.length > 0) state[deviceId] = cur;
    else delete state[deviceId];
    write(state);
    this.emit();
  }

  /** Drop `effectId` from every device (called when a library effect is
   * deleted, so no stale badge/folder entry lingers). */
  forgetEverywhere(effectId: string): void {
    const state = read();
    let changed = false;
    for (const deviceId of Object.keys(state)) {
      const cur = state[deviceId]!.filter((id) => id !== effectId);
      if (cur.length !== state[deviceId]!.length) {
        changed = true;
        if (cur.length > 0) state[deviceId] = cur;
        else delete state[deviceId];
      }
    }
    if (changed) {
      write(state);
      this.emit();
    }
  }

  /** Forget every effect sent to `deviceId`. */
  clear(deviceId: string): void {
    const state = read();
    if (deviceId in state) {
      delete state[deviceId];
      write(state);
      this.emit();
    }
  }
}

export const deviceEffects = new DeviceEffectStore();
