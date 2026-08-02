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
import { EffectsScreen } from "../screens/effects";
import { EffectsBrowserScreen } from "../screens/effectsBrowser";
import { EffectEditorScreen } from "../screens/effectEditor";
import { CaptureScreen } from "../screens/capture";
import { PerfPanelScreen } from "../screens/perfPanel";
import { CalibrateScreen } from "../screens/calibrate";
import { SettingsScreen } from "../screens/settings";
import { MidiScreen } from "../screens/midi";
import { initAppearance } from "../../store/appearance";

async function main(): Promise<void> {
  // Apply the saved appearance (theme / fonts / scale) before the shell mounts
  // so there's no flash of the default palette.
  initAppearance();

  installIconSprite();

  const mount = document.getElementById("app") ?? document.body;
  const shell = new Shell();
  mount.appendChild(shell.root);

  // PWA: register the service worker + offer the install banner / ⋯-menu entry.
  initPwa();

  // Lazily probe known devices' liveness in the background (1/min → 1/10min).
  deviceProber.start();

  const router = new Router(shell.outlet);
  shell.attach(router);

  // Ask for persistent storage so the library isn't evicted (design doc §9.6).
  void mapStore.requestPersistence();

  // Back-compat: ?url=<wss> auto-adds/selects a device on load.
  const qs = new URLSearchParams(location.search);
  const urlOverride = qs.get("url");
  appState.restoreActive(urlOverride);

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
    .add("/effects/pulse", () => {
      shell.setChrome({ title: "Pulse / Flood", back: true, tabs: true });
      return EffectsScreen(router);
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
    .add("/settings", () => {
      shell.setChrome({ title: "Appearance", back: true, tabs: true });
      return SettingsScreen(router);
    })
    .add("/settings/midi", () => {
      shell.setChrome({ title: "MIDI", back: true, tabs: true });
      return MidiScreen(router);
    })
    .add("/capture", () => {
      shell.setChrome({ title: "Capture", back: true, tabs: false, overlay: true });
      return CaptureScreen(router);
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
}

void main();
