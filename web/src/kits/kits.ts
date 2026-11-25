/**
 * Shipped lamp kits: the known hardware config the kit onboarding applies
 * (route /kit/:id, reached from the QR code in the kit's booklet). One entry
 * per kit; the booklet QR encodes kitUrl(id).
 */

import { TOUCH_MODE_MOMENTARY, type TouchDriverConfig } from "../power/touchDriver";
import { POWER_STYLE_FADE } from "../net/proto";

export interface KitDef {
  id: string;
  /** Shown in the onboarding. */
  name: string;
  /** One line under the headline. */
  blurb: string;
  /** The touch module under the lid. */
  touch: Required<TouchDriverConfig>;
  /** Default ON / OFF transitions. */
  onTransition: { style: number; durationMs: number };
  offTransition: { style: number; durationMs: number };
  /** The booklet's wording for the test step. */
  tapHint: string;
}

/** The booklet QR's format version (?v=); bump when a kit's flow changes. */
export const KIT_LINK_VERSION = 1;
/** Where the hosted app lives (hash routes: the QR stays valid across releases). */
export const APP_BASE = "https://splanc.io/app/";

export const KITS: Record<string, KitDef> = {
  coil: {
    id: "coil",
    name: "COIL lamp",
    blurb: "Connect your COIL lamp and set up its touch-to-toggle lid.",
    touch: { gpio: 3, activeLow: false, mode: TOUCH_MODE_MOMENTARY, exportName: "touch_tap" },
    onTransition: { style: POWER_STYLE_FADE, durationMs: 700 },
    offTransition: { style: POWER_STYLE_FADE, durationMs: 900 },
    tapHint: "Tap the top of the lid once. The lamp should turn off; tap again to turn it back on.",
  },
};

export function kitById(id: string | undefined): KitDef | null {
  return id && Object.prototype.hasOwnProperty.call(KITS, id) ? KITS[id]! : null;
}

/** The booklet deep link for a kit, e.g. https://splanc.io/app/#/kit/coil?v=1 */
export function kitUrl(id: string, base = APP_BASE): string {
  return `${base}#/kit/${encodeURIComponent(id)}?v=${KIT_LINK_VERSION}`;
}
