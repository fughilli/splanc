/**
 * Kiosk mode (the firmware "kiosk" feature; .claude/halloween/CONTRACT.md): a
 * public install where visitors may play (effects, uniforms, brightness) but
 * the device returns to its owner-chosen "attract" show after `idleTimeoutS`
 * without visitor activity. The app shows the countdown so a revert is never a
 * surprise.
 *
 * Pure (no DOM): the wire <-> app conversion, the local countdown clock, revert
 * detection and the wording — unit-tested in tests/kiosk.test.ts. The clock
 * counts down locally from the device's `idle_remaining_s` and re-syncs on every
 * KioskStatus the device sends (welcome, get reply, unsolicited push).
 */

/** Default idle timeout (s) — the owner's decision. */
export const KIOSK_DEFAULT_IDLE_S = 120;

/** The device's kiosk state (proto KioskStatus), normalized. */
export interface KioskStatus {
  enabled: boolean;
  idleTimeoutS: number;
  /** Seconds left before the idle revert, as of when the device sent it. */
  idleRemainingS: number;
  /** The attract show's effect name ("" = none captured yet). */
  attractName: string;
  /** The attract show's default brightness 0..1 (NaN-free; 0 when unknown). */
  attractBrightness: number;
  /** This connection has unlocked the owner controls. */
  ownerUnlocked: boolean;
  /** The device is showing the attract snapshot right now (no visitor change since the revert). */
  attractActive: boolean;
  /** An attract snapshot is stored. */
  hasAttract: boolean;
  /** An owner secret is stored on the device. */
  hasSecret: boolean;
  /** Why the device sent this status. */
  event: KioskEvent;
}

/** proto KioskEvent: a plain reply, an idle revert, the first visitor activity
 * after a revert (timer started), or a config change. */
export type KioskEvent = "none" | "reverted" | "activity" | "config";

export function kioskEventFromWire(v: unknown): KioskEvent {
  if (typeof v === "number") return (["none", "reverted", "activity", "config"] as const)[v] ?? "none";
  if (typeof v === "string") {
    const e = v.replace(/^KIOSK_EVENT_/, "").toLowerCase();
    if (e === "reverted" || e === "activity" || e === "config") return e;
  }
  return "none";
}

/** An owner's set_kiosk_config request (proto SetKioskConfig without `type`). */
export interface KioskConfigRequest {
  enabled: boolean;
  idleTimeoutS: number;
  /** Capture deck A's effect + uniforms + brightness as the persisted attract show. */
  captureAttractFromCurrent: boolean;
  /** The owner secret (1..32 bytes). */
  ownerSecret: string;
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : dflt;
}
function pick(r: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return undefined;
}

/**
 * Wire (proto3 JSON, camel or snake) -> app shape. Tolerant on purpose: the
 * attract info may be nested (`attract: {name, brightness}`) or flat, and proto3
 * drops zero/false fields. Returns null for a non-object.
 */
export function normalizeKioskStatus(raw: unknown): KioskStatus | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const attract = (pick(r, "attract") ?? {}) as Record<string, unknown>;
  const timeout = num(pick(r, "idleTimeoutS", "idle_timeout_s"), 0);
  return {
    enabled: pick(r, "enabled") === true,
    idleTimeoutS: timeout > 0 ? timeout : KIOSK_DEFAULT_IDLE_S,
    idleRemainingS: Math.max(0, num(pick(r, "idleRemainingS", "idle_remaining_s"), 0)),
    attractName: String(
      pick(attract, "name", "effectName", "effect_name", "effectId", "effect_id") ??
        pick(r, "attractName", "attract_name", "attractEffect", "attract_effect") ??
        "",
    ),
    attractBrightness: Math.min(
      1,
      Math.max(
        0,
        num(
          pick(attract, "brightness", "defaultBrightness", "default_brightness") ??
            pick(r, "attractBrightness", "attract_brightness"),
          0,
        ),
      ),
    ),
    ownerUnlocked: pick(r, "ownerUnlocked", "owner_unlocked") === true,
    attractActive: pick(r, "attractActive", "attract_active") === true,
    hasAttract: pick(r, "hasAttract", "has_attract") === true,
    hasSecret: pick(r, "hasSecret", "has_secret") === true,
    event: kioskEventFromWire(pick(r, "event")),
  };
}

