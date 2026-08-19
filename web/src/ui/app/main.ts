/**
 * App bootstrap (design doc §7.7) — mounts the shell + router into #app. The
 * old single-page capture app (ui/main.ts) is decomposed into screens; this is
 * the thin entry that wires them together.
 *
 * Routes (§3.3): #/onboard, #/maps, #/map/:id, #/map/:id/topology, #/effects,
 * #/capture. `?url=<wss>` still selects/links a device on load (back-compat).
 */

import "../kit/fonts.css";
import "../kit/tokens.css";
import "./app.css";

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
import { EffectEditorScreen } from "../screens/effectEditor";
import { CaptureScreen } from "../screens/capture";
import { PerfPanelScreen } from "../screens/perfPanel";
import { CalibrateScreen } from "../screens/calibrate";
import { PerfProfilesScreen } from "../screens/perfProfiles";
import { SettingsScreen } from "../screens/settings";
import { MidiScreen } from "../screens/midi";
import { ColorCorrectionScreen } from "../screens/colorCorrection";
import { AboutScreen } from "../screens/about";
import { AcidModeScreen } from "../screens/acidMode";
import { installShakeToEnter } from "../acid/shake";
import { shakeConfirmLine, SHAKE_CONFIRM_LINES } from "../acid/narrate";
import { confirmDialog } from "../kit";
import { initAppearance } from "../../store/appearance";
import { maybeShowSplash } from "./splash";
import { maybeShowFirstRunHint } from "../guide/tour";
import { chatLogStore, chatLogDumpOnBootEnabled } from "../../store/chatLogStore";

async function main(): Promise<void> {
  // Apply the saved appearance (theme / fonts / scale) before the shell mounts
  // so there's no flash of the default palette.
  initAppearance();

  // First-run welcome splash (no-op after the first launch). Shown over the
  // shell as it boots behind it, then fades itself out.
  maybeShowSplash();

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

  // Lazily probe known devices' liveness in the background (1/min → 1/10min).
  // Skipped in demo mode so a real probe can't override the injected device state.
  if (!demoParam) deviceProber.start();

  const router = new Router(shell.outlet);
  shell.attach(router);

  // Ask for persistent storage so the library isn't evicted (design doc §9.6).
  void mapStore.requestPersistence();

  // Back-compat: ?url=<wss> auto-adds/selects a device on load.
  const qs = new URLSearchParams(location.search);
  const urlOverride = qs.get("url");
  if (demoParam) {
    const { initDemoMode } = await import("../../demo/init");
    initDemoMode(new Set(demoParam.split(",")));
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
    .add("/map/:id/topology", (m) => {
      shell.setChrome({ title: "Topology", back: true, tabs: true });
      return MapDetailScreen(router, m.params["id"]!, { topologyOpen: true });
    })
    .add("/effects", () => {
      shell.setChrome({ title: "Effects", tabs: true });
      return EffectsBrowserScreen(router);
    })
    .add("/effects/edit/:id", (m) => {
      // Overlay chrome: hide the app-bar + tab-bar so the editor owns the whole
      // viewport and supplies its own floating back/⋯/name controls.
      shell.setChrome({ title: "Edit effect", back: true, tabs: false, overlay: true });
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
    .add("/capture", (m) => {
      shell.setChrome({ title: "Capture", back: true, tabs: false, overlay: true });
      return CaptureScreen(router, m.query);
    })
    .add("/about", (m) => {
      shell.setChrome({ title: "About", back: true, tabs: true });
      return AboutScreen(router, m.query.get("tab") === "docs" ? "docs" : "about");
    })
    .add("/acid", () => {
      // Overlay chrome: the mode owns the whole viewport (its own pill + exit).
      shell.setChrome({ title: "Acid mode", tabs: false, overlay: true });
      return AcidModeScreen(router);
    })
    .setFallback(() => {
      // First run with no device and no maps → onboarding; else → maps.
      const hasDevices = deviceStore.list().length > 0;
      if (hasDevices || urlOverride) {
        shell.setChrome({ title: "Maps", tabs: true });
        return MapBrowserScreen(router);
      }
      shell.setChrome({ title: "Set up", tabs: false });
      return OnboardingScreen(router);
    });

  // Seed built-in sample maps once, before the first render, so the library is
  // populated on a fresh install (cheap no-op on subsequent loads).
  await seedBuiltinMaps();
  await seedBuiltinEffects();

  router.start();

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
  maybeShowFirstRunHint(router);

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
