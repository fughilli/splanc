# Splanc on iOS — Scoping (FUG-92)

Status: **Scoping / investigation.** No code changes; this doc decides *whether* and *how*
to ship Splanc to iPhone users, and enumerates the follow-up work.
Scope: the phone webapp (`web/`) and a possible native wrapper. Firmware is touched only
where an iOS "device programming" story forces an OTA feature (called out, not designed here).

Related: `docs/design/app-ux-overhaul.md` §"iOS constraints" ("ignore iOS for now… investigate
the web flow or a React Native app" — this doc *is* that investigation), `led-mapper-design.md`
§5 (the original "iOS seam"), `docs/esp32-led-mapping-plan.md` (Improv onboarding).

---

## 1. TL;DR / recommendation

Most of Splanc **already runs on iOS Safari today** — the parts people spend their time in
(mapping a fixture, cleaning topology, designing effects, driving an already-provisioned
device) have no iOS-specific blocker since the WebXR capture path was removed. What iOS
*can't* do falls entirely on two WebKit-missing web APIs, and both are onboarding-time, not
everyday-use:

1. **Flash firmware over USB** (Web Serial / WebUSB) — no iOS browser has either, and native
   iOS can't reach an ESP32 dev board over USB serial either. **This stays desktop-only.**
2. **BLE Wi-Fi provisioning** (Web Bluetooth / Improv) — no iOS browser has Web Bluetooth, so
   iOS falls back to the manual `?url=` path. **Native iOS CoreBluetooth *can* do this**, so a
   native wrapper restores it.

Recommendation, in two tiers:

- **Tier 0 — ship the PWA as the iOS story now (days).** It already works for the common case.
  Close the small real gaps (verify on-device, tighten the iOS onboarding copy, request
  persistent storage). Blank-board first-flash remains "do it once on a desktop."
- **Tier 1 — a Capacitor (WKWebView) wrapper (weeks) if we want a real "iOS app."** Reuse the
  existing Vite/TS build unchanged; add exactly two native capabilities behind seams that
  already exist: **native BLE Improv provisioning** and a **native cert bridge** that pins the
  device's self-signed cert (killing the manual cert-accept dance). USB flashing is still out;
  the iOS device-programming answer is **Wi-Fi/BLE OTA** (a separate firmware track).

**Do not use React Native** (floated in the UX doc). The entire app is canvas/WebGL/`<video>`
+ a hand-written solver and effects VM; RN would mean a ground-up rewrite of the UI for zero
functional gain over a WKWebView that runs the code we already have.

---

## 2. Where iOS stands today (per-capability audit)

Every iOS browser — Safari, "Chrome", "Edge" — is WebKit under the hood, so browser choice
changes nothing. Capability by capability:

| Capability | Web API used | iOS Safari / any iOS browser | Code today |
| --- | --- | --- | --- |
| **Camera capture / mapping** | `getUserMedia` + `requestVideoFrameCallback` | ✅ Works (Safari 16.4+ for rVFC) | `xr/mediaStreamCapture.ts` — the *sole* path since WebXR was removed |
| **Motion / IMU** | `DeviceMotionEvent` | ✅ Works; needs `requestPermission()` on a user gesture | `xr/imu.ts` already gates on it |
| **Device control (map/effects/live)** | `wss://` to LAN device, self-signed cert | ✅ Works after a one-time manual cert accept | `net/client.ts`, `net/deviceProber.ts` |
| **QR scan** (address entry) | `getUserMedia` | ✅ Works | `ui/screens/qrScan.ts` |
| **Effects editor / preview / video export** | Canvas / WebGL2 / WebCodecs | ✅ Works (WebCodecs Safari 16.4+) | `fx/*`, `effects/*` |
| **Install to Home Screen** | manifest + apple-touch meta | ✅ Works (standalone) | `web/index.html`, `manifest.webmanifest`, `ui/app/pwa.ts` |
| **Firmware flash over USB** | Web Serial / WebUSB | ❌ **Neither exists** | `flash/*`, `flash/env.ts` already diagnoses + tells the user to use desktop |
| **BLE Wi-Fi provisioning** | Web Bluetooth (Improv) | ❌ **No Web Bluetooth** | `net/improv.ts` gates on `bleAvailable()`; iOS keeps manual `?url=` |

The single most important finding: **the mapping capture path is browser-agnostic.** The old
WebXR/ARCore path (which *was* Android-only) is gone; `MediaStreamCaptureSource` is
"THE capture path… works in ANY browser" (`xr/mediaStreamCapture.ts` header). The
"iOS seam" that `led-mapper-design.md` §5/§10 deferred has effectively already been built.

So the iOS gap is **not** the app — it's onboarding a *brand-new* device (flash + Wi-Fi join).

---

## 3. The two hard blockers, examined

### 3.1 USB flashing — permanently desktop-only

`flash/env.ts` already states it: iOS "has neither Web Serial nor WebUSB… no browser can
flash — use desktop Chrome or Edge." A native wrapper does **not** fix this:

- iOS gives third-party apps **no public USB-serial API**. The `ExternalAccessory` framework
  requires the accessory to be **MFi-certified**; a generic ESP32-C6 dev board is not.
- USB-C iPads can enumerate some USB devices, but CDC-ACM serial to an unlisted board is not
  available to App Store apps.

**Conclusion:** first-flash of a blank board stays on desktop (Chrome/Edge via Web
Serial/WebUSB), on any iOS approach. The realistic way to put "device programming" on an
iPhone is **over-the-air update after the first flash** (see §4.3), not USB.

### 3.2 BLE provisioning — restorable in a native wrapper

WebKit has no Web Bluetooth, so `net/improv.ts` degrades to manual address entry on iOS. But
iOS's **CoreBluetooth** fully supports BLE GATT (central role), and Improv is just a GATT
service. A Capacitor plugin (`@capacitor-community/bluetooth-le`) exposes exactly the calls
`provisionViaBle()` needs: scan/connect, read `CHAR_CURRENT_STATE`/`CHAR_CAPABILITIES`, write
`CHAR_RPC_COMMAND`, subscribe to `CHAR_RPC_RESULT`.

The code is already shaped for this. The **byte-level Improv codec is pure and DOM-free**
(`buildWifiSettings`, `parseRpcResult`, `wsUrlFromRedirect` — all unit-tested); only
`provisionViaBle()` / `requestImprovDevice()` touch `navigator.bluetooth`, and the UI already
gates on `bleAvailable()`. Restoring iOS BLE = swap the transport under that seam, reusing the
codec verbatim (see §4.2).

---

## 4. Tier 1 — the Capacitor wrapper, in detail

### 4.1 Why Capacitor (WKWebView), not React Native or a from-scratch native app

- **Reuse.** Capacitor loads the *existing* `web/dist` bundle in a WKWebView. Zero UI rewrite;
  the canvas, WebGL2 detector, VIO solver, effects VM, and all screens run as-is.
- **One codebase.** The same build ships to the web PWA, Android (later), and iOS. Native
  code is confined to two small plugins.
- **RN is the wrong tool here.** Splanc is not a widget app; it's a real-time
  camera→GPU→solver pipeline plus a bespoke effects editor. RN gives us native *views* we
  don't want and forces a rewrite of everything we do want. No upside.

Trade-offs to accept: an App Store presence (Apple Developer Program, $99/yr), review latency,
and a native build in CI (Xcode). WKWebView performance for our WebGL/`<video>` workload is
adequate on modern iPhones but should be validated early (§6).

### 4.2 Native BLE Improv plugin

- Add `@capacitor-community/bluetooth-le`.
- Introduce a small transport interface behind the existing seam, e.g. an `ImprovTransport`
  that both the Web Bluetooth path and the Capacitor-BLE path implement; `provisionViaBle()`
  keeps owning the *protocol* (it already does) and just takes a transport.
- Make `bleAvailable()` return true when the Capacitor BLE plugin is present, so the existing
  `addDevice.ts` "Add over Bluetooth" UI lights up on iOS with no UI changes.
- Reuse `buildWifiSettings` / `parseRpcResult` / `wsUrlFromRedirect` unchanged — they're already
  the tested core.
- iOS specifics: `NSBluetoothAlwaysUsageDescription` in Info.plist; scan by the Improv service
  UUID (`IMPROV_SERVICE`); handle CoreBluetooth's connect/discover/notify async ordering
  (`retryGatt` in `improv.ts` is a useful analogue).

### 4.3 Native cert bridge (removes the manual cert dance) + OTA hook

The device serves `wss://` with a **self-signed** cert; today the user must open `https://<device>/`
once and accept it (`certApprovalUrl()` in `net/client.ts`). In a native wrapper we own the
network stack and can do better:

- Route the control-plane socket through a **native WebSocket bridge** (a small Capacitor
  plugin) whose `URLSession`/`URLSessionWebSocketTask` delegate performs cert **pinning** to
  the device's self-signed cert (trust-on-first-use, keyed by device MAC, matching the
  cert-rotation logic already in `client.ts`). `SocketFactory` in `client.ts` is already
  injectable, so this drops in behind the existing interface with no state-machine change.
  - Alternative if we don't want a native WS: a `WKNavigationDelegate`
    `didReceiveChallenge` handler can trust the cert for `wss` loaded *in the webview*, but
    the app opens sockets from JS, so the native-WS bridge is the cleaner fit.
