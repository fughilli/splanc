/**
 * Authoring test cases. Each is a single-turn "author an effect from scratch"
 * ask — the exact shape the user hits in the effect editor. `rubric` is the
 * success criteria the judge model scores against; keep it concrete and behaviour-
 * focused (what the PROGRAM must do), not implementation-prescriptive.
 */

export interface EvalTask {
  id: string;
  /** The user's ask, verbatim as it would be typed into the editor chat. */
  ask: string;
  /** What a correct program must accomplish — the judge scores against this. */
  rubric: string;
}

export const TASKS: EvalTask[] = [
  {
    id: "pinwheel",
    ask: "Make a colorful pinwheel: several spokes of color radiating from the center of the map that rotate around it over time.",
    rubric:
      "Uses the LED's position relative to the map center to compute an ANGLE (e.g. atan2 on led.uv/led.pos centered at 0.5,0.5), maps angle to color/hue so there are multiple distinct colored spokes, and rotates the pattern over time (angle offset advanced by `time`). Should be visibly colorful and spinning, not a flat or purely radial gradient.",
  },
  {
    id: "breathing-red",
    ask: "Make a red light that smoothly breathes — getting brighter and dimmer over and over.",
    rubric:
      "Output is red (dominant R channel), with overall brightness oscillating smoothly and periodically over time (e.g. a sin of `time`), no hard fl. The whole map breathes together.",
  },
  {
    id: "rainbow-sweep",
    ask: "Make a rainbow that sweeps along the strip.",
    rubric:
      "Hue varies across the LEDs by position (led.s / led.pos / led.dist) AND shifts over time so the rainbow appears to move. Full saturated spectrum, not a two-color blend.",
  },
  {
    id: "comet",
    ask: "Make a bright comet that travels along the strip and leaves a fading tail behind it.",
    rubric:
      "A localized bright head whose position advances with time along the strip (led.s/led.pos), with intensity falling off behind it to form a tail (exponential/linear decay). Not the whole strip lighting uniformly.",
  },
  {
    id: "fire",
    ask: "Make a warm flickering fire effect.",
    rubric:
      "Warm palette (reds/oranges/yellows, low blue), with per-LED brightness/color varying over time to look like flicker (uses hash/noise and time). Not a static warm wash.",
  },
  {
    id: "twinkle",
    ask: "Make random white stars twinkling on a dark background.",
    rubric:
      "Mostly dark; a sparse subset of LEDs light up brightish/whiteish and their brightness varies over time so they twinkle (per-LED phase via hash of index). Not all LEDs lit, not a solid color.",
  },
  {
    id: "color-wipe",
    ask: "Wipe a single color across all the LEDs from one end to the other, then start over.",
    rubric:
      "A moving boundary (position advancing with time, wrapping via fract/mod) such that LEDs behind the front are the chosen color and ahead are off (or vice-versa), repeating. Uses led.s/led.pos vs a time-driven threshold.",
  },
  {
    id: "two-tone-gradient",
    ask: "Make a smooth gradient between blue and pink across the whole map that slowly drifts.",
    rubric:
      "Interpolates (mix) between a blue and a pink color by a spatial coordinate (led.pos/led.uv/led.s), with the blend position drifting over time. Smooth, both colors clearly present.",
  },
];
