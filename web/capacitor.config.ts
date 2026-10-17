/**
 * Capacitor config — the iOS (and later Android) native wrapper for Splanc
 * (docs/design/ios-support.md §4). Capacitor loads the EXISTING Vite/TS bundle
 * (`web/dist`) in a WKWebView, so the canvas/WebGL2 capture pipeline, VIO
 * solver, effects VM and every screen run unchanged — the native side is just
 * two small capabilities (BLE Improv provisioning, and later a cert-pinning WS
 * bridge) behind seams the web code already has.
 *
 * The generated native project lives in `web/ios/` (produced on the macOS host
 * by `cap add ios` — see tools/ios_build_server.py / `tools/iosctl bootstrap`);
 * it's gitignored except for the pieces we hand-edit (Info.plist usage strings).
 *
 * `webDir` is relative to this file (the web/ package root), so `cap sync` copies
 * `web/dist` — the same bundle the PWA ships — into the app.
 */
import type { CapacitorConfig } from "@capacitor/cli";

// Phone-in-the-loop HITL driver seam. A native WKWebView loads the BUNDLED web/dist
// at capacitor://localhost/ with no query string, so the app-driver seam
// (`?driver=…&ble=real`, web/src/ui/app/main.ts) can't be reached the way the
// browser/emulator lanes reach it. When the HITL station bakes CAP_SERVER_URL (via
// tools/ios_build_server.py's `server_url` param on cap-sync), point Capacitor's
// `server.url` at the station-served app URL — which carries that query — so the
// WKWebView loads it over the LAN and enters driver mode. Native BLE still bridges
// through the Capacitor Improv plugin. Unset for a normal build → loads the bundle.
const capServerUrl = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: "dev.splanc.app",
  appName: "Splanc",
  webDir: "dist",
  ...(capServerUrl
    ? { server: { url: capServerUrl, cleartext: true } }
    : {}),
  ios: {
    // Let the WebGL/`<video>` content draw under the status bar / home indicator;
    // the web app already handles safe-area insets (viewport-fit=cover in
    // index.html), so mirror the PWA's edge-to-edge layout in the wrapper.
    contentInset: "never",
    // The device serves wss:// with a self-signed cert on the LAN. Until the
    // native cert-pinning bridge lands (§4.3), allow the WKWebView to reach it;
    // the socket itself is opened from JS (net/client.ts).
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    // @capacitor-community/bluetooth-le — the native transport that restores
    // Improv BLE provisioning on iOS (WebKit has no Web Bluetooth). The web code
    // gates on bleAvailable(); on native it routes through net/capacitorImprov.ts.
    BluetoothLe: {
      displayStrings: {
        scanning: "Looking for your Splanc device…",
        cancel: "Cancel",
        availableDevices: "Splanc devices",
        noDeviceFound: "No Splanc device found",
      },
    },
  },
};

export default config;
