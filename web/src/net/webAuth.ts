/**
 * The iOS app's system sign-in sheet (ASWebAuthenticationSession), via the
 * first-party Capacitor plugin @splanc/web-auth (native-plugins/web-auth). Used
 * for the free tier's one-tap "Connect OpenRouter" (docs/design/ai-tiers.md).
 * Bound through the injected Capacitor global (no @capacitor/core import), like
 * the other first-party bridges.
 */

import { isIosNative, registerNativePlugin } from "./native";

interface WebAuthPlugin {
  start(opts: { url: string; callbackScheme: string }): Promise<{ url: string }>;
}

/** True inside an iOS app build that contains the WebAuth plugin. */
export function webAuthAvailable(): boolean {
  if (!isIosNative()) return false;
  const cap = (globalThis as { Capacitor?: { isPluginAvailable?: (name: string) => boolean } }).Capacitor;
  return cap?.isPluginAvailable?.("WebAuth") === true;
}

/** Thrown when the user closes the sign-in sheet (not an error to report). */
export class WebAuthCancelled extends Error {
  constructor() {
    super("Sign-in cancelled.");
    this.name = "WebAuthCancelled";
  }
}

/** Open `url` in the sign-in sheet; resolves with the `callbackScheme://…` URL
 * the flow ended on. */
export async function startWebAuth(url: string, callbackScheme: string): Promise<string> {
  // Bound per call (cheap): one sign-in at a time, and no stale proxy.
  const plugin = registerNativePlugin<WebAuthPlugin>("WebAuth");
  try {
    const r = await plugin.start({ url, callbackScheme });
    return r.url;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "canceled") throw new WebAuthCancelled();
    throw e instanceof Error ? e : new Error(String(e));
  }
}
