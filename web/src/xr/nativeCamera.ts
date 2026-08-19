/**
 * Binding for the native iOS capture session (docs/design/ios-support.md §4.7).
 *
 * iOS can only control camera exposure on a session THIS app owns — WebKit's
 * getUserMedia camera lives in the WebKit GPU process and is unreachable from
 * here (§4.6 has the measurements that killed the previous approach). So on iOS
 * the mapping capture path moves to `@splanc/camera-bridge`, which runs its own
 * AVCaptureSession and draws a preview layer behind the WebView.
 *
 * This is phase 1+2: session, preview and exposure. Frames don't reach the
 * detector yet — that's the threshold/downsample + sparse-transport stage.
 * IMPORTANT: while this session is running, nothing may call getUserMedia; the
 * two capture clients can't share the camera.
 *
 * Bound through the injected Capacitor global (registerNativePlugin, no
 * @capacitor/core import), so the browser PWA bundle pulls in none of this.
 */

import { isIosNative, registerNativePlugin } from "../net/native";

/** Sensor/session facts reported once the session is running. */
export interface NativeCameraInfo {
  width: number;
  height: number;
  minExposureMs: number;
  maxExposureMs: number;
  minIso: number;
  maxIso: number;
  customExposureSupported: boolean;
  running: boolean;
}

/** What the sensor actually did — `applied` comes from reading the device back,
 * not from the request having been accepted. */
export interface NativeExposureResult {
  applied: boolean;
  description: string;
  exposureMs: number;
  iso: number;
}

interface CameraBridgePlugin {
  start(): Promise<NativeCameraInfo>;
  stop(): Promise<void>;
  /** Lock exposure to `target` in [0,1] (0 = shortest/darkest → 1 = longest),
   * pinning ISO to the sensor minimum. `maxExposureMs` caps the longest. */
  setExposure(opts: { target: number; maxExposureMs?: number }): Promise<NativeExposureResult>;
  clearExposure(): Promise<void>;
}

// Bound lazily + cached via the injected Capacitor global (registerPlugin returns
// a proxy that only dispatches to native on a real call, so this is cheap).
let bridge: CameraBridgePlugin | null = null;

/** True only in the iOS native wrapper, where the capture session exists. */
export function nativeCameraAvailable(): boolean {
  return isIosNative();
}

/** The plugin proxy. Only valid on iOS native — gate on nativeCameraAvailable(). */
export function nativeCamera(): CameraBridgePlugin {
  if (!bridge) bridge = registerNativePlugin<CameraBridgePlugin>("CameraBridge");
  return bridge;
}
