/**
 * Native camera checkpoint (docs/design/ios-support.md §4.7, phase 1+2).
 *
 * Proves the one thing the whole native-capture plan rests on: that exposure is
 * controllable once the app owns the AVCaptureSession. It starts the native
 * session, shows its preview behind the WebView, and drives `setExposure` from a
 * slider — so dragging visibly darkens/brightens the live image, and the readout
 * shows what the SENSOR reported back rather than what we asked for.
 *
 * Deliberately standalone: the mapping pipeline still runs on getUserMedia, and
 * the two capture clients cannot share the camera, so this screen owns it alone
 * for as long as it's mounted. Once frames reach the detector (the sparse
 * readback-transport stage) this screen's job is done and it can go.
 */

import { Button, Card, Slider } from "../kit";
import type { Router, Screen } from "../app/router";
import {
  nativeCamera,
  nativeCameraAvailable,
  type NativeCameraInfo,
  type NativeExposureResult,
} from "../../xr/nativeCamera";
import { prefs } from "../../store/prefs";

export function NativeCameraCheckScreen(_router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--native-camera";

  const status = document.createElement("p");
  status.className = "screen-sub";
  const readout = document.createElement("pre");
  readout.style.cssText =
    "margin:0;padding:var(--sp-2);border-radius:var(--r-2);background:rgba(0,0,0,0.55);" +
    "color:#fff;font:12px/1.5 var(--font-mono);white-space:pre-wrap";

  let info: NativeCameraInfo | null = null;
  let started = false;
  // Serialises setExposure calls: a drag fires far faster than the sensor can
  // retune, and overlapping lockForConfiguration calls are pointless churn.
  let inFlight = false;
  let pending: number | null = null;

  function show(r: NativeExposureResult, target: number): void {
    readout.textContent =
      `target      ${target.toFixed(3)}\n` +
      `applied     ${r.applied}\n` +
      `exposure    ${r.exposureMs.toFixed(2)} ms\n` +
      `iso         ${r.iso.toFixed(0)}\n` +
      `${r.description}`;
  }

  async function apply(target: number): Promise<void> {
    if (!started) return;
    if (inFlight) {
      pending = target;
      return;
    }
    inFlight = true;
    try {
      const r = await nativeCamera().setExposure({
        target,
        maxExposureMs: prefs.getManualExposureCeilingMs(),
      });
      show(r, target);
    } catch (e) {
      readout.textContent = `setExposure failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      inFlight = false;
      if (pending !== null) {
        const next = pending;
        pending = null;
        void apply(next);
      }
    }
  }

  const slider = Slider({
    label: "Exposure",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.5,
    format: (v) => v.toFixed(2),
    onInput: (v) => void apply(v),
  });

  const auto = Button({
    label: "Back to auto",
    variant: "quiet",
    onClick: () => {
      if (!started) return;
      void nativeCamera()
        .clearExposure()
        .then(() => {
          readout.textContent = "continuous auto-exposure restored";
        });
    },
  });

  el.append(status, Card(slider.el, auto, readout));

  return {
    el,
    onMount: () => {
      if (!nativeCameraAvailable()) {
        status.textContent =
          "This checkpoint only runs in the iOS app — the native capture session doesn't exist in a browser.";
        slider.el.style.display = "none";
        auto.style.display = "none";
        return;
      }
      // Let the preview layer (behind the WebView) show through. The plugin makes
      // the WebView itself transparent; the page's own background is ours to clear.
      // BOTH elements matter: tokens.css paints `html, body`, and the ROOT
      // element's background is what fills the page canvas — clearing body alone
      // leaves html opaque and the preview stays invisible.
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
      status.textContent = "starting camera…";
      void nativeCamera()
        .start()
        .then((i) => {
          info = i;
          started = true;
          status.textContent =
            `${i.width}×${i.height} · exposure ${i.minExposureMs.toFixed(2)}–` +
            `${i.maxExposureMs.toFixed(0)} ms · iso ${i.minIso.toFixed(0)}–${i.maxIso.toFixed(0)}` +
            (i.customExposureSupported ? "" : " · custom exposure UNSUPPORTED");
          // Apply the slider's starting position so the first drag has a baseline.
          return apply(0.5);
        })
        .catch((e: unknown) => {
          status.textContent = `camera failed to start: ${e instanceof Error ? e.message : String(e)}`;
        });
    },
    onUnmount: () => {
      document.documentElement.style.background = "";
      document.body.style.background = "";
      if (!nativeCameraAvailable()) return;
      started = false;
      // Hand the camera back, or getUserMedia (the mapping path) can't have it.
      void nativeCamera().stop();
      void info;
    },
  };
}
