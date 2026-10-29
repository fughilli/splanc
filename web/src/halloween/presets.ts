/**
 * Halloween play-mode effect presets (the tiles on #/play).
 *
 * SEAM: the play-mode agent owns the TYPE and ships two trivial placeholders;
 * the content agent replaces HALLOWEEN_PRESETS with the real list (see
 * .claude/halloween/CONTRACT.md "Effect presets").
 *
 * Every effect must be parametric (LED counts, curtain size and wiring are not
 * known in advance): use led.pos / led.uv / led.s, never fixed indices. Rate
 * controls integrate in update() (`phase += dt * speed`), never `time * speed`.
 */

export interface HalloweenPreset {
  /** Stable id; also the effect id uploaded to the device (prefixed `boo-`). */
  id: string;
  /** Tile label. */
  name: string;
  /** Tile emoji. */
  emoji: string;
  /** Effect source (fx language). */
  source: string;
  /** Uniform overrides applied after the deploy (name -> value), on top of the
   * source's declared defaults. */
  uniforms: Record<string, number | number[]>;
  /** Up to two uniform names shown as big sliders while this tile is selected. */
  sliders: string[];
  /** The suggested attract (idle) show for the owner. */
  attract?: boolean;
}

export const HALLOWEEN_PRESETS: HalloweenPreset[] = [
  {
    id: "pumpkin-glow",
    name: "Pumpkin glow",
    emoji: "🎃",
    attract: true,
    sliders: ["flicker", "warmth"],
    uniforms: {},
    source: `uniform float flicker : 0.0 .. 1.0 = 0.5;
uniform float warmth : 0.0 .. 1.0 = 0.6;
state float ph;

void update() { ph = ph + dt * (1.0 + flicker * 6.0); }

vec3 shade(Led led) {
  float n = 0.5 + 0.5 * sin(ph * 3.1 + led.pos.x * 7.0) * sin(ph * 1.7 + led.pos.y * 5.0);
  float glow = 1.0 - flicker * 0.7 * n;
  return vec3(1.0, 0.25 + warmth * 0.25, 0.02) * glow;
}
`,
  },
  {
    id: "ghost-drift",
    name: "Ghost drift",
    emoji: "👻",
    sliders: ["speed"],
    uniforms: {},
    source: `uniform float speed : 0.0 .. 2.0 = 0.4;
state float ph;

void update() { ph = fract(ph + dt * speed * 0.25); }

vec3 shade(Led led) {
  float w = 0.5 + 0.5 * sin((led.pos.y + ph) * 12.566);
  return mix(vec3(0.25, 0.0, 0.45), vec3(0.2, 1.0, 0.35), w * w);
}
`,
  },
];

/** The preset the owner most likely wants as the attract show. */
export function attractPreset(list: HalloweenPreset[] = HALLOWEEN_PRESETS): HalloweenPreset | undefined {
  return list.find((p) => p.attract) ?? list[0];
}

/** A friendly name for the device's attract effect id (a preset's tile name
 * when it is one of ours). */
export function attractDisplayName(effectId: string, list: HalloweenPreset[] = HALLOWEEN_PRESETS): string {
  const p = list.find((x) => presetEffectId(x) === effectId || x.id === effectId);
  return p ? `${p.emoji} ${p.name}` : effectId;
}

/** Device effect id for a preset. */
export function presetEffectId(p: Pick<HalloweenPreset, "id">): string {
  return `boo-${p.id}`;
}
