/**
 * Known-devices store (design doc §6.2 / §7.5) — localStorage-backed list of
 * players the user has connected to. Each record keeps the display name (which
 * is also the device's Bluetooth-advertised name), the last-known LAN address
 * (the wss URL), and the hardware MAC the device reports in its `welcome`. That
 * MAC lets the app recognize the SAME player across the BLE-onboarding and LAN
 * paths. Screens read/mutate through this module only.
 */

export interface KnownDevice {
  id: string;
  /** Last-known LAN address as a wss URL (wss://host[:port]/ws). */
  wssUrl: string;
  /** Display name — also the device's Bluetooth-advertised name. */
  label: string;
  /** Last hardware MAC the device reported (welcome.mac); "" until seen. */
  bleMac: string;
  /** Web Bluetooth's stable device id captured when this device was provisioned
   * over BLE — used to warn if a re-discover picks a DIFFERENT physical device. */
  bleId?: string;
  /** True once the device reported its own name (so a host fallback never
   * clobbers a real device name). */
  named: boolean;
  /** A rename queued while disconnected — pushed to the device on next connect
   * (which renames its Bluetooth advertisement + persists it). */
  pendingName?: string;
  /** Optional folder for organizing devices; "" / absent = ungrouped. */
  folder?: string;
  /** Firmware git commit last reported in `welcome` (full hash); absent/"" until
   * seen or on older firmware. Shown + linked on the device card (FUG-126). */
  fwGitCommit?: string;
  /** Whether that firmware build had a dirty working tree. */
  fwGitDirty?: boolean;
  /** Firmware release version last reported in `welcome` (nearest firmware-v*
   * tag, e.g. "1.2.0"); absent/"" until seen or on older firmware. Shown on the
   * device card alongside the commit. */
  fwVersion?: string;
  /** ISO timestamp of the last successful connection. */
  lastSeen: string;
}

const KEY = "ledmapper.devices";
const ACTIVE_KEY = "ledmapper.activeDevice";

type Listener = () => void;

/** Friendly default label from a wss URL (host[:port]). */
function labelForUrl(wssUrl: string): string {
  try {
    return new URL(wssUrl).host;
  } catch {
    return wssUrl;
  }
}

/** Fill in fields absent from older stored records. */
function normalize(d: Partial<KnownDevice> & { id: string; wssUrl: string }): KnownDevice {
  return {
    id: d.id,
    wssUrl: d.wssUrl,
    label: d.label ?? labelForUrl(d.wssUrl),
    bleMac: d.bleMac ?? "",
    named: d.named ?? false,
    ...(d.bleId ? { bleId: d.bleId } : {}),
    ...(d.folder ? { folder: d.folder } : {}),
    ...(d.pendingName ? { pendingName: d.pendingName } : {}),
    lastSeen: d.lastSeen ?? new Date(0).toISOString(),
  };
}

function read(): KnownDevice[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as KnownDevice[]) : [];
    return Array.isArray(arr) ? arr.filter((d) => d && d.id && d.wssUrl).map(normalize) : [];
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

