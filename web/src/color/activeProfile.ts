/**
 * The colour-correction profile last dialled in for a device (persisted by the
 * Color correction screen; hydrated from the device there). Shared so the
 * colour picker can show what that device's LEDs show (D-541).
 */

import { DEFAULT_PROFILE, cloneProfile, type GammaProfile } from "./correction";
import { deviceStore } from "../store/deviceStore";
import { ledDisplay, type ChannelDisplay } from "./hsv";

/** localStorage key of a device's last-used profile. */
export function profileStoreKey(deviceId: string): string {
  return `cc:profile:${deviceId}`;
}

/** The stored profile for `deviceId`, else the firmware default. */
export function loadProfile(deviceId: string | null): GammaProfile {
  if (deviceId) {
    try {
      const raw = localStorage.getItem(profileStoreKey(deviceId));
      if (raw) {
        const p = JSON.parse(raw) as GammaProfile;
        if (Array.isArray(p.gamma) && Array.isArray(p.luminance)) return cloneProfile(p);
      }
    } catch {
      /* fall through to default */
    }
  }
  return cloneProfile(DEFAULT_PROFILE);
}

export function saveProfile(deviceId: string | null, p: GammaProfile): void {
  if (!deviceId) return;
  try {
    localStorage.setItem(profileStoreKey(deviceId), JSON.stringify(p));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

/** The LED view for the active device's profile (the default with none). */
export function activeLedDisplay(): ChannelDisplay {
  let id: string | null = null;
  try {
    id = deviceStore.activeId();
  } catch {
    id = null;
  }
  return ledDisplay(loadProfile(id));
}
