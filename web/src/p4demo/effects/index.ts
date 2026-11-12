/**
 * The effect sources the P4 demo page deploys, copied from the desktop demo
 * (indoor_localization lighthouse/demos/splanc/effects/). All of them take the lamp's
 * pose from the uniform pool (`pose`, `tracker_ok`: the P4 tracker module).
 *
 *   tracker_demo_pose.glsl  the whole demo in one effect: /pick (LED, -1 shape, -2
 *                           outline), /shape (0 plane, 1 sphere), /plane, /sphere,
 *                           /width, /halo, /glow (world frame)
 *   hot_spots_pose.glsl     the hot-and-cold game: spot0..3, color0..3, range, radius
 *   plane_slice_pose.glsl, sphere_shell_pose.glsl, flashlight_pose.glsl: kept with them
 *                           for reference / later modes; the page doesn't deploy them yet.
 */

import trackerDemo from "./tracker_demo_pose.glsl?raw";
import hotSpots from "./hot_spots_pose.glsl?raw";
import type { EffectKey } from "../demo";

export const EFFECT_SOURCES: Record<EffectKey, string> = {
  tracker_demo: trackerDemo,
  hot_spots: hotSpots,
};
