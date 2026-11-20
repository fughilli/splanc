/**
 * Pure helpers for the out-of-box "see my fixture → pick an effect → tune it"
 * path (docs/ux/oobe-review.md). No DOM; unit-tested in tests/quickPlay.test.ts.
 *
 *   - {@link effectSections}: how the Effects tab groups the library when it
 *     isn't filtered (Starters, then Examples, then the user's own effects).
 *   - {@link starterBlurb}: one plain line per built-in, shown instead of the
 *     seed date (which means nothing to a new user).
 *   - {@link fixtureCard}: the card at the top of the Effects tab that says what
 *     the app is connected to and what to do next.
 *   - {@link friendlyUniformName}: "drift" → "Drift", "base_color" → "Base color".
 */

/** The fields of a stored effect these helpers read. */
export interface EffectLike {
  id: string;
  name: string;
  tags: string[];
}

export interface EffectSection<T> {
  /** Stable id (CSS hook + tests). */
  id: "starters" | "examples" | "mine";
  title: string;
  items: T[];
}

/** Built-in starters in the order a new user should meet them: lively,
 * good-on-anything looks first; tools (the colour test) last. Unknown
 * built-ins sort after these, by name. */
export const STARTER_ORDER: readonly string[] = [
  "builtin-rainbow-sweep",
  "builtin-breathing-pulse",
  "builtin-comet",
  "builtin-trails",
  "builtin-pulse",
  "builtin-agentic-pulse",
  "builtin-flood",
  "builtin-texture-map",
  "builtin-color-test",
];

const BLURBS: Record<string, string> = {
  "builtin-rainbow-sweep": "A slow rainbow drifting through the lights",
  "builtin-breathing-pulse": "One colour gently fading in and out",
  "builtin-comet": "A bright comet racing along the strip",
  "builtin-trails": "Sparks that leave fading trails",
  "builtin-pulse": "Pulses travelling outward along the strip",
  "builtin-agentic-pulse": "Little chasers wandering the strip",
  "builtin-flood": "Colour flooding out from one point",
  "builtin-texture-map": "A soft gradient image laid over the lights",
  "builtin-color-test": "A test gradient for checking colour and order",
};

export function isStarter(e: Pick<EffectLike, "id">): boolean {
  return e.id.startsWith("builtin-");
}

/** Seeded showcase scenes (made for the sample maps), not the user's work. */
export function isExample(e: EffectLike): boolean {
  return !isStarter(e) && e.tags.includes("demo");
}

/** One plain-language line for a built-in, or null for anything else. */
export function starterBlurb(id: string): string | null {
  return BLURBS[id] ?? null;
}

function starterRank(id: string): number {
  const i = STARTER_ORDER.indexOf(id);
  return i === -1 ? STARTER_ORDER.length : i;
}

/** Group an (already sorted) unfiltered library. Starters keep the curated
 * order; examples and the user's own keep the caller's order. Empty sections
 * are dropped. */
export function effectSections<T extends EffectLike>(all: T[]): EffectSection<T>[] {
  const starters = all
    .filter(isStarter)
    .sort((a, b) => starterRank(a.id) - starterRank(b.id) || a.name.localeCompare(b.name));
  const examples = all.filter(isExample);
  const mine = all.filter((e) => !isStarter(e) && !isExample(e));
  const out: EffectSection<T>[] = [
    { id: "mine", title: "Your effects", items: mine },
    { id: "starters", title: "Starters", items: starters },
    { id: "examples", title: "Examples for the sample maps", items: examples },
  ];
  // A brand-new user has no effects of their own: Starters lead. Someone who
  // has made effects sees theirs first.
  if (mine.length === 0) out.push(out.shift()!);
  return out.filter((s) => s.items.length > 0);
}

/** Tags worth a filter chip: only the ones on the user's own effects (the
 * seeded #starter / #demo / #test / #topology tags are what the sections
 * already show, and read as developer jargon on a first run). */
export function userTags(all: EffectLike[]): string[] {
  const tags = new Set<string>();
  for (const e of all) if (!isStarter(e) && !isExample(e)) for (const t of e.tags) tags.add(t);
  return [...tags].sort();
}

// -- the fixture card -------------------------------------------------------

export type ConnState = "connected" | "connecting" | "offline" | "error";

export interface FixtureCardInput {
  /** The shared connection state (appState.status.state). */
  state: ConnState;
  /** The active device's display name, if any device is known. */
  deviceName: string | null;
  /** The name of the library effect playing on it, when known. */
  playing: string | null;
}

export interface FixtureCardModel {
  kind: "none" | "connecting" | "unreachable" | "connected";
  title: string;
  body: string;
  /** The card's one action, or null (connected: tap an effect instead). */
  action: { label: string; target: "devices" } | null;
}

/** What the top-of-Effects card says. One action at most. */
export function fixtureCard(i: FixtureCardInput): FixtureCardModel {
  const name = i.deviceName?.trim() || "";
  if (i.state === "connected") {
    return {
      kind: "connected",
      title: name || "Your fixture",
      body: i.playing ? `Playing ${i.playing}. Tap an effect to switch.` : "Tap an effect to play it on the lights.",
      action: null,
    };
  }
  if (!name) {
    return {
      kind: "none",
      title: "Connect your lights",
      body: "Connect a fixture to play these effects on it. You can browse them first.",
      action: { label: "Connect a fixture", target: "devices" },
    };
  }
  if (i.state === "connecting") {
    return {
      kind: "connecting",
      title: `Connecting to ${name}…`,
      body: "Your phone needs to be on the same Wi-Fi as the fixture.",
      action: null,
    };
  }
  return {
    kind: "unreachable",
    title: `Can't reach ${name}`,
    body:
      "Check it's plugged in and your phone is on the same Wi-Fi. " +
      "Moved it to a different Wi-Fi? Set it up again over Bluetooth. No need to flash it again.",
    action: { label: "Open devices", target: "devices" },
  };
}

// -- uniform labels -----------------------------------------------------------

/** A readable label for a uniform name: "drift" → "Drift", "base_color" →
 * "Base color", "glowWidth" → "Glow width". */
export function friendlyUniformName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