/** The KioskStatus inside a welcome, if the firmware embeds one. */
export function kioskFromWelcome(w: unknown): KioskStatus | null {
  if (w === null || typeof w !== "object") return null;
  const r = w as Record<string, unknown>;
  return normalizeKioskStatus(pick(r, "kiosk", "kioskStatus", "kiosk_status"));
}

/** Does the device advertise kiosk mode (welcome feature "kiosk")? */
export function deviceHasKiosk(w: { features?: string[] } | null | undefined): boolean {
  return (w?.features ?? []).includes("kiosk");
}

/** The set_kiosk_config fields (camel proto3 JSON) for client.setKioskConfig. */
export function kioskConfigFields(req: KioskConfigRequest): KioskConfigRequest {
  return {
    enabled: req.enabled,
    idleTimeoutS: Math.max(10, Math.round(req.idleTimeoutS)),
    captureAttractFromCurrent: req.captureAttractFromCurrent,
    ownerSecret: req.ownerSecret,
  };
}

/** "1:42", "0:07", "12:00". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** The visitor-facing line for a status + the local clock. */
export function countdownLine(seconds: number, s?: Pick<KioskStatus, "attractActive" | "ownerUnlocked"> | null): string {
  if (s?.ownerUnlocked) return "Owner unlocked — the idle timer is paused";
  if (s?.attractActive) return "The show is on — tap an effect to play";
  if (seconds <= 0) return "Back to the show any second now";
  return `Back to the show in ${formatCountdown(seconds)} if you stop playing`;
}

/** Is a countdown actually ticking (vs. the show playing / owner unlocked)? */
export function countdownTicking(s: KioskStatus | null): boolean {
  return !!s && s.enabled && !s.attractActive && !s.ownerUnlocked;
}

/** Was this status a revert to the attract show? The device says so (event
 * REVERTED); a plain reply that shows the attract show newly on (we missed the
 * push, e.g. over a reconnect) counts too. */
export function isRevert(prev: KioskStatus | null, next: KioskStatus): boolean {
  if (!next.enabled) return false;
  if (next.event === "reverted") return true;
  return next.event === "none" && prev !== null && prev.enabled && !prev.attractActive && next.attractActive;
}

/**
 * Local countdown, re-synced from each device status. `now` is injectable (ms)
 * for tests. Local visitor activity (deploy, uniforms, brightness) restarts the
 * timer optimistically — the device resets its own on receipt, and may not push.
 */
export class KioskClock {
  private status_: KioskStatus | null = null;
  private syncedAtMs = 0;
  private remainingAtSync = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get status(): KioskStatus | null {
    return this.status_;
  }

  /** Apply a device status; returns true when it was a revert. */
  sync(next: KioskStatus): boolean {
    const reverted = isRevert(this.status_, next);
    this.status_ = next;
    this.syncedAtMs = this.now();
    this.remainingAtSync = next.idleRemainingS;
    return reverted;
  }

  /** Visitor activity sent from this app: the device restarts its idle timer. */
  noteActivity(): void {
    if (!this.status_?.enabled || this.status_.ownerUnlocked) return;
    this.status_ = { ...this.status_, attractActive: false };
    this.syncedAtMs = this.now();
    this.remainingAtSync = this.status_.idleTimeoutS;
  }

  /** Seconds left (0 when disabled/unknown, run out, showing the attract show,
   * or paused by an owner unlock). */
  remaining(): number {
    if (!countdownTicking(this.status_)) return 0;
    return Math.max(0, this.remainingAtSync - (this.now() - this.syncedAtMs) / 1000);
  }

  clear(): void {
    this.status_ = null;
  }
}
