/**
 * The kiosk owner secret, generated and kept on the OWNER's phone (localStorage),
 * keyed by the device's MAC. The device stores it via set_kiosk_config and
 * answers kiosk_unlock{secret} with owner rights for that connection.
 */

const KEY = "splanc.kioskSecrets.v1";

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function save(all: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage blocked: the secret lives only as long as the page
  }
}

/** 128-bit random secret, hex. */
export function generateKioskSecret(rand: (n: number) => Uint8Array = defaultRandom): string {
  return Array.from(rand(16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function norm(mac: string): string {
  return mac.trim().toUpperCase();
}

export function kioskSecretFor(mac: string): string | undefined {
  return mac ? load()[norm(mac)] : undefined;
}

/** The stored secret for `mac`, generating + storing one if absent. */
export function ensureKioskSecret(mac: string): string {
  const all = load();
  const k = norm(mac);
  const have = all[k];
  if (have) return have;
  const s = generateKioskSecret();
  all[k] = s;
  save(all);
  return s;
}

export function setKioskSecret(mac: string, secret: string): void {
  const all = load();
  all[norm(mac)] = secret;
  save(all);
}
