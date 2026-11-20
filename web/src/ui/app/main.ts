/**
 * App bootstrap (design doc §7.7) — mounts the shell + router into #app. The
 * old single-page capture app (ui/main.ts) is decomposed into screens; this is
 * the thin entry that wires them together.
 *
 * Routes (§3.3): #/onboard, #/maps, #/map/:id, #/map/:id/topology, #/effects,
 * #/capture. `?url=<wss>` still selects/links a device on load (back-compat).
 */

import { installAppLog } from "../../store/appLogStore";
import { installFeedbackFlusher } from "../../feedback/appFeedback";
import "../kit/fonts.css";
import "../kit/tokens.css";
import "./app.css";

import { codeKernelReady } from "../../code/kernel";
import { installIconSprite } from "../kit";
import { Router } from "./router";
import { Shell } from "./shell";
import { initPwa } from "./pwa";
import { deviceProber } from "../../net/deviceProber";
import { appState } from "./state";
import { mapStore } from "../../store/mapStore";
import { seedBuiltinMaps } from "../../store/seedMaps";
import { seedBuiltinEffects } from "../../store/seedEffects";
import { deviceStore } from "../../store/deviceStore";
import { OnboardingScreen } from "../screens/onboarding";
import { MapBrowserScreen } from "../screens/mapBrowser";
import { MapDetailScreen } from "../screens/mapDetail";
import { EffectsBrowserScreen } from "../screens/effectsBrowser";
import { EffectDemoScreen } from "../screens/effectDemo";
import { EffectEditorScreen } from "../screens/effectEditor";
import { setTuneCompiler } from "../screens/effectTune";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { ShowModeScreen } from "../screens/showMode";
import { BridgeLiveScreen } from "../screens/bridgeLive";
import { CaptureScreen } from "../screens/capture";
import { RoomLocalizeScreen } from "../screens/roomLocalize";
import { PerfPanelScreen } from "../screens/perfPanel";
import { CalibrateScreen } from "../screens/calibrate";
import { PerfProfilesScreen } from "../screens/perfProfiles";
import { SettingsScreen } from "../screens/settings";
import { MidiScreen } from "../screens/midi";
import { ColorCorrectionScreen } from "../screens/colorCorrection";
import { HardwareSetupScreen } from "../screens/hardwareSetup";
import { AboutScreen } from "../screens/about";
import { CreditsFlowScreen } from "../screens/creditsFlow";
import { warmActiveProvider } from "../../effects/ai/generate";
import { refreshFreeTierLimit } from "../../effects/ai/tiers";
import { AcidModeScreen } from "../screens/acidMode";
import { PlayModeScreen } from "../screens/playMode";
import { installKioskChip } from "../screens/kioskChip";
import { isPlayHash } from "../../halloween/playSession";
import { installShakeToEnter } from "../acid/shake";
import { shakeConfirmLine, SHAKE_CONFIRM_LINES } from "../acid/narrate";
import { confirmDialog, toast } from "../kit";
import { initAppearance } from "../../store/appearance";
import { maybeShowSplash } from "./splash";
import { maybeShowFirstRunHint } from "../guide/tour";
import { initWhatsNew } from "../whatsnew/whatsNew";
import { chatLogStore, chatLogDumpOnBootEnabled } from "../../store/chatLogStore";