/** The host[:port] of a device's LAN address (for the detail view). */
export function deviceHost(dev: KnownDevice): string {
  try {
    return new URL(dev.wssUrl).host;
  } catch {
    return dev.wssUrl;
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

  private mutate(id: string, fn: (d: KnownDevice) => void): KnownDevice | undefined {
    const list = read();
    const d = list.find((x) => x.id === id);
    if (!d) return undefined;
    fn(d);
    write(list);
    this.emit();
    return d;
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
      existing.wssUrl = wssUrl;
      if (label && !existing.named) existing.label = label;
      write(list);
      this.emit();
      return existing;
    }
    const dev = normalize({ id, wssUrl, label: label ?? labelForUrl(wssUrl), lastSeen: now });
    list.push(dev);
    write(list);
    this.emit();
    return dev;
  }

  /** Fold a device's `welcome` (mac + device name) into its record: adopt the
   * MAC and, unless a rename is queued, the device's own name as the display
   * name. Also collapses any OTHER record for the same physical device.
   *
   * The store dedups by URL string (idForUrl), but the same player is reachable
   * under different URL spellings — BLE-onboarding registers wss://ledmapper.local/ws
   * while "add device by address" adds wss://<ip>, and a manual entry can differ
   * from a prior one only by an added port/path. Each spelling is a distinct id,
   * so the same device shows up twice. The `welcome` MAC is the true hardware
   * identity, so once we learn it we merge any duplicate that shares it into THIS
   * record — the freshly-connected one, whose URL we know is reachable — folding
   * the absorbed record's user-set fields (folder, BLE id, a queued rename, a
   * user-given name) in so nothing is lost. */
  applyWelcome(
    id: string,
    welcome: {
      mac?: string;
      deviceName?: string;
      fwGitCommit?: string;
      fwGitDirty?: boolean;
      fwVersion?: string;
    },
  ): void {
    const list = read();
    const d = list.find((x) => x.id === id);
    if (!d) return;
    if (welcome.mac) d.bleMac = welcome.mac;
    if (welcome.deviceName && !d.pendingName) {
      d.label = welcome.deviceName;
      d.named = true;
    }
    // Build info: adopt whatever the latest welcome reported (a firmware update
    // can change it; "" means older firmware / unstamped — leave prior value).
    if (welcome.fwGitCommit !== undefined) d.fwGitCommit = welcome.fwGitCommit;
    if (welcome.fwGitDirty !== undefined) d.fwGitDirty = welcome.fwGitDirty;
    if (welcome.fwVersion !== undefined) d.fwVersion = welcome.fwVersion;
    d.lastSeen = new Date().toISOString();
    const dups = welcome.mac ? list.filter((x) => x.id !== id && x.bleMac === welcome.mac) : [];
    for (const dup of dups) {
      if (!d.folder && dup.folder) d.folder = dup.folder;
      if (!d.bleId && dup.bleId) d.bleId = dup.bleId;
      if (!d.pendingName && dup.pendingName) d.pendingName = dup.pendingName;
      if (!d.named && dup.named) {
        d.label = dup.label;
        d.named = true;
      }
    }
    write(dups.length ? list.filter((x) => !dups.includes(x)) : list);
    const active = this.activeId();
    if (active && dups.some((x) => x.id === active)) this.setActive(id);
    this.emit();
  }

  /** Record the Web Bluetooth device id captured during BLE provisioning, keyed
   * by the resulting wss URL. */
  setBleId(wssUrl: string, bleId: string): void {
    if (!bleId) return;
    this.mutate(idForUrl(wssUrl), (d) => {
      d.bleId = bleId;
    });
  }

  setActive(id: string | null): void {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
    this.emit();
  }

  /** Set the display name. Shown immediately (optimistic) and queued as a
   * pendingName to push to the device on the next connection; if a device is
   * connected the caller also pushes it live via client.setDeviceName. */
  rename(id: string, label: string): void {
    const name = label.trim();
    if (!name) return;
    this.mutate(id, (d) => {
      d.label = name;
      d.named = true;
      d.pendingName = name;
    });
  }

  /** Read + clear a queued rename (called when it has been pushed to a device). */
  takePending(id: string): string | undefined {
    let pending: string | undefined;
    this.mutate(id, (d) => {
      pending = d.pendingName;
      delete d.pendingName;
    });
    return pending;
  }

  /** Assign a folder (empty string = ungrouped). */
  setFolder(id: string, folder: string): void {
    this.mutate(id, (d) => {
      d.folder = folder.trim();
    });
  }

  /** Distinct non-empty folder names, sorted. */
  folders(): string[] {
    const set = new Set<string>();
    for (const d of read()) if (d.folder) set.add(d.folder);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  forget(id: string): void {
    write(read().filter((d) => d.id !== id));
    if (this.activeId() === id) this.setActive(null);
    this.emit();
  }
}

export const deviceStore = new DeviceStore();
export { idForUrl as deviceIdForUrl };
