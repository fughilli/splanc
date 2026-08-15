/**
 * Native-wrapper detection (docs/design/ios-support.md §4).
 *
 * The same web bundle ships as the browser PWA and, wrapped by Capacitor, as the
 * iOS/Android app. A handful of capabilities WebKit lacks (Bluetooth today; a
 * cert-pinning WS bridge later) are only available in the native wrapper, so the
 * code branches on "am I running inside Capacitor?".
 *
 * Capacitor's native runtime injects a global `Capacitor` object into the
 * WebView before any app code runs, so this is a synchronous check with ZERO
 * imports — the PWA build pulls in no Capacitor code, and `isNativePlatform()`
 * simply returns false in a normal browser. (Reading the global rather than
 * importing `@capacitor/core` is deliberate: it keeps the plugin out of the web
 * bundle, which loads it lazily only where a native capability is actually used.)
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  // The runtime's registerPlugin (same function @capacitor/core exports). Reading
  // it off the global — rather than `import("@capacitor/core")` — is deliberate:
  // besides keeping the plugin out of the web bundle, a dynamic import of
  // @capacitor/core DEADLOCKS in the WKWebView (its chunk fetch under
  // capacitor://localhost never resolves — this broke both the wss bridge and
  // Acid Mode voice until they stopped dynamically importing it).
  registerPlugin?: <T>(name: string) => T;
}

function cap(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** Bind a native Capacitor plugin proxy by name via the injected global runtime
 * (no @capacitor/core import). Only valid on-native — callers gate on
 * isNativePlatform()/isIosNative() first. */
export function registerNativePlugin<T>(name: string): T {
  const rp = cap()?.registerPlugin;
  if (!rp) throw new Error(`Capacitor.registerPlugin unavailable (plugin ${name})`);
  return rp<T>(name);
}

/** True only inside the Capacitor native wrapper (iOS/Android), never in a
 * plain browser or the installed PWA. */
export function isNativePlatform(): boolean {
  const c = cap();
  return !!c?.isNativePlatform?.();
}

/** "ios" | "android" | "web" — "web" whenever not in the native wrapper. */
export function nativePlatform(): string {
  return cap()?.getPlatform?.() ?? "web";
}

export function isIosNative(): boolean {
  return isNativePlatform() && nativePlatform() === "ios";
}
