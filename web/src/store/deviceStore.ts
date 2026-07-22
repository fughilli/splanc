/**
 * Known-devices store (design doc §6.2 / §7.5) — localStorage-backed list of
 * players the user has connected to, generalizing today's single `?url=`
 * binding into a managed list. Screens read/mutate through this module only.
 */

export interface KnownDevice {
  id: string;
  label: string;
  wssUrl: string;
  /** ISO timestamp of the last successful connection. */
  lastSeen: string;
}

const KEY = "ledmapper.devices";
const ACTIVE_KEY = "ledmapper.activeDevice";

type Listener = () => void;

function read(): KnownDevice[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as KnownDevice[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(list: KnownDevice[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* non-fatal */
  }
}

/** Stable id derived from the wss URL (so re-adding the same device dedups). */
function idForUrl(wssUrl: string): string {
  return `dev-${wssUrl.replace(/[^a-z0-9]+/gi, "-")}`;
}

/** Friendly default label from a wss URL (host[:port]). */
function labelForUrl(wssUrl: string): string {
  try {
    const u = new URL(wssUrl);
    return u.host;
  } catch {
    return wssUrl;
  }
}

class DeviceStore {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  list(): KnownDevice[] {
    return read().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  get(id: string): KnownDevice | undefined {
    return read().find((d) => d.id === id);
  }

  activeId(): string | null {
    return localStorage.getItem(ACTIVE_KEY);
  }

  active(): KnownDevice | undefined {
    const id = this.activeId();
    return id ? this.get(id) : undefined;
  }

  /** Add (or refresh lastSeen for) a device by URL; returns its id. Does not
   * change the active selection. */
  upsert(wssUrl: string, label?: string): KnownDevice {
    const list = read();
    const id = idForUrl(wssUrl);
    const now = new Date().toISOString();
    const existing = list.find((d) => d.id === id);
    if (existing) {
      existing.lastSeen = now;
      if (label) existing.label = label;
      write(list);
      this.emit();
      return existing;
    }
    const dev: KnownDevice = { id, label: label ?? labelForUrl(wssUrl), wssUrl, lastSeen: now };
    list.push(dev);
    write(list);
    this.emit();
    return dev;
  }

  setActive(id: string | null): void {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
    this.emit();
  }

  rename(id: string, label: string): void {
    const list = read();
    const d = list.find((x) => x.id === id);
    if (!d) return;
    d.label = label;
    write(list);
    this.emit();
  }

  forget(id: string): void {
    write(read().filter((d) => d.id !== id));
    if (this.activeId() === id) this.setActive(null);
    this.emit();
  }
}

export const deviceStore = new DeviceStore();
export { idForUrl as deviceIdForUrl };
