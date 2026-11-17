/**
 * Auto-push policy for the effect editor and Acid Mode (pure; no DOM).
 *
 * Auto-push is a key feature of Splanc: what you (or the AI) write plays on the
 * lights. So it defaults ON — for new installs and for everyone who never
 * touched the toggle (they never stored a value) — and is off only when the
 * user explicitly turned it off ("0").
 *
 * A compile that landed while no device was connected is not lost: when a device
 * connects (or the session becomes ready) later, the compiled-but-unpushed
 * program is pushed then ({@link shouldPushOnConnect}). Dedupe is per device, so
 * a reconnect of the device that already has the program doesn't re-flash it,
 * while a different device does get it.
 */

/** localStorage key of the editor's "Auto-push on compile" toggle. */
export const AUTOPUSH_KEY = "fxedit.autopush.v1";

/** The stored auto-push choice: on unless explicitly "0" (unset / unreadable = on). */
export function readAutoPush(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(AUTOPUSH_KEY) !== "0";
  } catch {
    return true; // storage blocked: the default
  }
}

/** Persist the toggle ("1" / "0"). Non-fatal when storage is blocked. */
export function writeAutoPush(storage: Pick<Storage, "setItem"> | null | undefined, on: boolean): void {
  try {
    storage?.setItem(AUTOPUSH_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked — non-fatal */
  }
}

/** Byte-for-byte equality of two (possibly null) buffers. */
export function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What was last pushed, and where. */
export interface PushedRecord {
  fxb: Uint8Array | null;
  /** Device id it was pushed to (deviceStore.activeId()); null = unknown. */
  device: string | null;
}

/** Whether `compiled` still has to reach `device`: it differs from what was last
 * pushed, or was pushed to a different device. */
export function needsPush(compiled: Uint8Array | null, pushed: PushedRecord, device: string | null): boolean {
  if (compiled === null) return false;
  return !bytesEqual(compiled, pushed.fxb) || pushed.device !== device;
}

/** On a connection change: push the compiled program now? True on the transition
 * to connected, with auto-push on, when a compiled program has not reached this
 * device yet — unless it is an AI draft auto-push held back for being over the
 * frame budget (`held`, #443: it waits for the user's "push anyway"). A draft
 * from a still-running agent turn is checked again by the caller's push path
 * (holdAgentAutoPush), as for any auto-push. */
export function shouldPushOnConnect(s: {
  autoPush: boolean;
  connected: boolean;
  wasConnected: boolean;
  compiled: Uint8Array | null;
  pushed: PushedRecord;
  device: string | null;
  /** The compiled program is a held over-budget AI draft. */
  held?: boolean;
}): boolean {
  return s.autoPush && s.connected && !s.wasConnected && s.held !== true && needsPush(s.compiled, s.pushed, s.device);
}

/** What happened to a set_script's program on the fixture — told to the AI
 * verbatim, so it can't claim an effect is live when nothing was sent. */
export type PushOutcome =
  | { kind: "sent"; device?: string }
  /** The fixture already runs this exact program. */
  | { kind: "already" }
  | { kind: "not_connected"; autoPush: boolean }
  | { kind: "autopush_off" }
  /** An over-budget AI draft held back (only on a calibrated estimate or a measurement). */
  | { kind: "held"; detail: string }
  | { kind: "failed"; error: string };

/** The set_script result's device line: starts "SENT" or "NOT SENT". */
export function pushOutcomeNote(o: PushOutcome): string {
  const notLive = "Nothing new is playing on the lights: do NOT say it is live, pushed, sent or playing.";
  switch (o.kind) {
    case "sent":
      return `SENT: uploaded and now playing on ${o.device ? o.device : "the fixture"}.`;
    case "already":
      return "SENT: the fixture already runs this exact program.";
    case "not_connected":
      return (
        `NOT SENT: no fixture is connected. ${notLive} Say it's ready in the preview` +
        (o.autoPush ? " and will be sent automatically as soon as a fixture connects." : "; the user can tap Push once a fixture connects.")
      );
    case "autopush_off":
      return `NOT SENT: auto-push is off. ${notLive} Tell the user to tap Push (or turn auto-push on) to send it.`;
    case "held":
      return `NOT SENT: ${o.detail} ${notLive}`;
    case "failed":
      return `NOT SENT: the upload failed (${o.error}). ${notLive}`;
  }
}

/** estimate_performance's answer when no cost model is calibrated for the board:
 * the offline estimate is noise until then, so no numbers reach the AI. The
 * fixture's measurement is the gold standard. */
export function uncalibratedEstimateToolResult(fixtureMeasurable: boolean): string {
  return (
    "No estimate: this board's cost model is UNCALIBRATED, so the offline simulator's numbers are noise and are not reported. " +
    "They must not influence anything — never hold back, delay, or refuse to send an effect, and never call it too slow, because of an estimate. " +
    (fixtureMeasurable
      ? "For any performance question use measure_on_device: the connected fixture's measurement is the gold standard."
      : "No fixture is connected to measure on; if performance comes up, say it can't be judged until a fixture is connected (measure_on_device).")
  );
}
