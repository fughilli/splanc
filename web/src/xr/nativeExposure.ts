/**
 * Native camera-exposure control for the getUserMedia capture path on iOS
 * (docs/design/ios-support.md §4.6).
 *
 * WebKit doesn't implement the MediaStream Image-Capture exposure extensions, so
 * on iOS `MediaStreamTrack.getCapabilities()` reports no exposure controls and
 * `applyConstraints` can't touch exposure — the slider and the servo are no-ops
 * and the camera stays on auto-exposure (which blows the LEDs out, exactly what
 * exposureControl.ts locks exposure down to prevent). The `@splanc/exposure-bridge`
 * Capacitor plugin configures the shared back-camera `AVCaptureDevice` directly
 * (setExposureModeCustom), which applies to the frames the WKWebView is already
 * rendering. This module adapts that plugin to `MediaStreamCaptureSource`.
 *
 * Bound through the injected Capacitor global (registerNativePlugin, no
 * @capacitor/core import), so the browser PWA bundle pulls in none of this;
 * `nativeExposureAvailable()` is false off-iOS and the caller keeps the web
 * applyConstraints path.
 */

import { isIosNative, registerNativePlugin } from "../net/native";

interface ExposureBridgePlugin {
  /** Sensor exposure/ISO ranges for the back camera; `supported` is false when
   * the device has no custom-exposure control. */
  capabilities(): Promise<{
    supported: boolean;
    minExposureMs?: number;
    maxExposureMs?: number;
    minIso?: number;
    maxIso?: number;
    reason?: string;
  }>;
  /** Lock exposure to `target` in [0,1] (0 = shortest/darkest → 1 = longest),
   * pinning ISO to the sensor minimum. `maxExposureMs` caps the longest exposure
   * (the caller's Nyquist / manual ceiling). */
  setExposure(opts: { target: number; maxExposureMs?: number }): Promise<{
    applied: boolean;
    description: string;
    exposureMs?: number;
    iso?: number;
  }>;
  /** Hand the camera back to continuous auto-exposure. */
  clearExposure(): Promise<void>;
}

// Bind lazily + cached via the injected Capacitor global (registerPlugin returns
// a proxy that only dispatches to native on a real call, so this is cheap).
// Reached only on iOS native — callers gate on nativeExposureAvailable().
let bridge: ExposureBridgePlugin | null = null;
function exposureBridge(): ExposureBridgePlugin {
  if (!bridge) bridge = registerNativePlugin<ExposureBridgePlugin>("ExposureBridge");
  return bridge;
}

/** True only in the iOS native wrapper, where the native exposure bridge exists.
 * (Whether the specific device supports custom exposure is reported per-call by
 * setExposure().applied.) */
export function nativeExposureAvailable(): boolean {
  return isIosNative();
}

/** Lock exposure via the native bridge. Returns a human-readable description of
 * what was applied, or null when the native bridge couldn't set it (so the caller
 * can fall back / record the miss). Never throws. */
export async function setNativeExposure(
  target01: number,
  maxExposureMs?: number,
): Promise<string | null> {
  try {
    const res = await exposureBridge().setExposure(
      maxExposureMs === undefined ? { target: target01 } : { target: target01, maxExposureMs },
    );
    return res.applied ? res.description : null;
  } catch (e) {
    console.warn("[exposure] native setExposure failed:", e);
    return null;
  }
}

/** Restore continuous auto-exposure. Best effort; never throws. */
export async function clearNativeExposure(): Promise<void> {
  try {
    await exposureBridge().clearExposure();
  } catch (e) {
    console.warn("[exposure] native clearExposure failed:", e);
  }
}