- **OTA (the iOS device-programming answer).** Once we have a trusted native channel and BLE,
  we can offer firmware **update** over Wi-Fi (ESP OTA) or BLE DFU from the phone — the only
  viable "program the device from an iPhone" path given §3.1. This is primarily a **firmware**
  feature; file it as its own track and treat the app side as a thin uploader.

### 4.4 Distribution & CI

- Apple Developer Program account; app signing; TestFlight for beta, App Store for GA.
- Xcode build in CI (the web build stays Bazel/Vite; the iOS wrap is a separate lane).
- App Store review notes: camera + Bluetooth usage strings, and a reviewer path that doesn't
  require physical hardware (a simulator/mock device or a screencast).

---

## 5. Tier 0 — ship the PWA now (recommended immediate step)

Independent of any wrapper, and worth doing regardless:

- **Verify on a real iPhone** (see §6) — this is the one thing this scoping can't assert from
  code alone.
- **Onboarding copy for iOS:** make "flash on desktop, then continue on your iPhone" a
  first-class guided path, and keep the manual `?url=` / QR provisioning prominent where
  `bleAvailable()` is false. Much of this exists (`flash/env.ts`, `addDevice.ts`); audit the
  wording for an iPhone-only user who never sees a Bluetooth option.
- **Persistent storage:** call `navigator.storage.persist()` (iOS evicts IndexedDB
  aggressively) and keep the export-bundle backup — already flagged in the UX doc §"Storage".
