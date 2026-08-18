/**
 * Interactive-tutorial state (FUG-103), persisted across reloads.
 *
 * Records whether the user has dismissed the first-run tutorial hint (so it
 * NEVER nags again once dismissed), which topic tours they've completed, and
 * whether the one-time welcome hint has been shown. The pure serialization
 * helpers are DOM-free so they unit-test under plain Node (tests/tour.test.ts);
 * only {@link loadTourState}/{@link saveTourState} touch `localStorage`, guarded
 * so the module imports cleanly in a non-DOM context.
 */

const STORAGE_KEY = "ledmapper.tour";

export interface TourState {
  /** The user explicitly skipped/finished the tour. Once true, the first-run
   * hint is never auto-shown again — the tutorial is only reachable on demand
   * from Settings. */
  dismissed: boolean;
  /** The one-time first-run hint has been surfaced (so we don't re-pop it every
   * launch even before the user interacts with it). */
  hintSeen: boolean;
  /** Ids of topic tours the user ran to completion (reserved for future
   * per-topic "seen" affordances; the full tour sets none in particular). */
  completed: string[];
}

export const DEFAULT_TOUR_STATE: TourState = {
  dismissed: false,
  hintSeen: false,
  completed: [],
};

/** Parse a persisted blob into a fully-populated {@link TourState}, tolerating
 * missing/legacy fields and malformed JSON (returns defaults). Pure. */
export function deserializeTourState(raw: string | null): TourState {
  if (!raw) return { ...DEFAULT_TOUR_STATE };
  try {
    const o = JSON.parse(raw) as Partial<TourState> | null;
    if (!o || typeof o !== "object") return { ...DEFAULT_TOUR_STATE };
    return {
      dismissed: Boolean(o.dismissed),
      hintSeen: Boolean(o.hintSeen),
      completed: Array.isArray(o.completed) ? o.completed.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return { ...DEFAULT_TOUR_STATE };
  }
}

/** Serialize to the canonical stored form. Pure. */
export function serializeTourState(s: TourState): string {
  return JSON.stringify({
    dismissed: s.dismissed,
    hintSeen: s.hintSeen,
    completed: s.completed,
  });
}

/** Should the first-run hint auto-appear? Only when the user has neither
 * dismissed the tutorial nor already been shown the hint. Pure. */
export function shouldShowHint(s: TourState): boolean {
  return !s.dismissed && !s.hintSeen;
}

function hasStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadTourState(): TourState {
  if (!hasStorage()) return { ...DEFAULT_TOUR_STATE };
  try {
    return deserializeTourState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_TOUR_STATE };
  }
}

export function saveTourState(s: TourState): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, serializeTourState(s));
  } catch {
    /* storage full / disabled — the tutorial just won't remember, which is fine. */
  }
}

/** Merge a patch into the persisted state and return the new value. */
export function updateTourState(patch: Partial<TourState>): TourState {
  const next = { ...loadTourState(), ...patch };
  saveTourState(next);
  return next;
}

/** Mark the tutorial dismissed — the user is done and won't be prompted again. */
export function dismissTour(): void {
  updateTourState({ dismissed: true, hintSeen: true });
}

/** Record that a topic tour ran to completion (idempotent). */
export function markCompleted(id: string): void {
  const s = loadTourState();
  if (!s.completed.includes(id)) {
    updateTourState({ completed: [...s.completed, id] });
  }
}

/** Reset the tutorial so the first-run hint can appear again (Settings action). */
export function resetTour(): void {
  saveTourState({ ...DEFAULT_TOUR_STATE });
}