async function main(): Promise<void> {
  // Diagnostics app log first, so boot errors land in it too.
  installAppLog();
  // Agent-feedback reports queued while offline go out when the app is back.
  installFeedbackFlusher();
  // The hue-code kernel (wasm) must be callable before any capture / decode /
  // sim render runs; already resolved wherever it compiled synchronously.
  await codeKernelReady;

  // Apply the saved appearance (theme / fonts / scale) before the shell mounts
  // so there's no flash of the default palette.
  initAppearance();

  // Halloween play mode (`#/play?f=…` from a QR code): a visitor goes straight to
  // the effects — no splash, no onboarding, no tour hint.
  const startedInPlay = isPlayHash(location.hash);

  // First-run welcome splash (no-op after the first launch). Shown over the
  // shell as it boots behind it, then fades itself out.
  if (!startedInPlay) maybeShowSplash();

  installIconSprite();

  const mount = document.getElementById("app") ?? document.body;
  const shell = new Shell();
  mount.appendChild(shell.root);

  // PWA: register the service worker + offer the install banner / ⋯-menu entry.
  initPwa();

  // Demo/capture mode (FUG-103 docs screenshots): a `?demo=<scenario>` flag lazy-
  // loads a seam that mocks hardware (connected device + RTT, camera, Bluetooth)
  // so the user guide can screenshot those states. No-op in every normal load.
  const demoParam = new URLSearchParams(location.search).get("demo");

  // Phone-in-the-loop HITL: a `?driver=<ws-url>` flag lazy-loads the app-driver
  // control channel (drives the real user journeys over a WebSocket + substitutes
  // a virtual BLE device / synthetic camera). No-op in every normal load.
  const driverParam = new URLSearchParams(location.search).get("driver");

  // Lazily probe known devices' liveness in the background (1/min → 1/10min).
  // Skipped in demo/driver mode so a real probe can't override the driven state.
  if (!demoParam && !driverParam) deviceProber.start();

  const router = new Router(shell.outlet);

  // The Effects tab's tune sheet compiles on tap: one lazily-made worker for the
  // app's lifetime (the compiler download is the slow part).
  let tuneWorker: FxCompilerWorker | null = null;
  setTuneCompiler((src) => (tuneWorker ??= new FxCompilerWorker()).compile(src));
  shell.attach(router);

  // Ask for persistent storage so the library isn't evicted (design doc §9.6).
  void mapStore.requestPersistence();

  // Back-compat: ?url=<wss> auto-adds/selects a device on load.
  const qs = new URLSearchParams(location.search);
  const urlOverride = qs.get("url");
  if (demoParam) {
    const { initDemoMode } = await import("../../demo/init");
    initDemoMode(new Set(demoParam.split(",")));
  } else if (driverParam) {
    // `?ble=real` drives with the OS Web Bluetooth stack (emulator real-BLE lane,
    // pairing with a software Bumble peripheral); default is the in-app virtual mock.
    const { setDriverBleMode } = await import("../../driver/guard");
    setDriverBleMode(qs.get("ble") === "real" ? "real" : "virtual");
    // Install the driver (sets driverActive + opens the control WS) BEFORE
    // router.start() so the BLE/capture swaps are live before any screen mounts.
    const { initDriver } = await import("../../driver/harness");
    await initDriver(driverParam, router);
  } else {
    appState.restoreActive(urlOverride);
  }

  router
    .add("/onboard", () => {
      shell.setChrome({ title: "Set up", tabs: false });
      return OnboardingScreen(router);
    })
    .add("/maps", () => {
      shell.setChrome({ title: "Maps", tabs: true });
      return MapBrowserScreen(router);
    })
    .add("/map/:id", (m) => {
      shell.setChrome({ title: "Map", back: true, tabs: true });
      return MapDetailScreen(router, m.params["id"]!);
    })
    .add("/device-map", () => {
      // Read-only preview of the connected device's map (Maps ▸ On <device>).
      shell.setChrome({ title: "Device map", back: true, tabs: true });
      return MapDetailScreen(router, "", { preview: true });
    })
    .add("/map/:id/topology", (m) => {
      shell.setChrome({ title: "Topology", back: true, tabs: true });
      return MapDetailScreen(router, m.params["id"]!, { topologyOpen: true });
    })
    .add("/effects", () => {
      shell.setChrome({ title: "Effects", tabs: true });
      return EffectsBrowserScreen(router);
    })
    .add("/show", () => {
      // Live performance workspace (FUG-110): cue two decks + crossfade.
      shell.setChrome({ title: "Show mode", back: true, tabs: true });
      return ShowModeScreen(router);
    })
    .add("/bridge", () => {
      // Live VJ through a Splanc bridge: every fixture from one session
      // (docs/design/live-vj-relay.md).
      shell.setChrome({ title: "Live via bridge", back: true, tabs: true });
      return BridgeLiveScreen(router);
    })
    .add("/effects/edit/:id", (m) => {
      // Overlay chrome: hide the app-bar + tab-bar so the editor owns the whole
      // viewport and supplies its own floating back/⋯/name controls.
      shell.setChrome({ title: "Edit effect", back: true, tabs: false, overlay: true });
      if (m.query.get("workspace") === "demo") return EffectDemoScreen(router, m.params["id"]!);
      return EffectEditorScreen(router, m.params["id"]!);
    })
    .add("/perf", () => {
      shell.setChrome({ title: "Performance", back: true, tabs: true });
      return PerfPanelScreen(router);
    })
    .add("/perf/calibrate", () => {
      shell.setChrome({ title: "Calibrate", back: true, tabs: false });
      return CalibrateScreen(router);
    })
    .add("/perf/profiles", () => {
      shell.setChrome({ title: "Performance profiles", back: true, tabs: true });
      return PerfProfilesScreen(router);
    })
    .add("/settings", () => {
      shell.setChrome({ title: "Settings", back: true, tabs: true });
      return SettingsScreen(router);
    })
    .add("/settings/midi", () => {
      shell.setChrome({ title: "MIDI", back: true, tabs: true });
      return MidiScreen(router);
    })
    .add("/settings/color-correction", () => {
      shell.setChrome({ title: "Color correction", back: true, tabs: true });
      return ColorCorrectionScreen(router);
    })
    .add("/settings/hardware", () => {
      shell.setChrome({ title: "Hardware Setup", back: true, tabs: true });
      return HardwareSetupScreen(router);
    })
    .add("/settings/ai", () => {
      // Settings ▸ AI: the AI provider settings + Splanc AI credits account.
      shell.setChrome({ title: "Settings", back: true, tabs: true });
      return SettingsScreen(router, "ai");
    })
    .add("/credits", () => {
      // The dedicated Splanc AI credits flow (one step per screen).
      shell.setChrome({ title: "Splanc AI credits", back: true, tabs: false });
      return CreditsFlowScreen(router, "buy");
    })
    .add("/credits/:mode", (m) => {
      const mode = m.params["mode"];
      const known =
        mode === "return" ||
        mode === "restore" ||
        mode === "email" ||
        mode === "removeEmail" ||
        mode === "delete" ||
        mode === "signin" ||
        mode === "signout" ||
        mode === "unlinkApple" ||
        mode === "unlinkGoogle";
      // Coming back from Stripe: no app-bar Back (it would return to Stripe).
      shell.setChrome({ title: "Splanc AI credits", back: mode !== "return", tabs: false });
      return CreditsFlowScreen(router, known ? mode : "buy");
    })
    .add("/room", () => {
      shell.setChrome({ title: "Localize room", back: true, tabs: false });
      return RoomLocalizeScreen(router);
    })
    .add("/capture", (m) => {
      shell.setChrome({ title: "Capture", back: true, tabs: false, overlay: true });
      return CaptureScreen(router, m.query);
    })
    .add("/about", (m) => {
      shell.setChrome({ title: "About", back: true, tabs: true });
      return AboutScreen(router, m.query.get("tab") === "docs" ? "docs" : "about");
    })
    .add("/play", (m) => {
      // Halloween play mode: the screen owns the viewport (no tabs, no ⋯ menu).
      shell.setChrome({ title: "Play", tabs: false, overlay: true });
      return PlayModeScreen(router, m.query);
    })
    .add("/acid", (m) => {
      // Overlay chrome: the mode owns the whole viewport (its own pill + exit).
      // `play=1` comes from the kiosk play mode (minimal chrome, free AI).
      shell.setChrome({ title: "Acid mode", tabs: false, overlay: true });
      return AcidModeScreen(router, { play: m.query.get("play") === "1" });
    })
    .setFallback(() => {
      // First run with no device → onboarding; else → home (Effects: see the
      // fixture, pick an effect, tune it — docs/ux/oobe-review.md).
      const hasDevices = deviceStore.list().length > 0;
      if (hasDevices || urlOverride) {
        shell.setChrome({ title: "Effects", tabs: true });
        return EffectsBrowserScreen(router);
      }
      shell.setChrome({ title: "Set up", tabs: false });
      return OnboardingScreen(router);
    });

  // Seed built-in sample maps once, before the first render, so the library is
  // populated on a fresh install (cheap no-op on subsequent loads).
  await seedBuiltinMaps();
  await seedBuiltinEffects();

  // OpenRouter sign-in coming back (free tier, docs/design/ai-tiers.md): store
  // the user's key and restore the route before any screen mounts.
  if (/[?&](code|error)=/.test(location.search)) {
    const { finishOpenRouterRedirect } = await import("../screens/aiTierSheet");
    await finishOpenRouterRedirect();
  }
  // Stripe Checkout coming back (?checkout=success|cancel): show the credits
  // flow's return screen whatever route the return URL carried (older builds
  // returned to #/settings/ai).
  if (/[?&]checkout=(success|cancel)\b/.test(location.search) && !location.hash.startsWith("#/credits/return")) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}#/credits/return`);
  }
  router.start();

  // iOS: App Store purchases still waiting for their credit (a crash or no
  // network between paying and crediting) and Ask to Buy approvals, from
  // launch on. A no-op elsewhere, or with credits off (effects/ai/iap.ts).
  void import("../../effects/ai/iap")
    .then(({ startIapDelivery }) =>
      startIapDelivery((r) => toast(`Splanc AI credits: ${Math.floor(r.credited)} credits added.`)),
    )
    .catch(() => {});

  // Warm the offline firmware cache with the latest release in the background, so a
  // released image is flashable over USB even with no network later. Dynamic-imported
  // to keep the flash stack (and the esptool-js it can pull) off the initial bundle;
  // best-effort — prefetchLatestFirmware() self-guards offline / errors.
  void import("../../flash/firmwareRepo").then((m) => m.prefetchLatestFirmware()).catch(() => {});

  // Warm the AI provider in the background so the first chat turn in the effects
  // workspace is fast. Only the in-browser WebGPU model has anything to warm —
  // it loads onto the GPU in its Web Worker (off the main thread) and prefills
  // the chat system prompt; cloud / local-server providers no-op. Best-effort:
  // skips silently with no WebGPU, no selected model, or weights not yet cached.
  warmActiveProvider();
  // Free tier: re-check the OpenRouter daily allowance (it decides vision).
  void refreshFreeTierLimit();

  // FX-agent chat-log console dump (debugging, Option 1): a manual trigger from
  // DevTools, plus an on-boot dump when the "dump on launch" toggle is set — the
  // latter lets `bazel run //tools:ios_deploy -- --log` capture the transcripts
  // off a physical iPhone via the device console.
  (globalThis as { __dumpChatLogs?: () => void }).__dumpChatLogs = () =>
    void chatLogStore.dumpToConsole();
  if (chatLogDumpOnBootEnabled()) void chatLogStore.dumpToConsole();

  // First-run tutorial hint (FUG-103): a dismissible "?" affordance offering the
  // guided tour. No-op once the tutorial has been taken or dismissed; always
  // recallable from Settings ▸ Help & tutorial.
  const effectsDemo = router.path().startsWith("/effects/edit/") &&
    new URLSearchParams(location.hash.split("?")[1]).get("workspace") === "demo";
  //
  // "What's new?" (release notes) runs first: after an update it shows a sparkle
  // bubble in the same corner and the tour hint stays away this launch; on a
  // fresh install it stays quiet and the tour hint owns the corner.
  const cornerSuppressed = effectsDemo || startedInPlay || isPlayHash(location.hash);
  const whatsNewShown = initWhatsNew({ suppressed: cornerSuppressed });
  if (!cornerSuppressed && !whatsNewShown) maybeShowFirstRunHint(router);

  // Kiosk countdown chip on every screen but play mode (effects workspace, Acid
  // Mode…) while the connected device is in kiosk mode.
  installKioskChip();

  // Shake-to-enter Acid Mode (FUG-106): a vigorous side-to-side shake pops a
  // (humorous) confirmation; on OK we drop into the hands-free mode. Guarded so
  // it can't fire while already there or while the confirm is up. No-op where
  // DeviceMotion is unavailable (desktop).
  let shakePrompting = false;
  installShakeToEnter(() => {
    const path = location.hash.replace(/^#/, "").split("?")[0];
    if (shakePrompting || path === "/acid") return;
    shakePrompting = true;
    // Rotate the line so repeat shakers don't see the same quip every time.
    const line = shakeConfirmLine(Math.floor(Date.now() / 1000) % SHAKE_CONFIRM_LINES.length);
    void confirmDialog({
      title: "🫨 Acid Mode?",
      message: line,
      confirmLabel: "Let's go 🌀",
      cancelLabel: "Nope",
      trippy: true,
    }).then((ok) => {
      shakePrompting = false;
      if (ok) router.navigate("/acid");
    });
  });
}

void main();