- **Home-screen install polish:** confirm standalone launch, safe-area insets
  (`viewport-fit=cover` is set), status-bar style, and icon set on iOS.

Tier 0 gets ~90% of iOS users fully working. Tier 1 is what turns "works in Safari if someone
else set up the device" into "an iPhone owner can onboard and run the whole thing."

---

## 6. Open questions / must-verify-on-hardware

Code review can't settle these; they need one session on a real iPhone (and ideally an iPad):

1. **Capture pipeline on WKWebView/iOS Safari:** does `requestVideoFrameCallback` deliver
   frames fast enough, and does the WebGL2 detector + VIO solver converge on a real map? (The
   VIO solver was tuned against Android captures — iOS camera exposure/rolling-shutter and the
   `heuristicK` FOV assumption may need per-device calibration.)
2. **DeviceMotion quality on iOS:** sample rate, axis conventions, and the
   `requestPermission()` gesture flow end-to-end (`imu.ts` normalizes axes, but iOS handsets
   differ).
3. **Self-signed `wss` on iOS Safari:** does the one-time cert-accept actually stick for the
   PWA, or is the friction bad enough that Tier 1's cert bridge is required sooner?
4. **WebCodecs / video export** on iOS Safari for the effects preview/export path.
5. **WKWebView WebGL performance** for the effects preview at target frame rates.

---

## 7. Proposed follow-up tickets

If we proceed, this breaks into (to be filed on request):

- **Tier 0:** on-device iOS verification pass; iOS onboarding-copy + manual-provisioning audit;
  `navigator.storage.persist()` + storage-pressure warning.
- **Tier 1:** Capacitor project scaffold + CI lane; native BLE Improv plugin behind an
  `ImprovTransport` seam; native cert-pinning WebSocket bridge behind `SocketFactory`; App
  Store / TestFlight distribution setup.
- **Firmware track (enables iOS device-programming):** Wi-Fi (ESP) OTA and/or BLE DFU update
  path, with a thin app-side uploader.

## 8. Explicit non-goals

- USB flashing on iOS (impossible — §3.1). First-flash stays desktop.
- A React Native / from-scratch native rewrite (§4.1).
- Simultaneous multi-phone capture, live re-mapping (already non-goals in `led-mapper-design.md`).
