/**
 * New-fixture onboarding state (D-259): the name the user gave a fixture while
 * flashing or setting it up (applied once the app connects to it), and which
 * devices have already been through (or skipped) the new-fixture setup flow.
 *
 * Pure decisions are exported for tests/newFixture.test.ts; storage is
 * best-effort (sessionStorage for the pending name, localStorage for "seen").
 */

/** The firmware keeps a device name of at most this many UTF-8 bytes. */
export const MAX_NAME_BYTES = 32;

/** A name the user typed, trimmed and cut to the firmware's limit (on a whole
 * character). Empty when nothing usable was typed. */
export function normalizeFixtureName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  const enc = new TextEncoder();
  if (enc.encode(name).length <= MAX_NAME_BYTES) return name;
  let out = "";
  for (const ch of name) {
    if (enc.encode(out + ch).length > MAX_NAME_BYTES) break;
    out += ch;
  }
  return out.trim();
}

/** A name waiting for its fixture. `mac` (from the flasher) pins it to one board;
 * without it, the next fixture the app connects to within the window takes it. */
export interface PendingName {
  name: string;
  mac?: string;
  at: number;
}

/** How long a name waits for its fixture (flash, then set up Wi-Fi, then connect). */
export const PENDING_TTL_MS = 30 * 60 * 1000;

function normMac(mac: string | undefined): string {
  return (mac ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
}

/** Does the pending name belong to the fixture that just connected? */
export function pendingMatches(p: PendingName | null, welcomeMac: string | undefined, now: number): boolean {
  if (!p || !p.name) return false;
  if (now - p.at > PENDING_TTL_MS || now < p.at) return false;
  if (!p.mac) return true;
  return normMac(p.mac) !== "" && normMac(p.mac) === normMac(welcomeMac);
}

const PENDING_KEY = "splanc.newFixture.pendingName";
const SEEN_KEY = "splanc.newFixture.seen";

function store(kind: "session" | "local"): Storage | null {
  try {
    return kind === "session" ? globalThis.sessionStorage ?? null : globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export const pendingName = {
  get(): PendingName | null {
    try {
      const raw = store("session")?.getItem(PENDING_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as PendingName;
      return typeof p?.name === "string" && typeof p.at === "number" ? p : null;
    } catch {
      return null;
    }
  },
  set(name: string, mac?: string, now = Date.now()): void {
    const n = normalizeFixtureName(name);
    try {
      if (!n) store("session")?.removeItem(PENDING_KEY);
      else store("session")?.setItem(PENDING_KEY, JSON.stringify({ name: n, ...(mac ? { mac } : {}), at: now }));
    } catch {
      // storage off: the name is simply not carried over
    }
  },
  clear(): void {
    try {
      store("session")?.removeItem(PENDING_KEY);
    } catch {
      // nothing to clear
    }
  },
};

/** Devices (by stable device id) that have had the new-fixture setup offered. */
export const setupSeen = {
  has(deviceId: string): boolean {
    return this.all().includes(deviceId);
  },
  all(): string[] {
    try {
      const v = JSON.parse(store("local")?.getItem(SEEN_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  },
  mark(deviceId: string): void {
    const all = this.all();
    if (all.includes(deviceId)) return;
    try {
      store("local")?.setItem(SEEN_KEY, JSON.stringify([...all, deviceId].slice(-200)));
    } catch {
      // storage off: the flow may be offered again next time
    }
  },
};

/** Should connecting to this fixture open the new-fixture setup? Only for a
 * fixture with no stored map, never twice for the same device, and never while
 * the user is in the middle of something that owns the screen. */
export function shouldOfferSetup(o: {
  deviceId: string | null;
  hasMap: boolean | null;
  seen: boolean;
  route: string;
}): boolean {
  if (!o.deviceId || o.seen) return false;
  if (o.hasMap !== false) return false; // unknown (old firmware, error) or mapped
  return OFFER_ROUTES.some((r) => o.route === r || o.route.startsWith(`${r}?`));
}

/** Routes where an automatic jump into setup is welcome (home, browsing, setup). */
const OFFER_ROUTES = ["", "/", "/onboard", "/effects", "/maps", "/settings"];

// -- the flow's steps ---------------------------------------------------------

export type SetupStep = "name" | "leds" | "order" | "done";

/** The flow's screens: the name, the LED count of every output (one screen),
 * the colour order of each output that has LEDs (one screen each), then done. */
export function setupSteps(usedPorts: readonly number[]): { step: SetupStep; port: number }[] {
  const out: { step: SetupStep; port: number }[] = [
    { step: "name", port: 0 },
    { step: "leds", port: 0 },
  ];
  const ports = usedPorts.length > 0 ? usedPorts : [0];
  for (const p of ports) out.push({ step: "order", port: p });
  out.push({ step: "done", port: 0 });
  return out;
}
