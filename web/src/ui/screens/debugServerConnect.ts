/**
 * "Connect debug server" flow — a camera viewfinder that auto-connects the moment
 * it recognises the server's QR (no button press), with a "Connect by URL"
 * fallback that reveals a text box for manual entry. It ONLY connects — the
 * actions on the connection (send/download) live in Settings ▸ Debugging.
 *
 * Auto-scan uses the native BarcodeDetector (Android/Chrome/desktop). iOS
 * WKWebView has no BarcodeDetector, so there the viewfinder can't decode — the
 * "Connect by URL" path (paste the URL the debug server prints) is the route.
 */

import { connectDebugServer, debugServerUrl } from "../../net/debugServer";
import { isNativePlatform } from "../../net/native";
import { qrScanSupported } from "./qrScan";
import { toast } from "../kit";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Open the connect overlay. Resolves when it closes (connected or cancelled);
 * observe connection state via subscribeDebugServer. */
export function openDebugServerConnect(): void {
  const overlay = document.createElement("div");
  overlay.className = "qrscan";

  const video = document.createElement("video");
  video.className = "qrscan-video";
  video.playsInline = true;
  video.muted = true;

  const reticle = document.createElement("div");
  reticle.className = "qrscan-reticle";

  const hint = document.createElement("div");
  hint.className = "qrscan-hint";
  hint.textContent = qrScanSupported()
    ? "Point at the debug-server QR"
    : "Tap “Connect by URL” and paste the server URL";

  const bar = document.createElement("div");
  bar.className = "qrscan-bar";
  const byUrl = mkBtn("Connect by URL");
  const cancel = mkBtn("Cancel");
  bar.append(byUrl, cancel);

  // Manual-URL panel (hidden until "Connect by URL").
  const urlPanel = document.createElement("div");
  urlPanel.className = "dbgconn-url";
  urlPanel.hidden = true;
  const urlInput = document.createElement("input");
  urlInput.className = "dbgconn-input";
  urlInput.type = "url";
  urlInput.autocomplete = "off";
  urlInput.placeholder = "https://192.168.x.x:8093";
  urlInput.value = debugServerUrl();
  const urlGo = mkBtn("Connect");
  const urlBack = mkBtn("Back");
  urlPanel.append(urlInput, urlGo, urlBack);

  overlay.append(video, reticle, hint, bar, urlPanel);
  document.body.appendChild(overlay);

  let stream: MediaStream | null = null;
  let raf = 0;
  let done = false;
  let connecting = false;

  const finish = (): void => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  };

  async function attempt(url: string): Promise<void> {
    const u = url.trim().replace(/\/+$/, "");
    if (!u || connecting) return;
    connecting = true;
    hint.textContent = "Connecting…";
    const ok = await connectDebugServer(u);
    connecting = false;
    if (ok) {
      toast(`Connected to ${hostOf(u)}`);
      finish();
      return;
    }
    hint.textContent = qrScanSupported() ? "Point at the debug-server QR" : "Enter the server URL";
    toast(
      isNativePlatform()
        ? `Couldn't reach ${hostOf(u)} — check the URL and that the server is running.`
        : `Couldn't reach ${hostOf(u)} — open ${u}/ in a tab and accept the certificate, then retry.`,
      { error: true },
    );
  }

  cancel.addEventListener("click", finish);
  byUrl.addEventListener("click", () => {
    urlPanel.hidden = false;
    bar.hidden = true;
    hint.textContent = "Enter the server URL";
    urlInput.focus();
  });
  urlBack.addEventListener("click", () => {
    urlPanel.hidden = true;
    bar.hidden = false;
    hint.textContent = qrScanSupported() ? "Point at the debug-server QR" : "Tap “Connect by URL”";
  });
  urlGo.addEventListener("click", () => void attempt(urlInput.value));
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void attempt(urlInput.value);
  });

  // Camera + auto-scan. getUserMedia works on iOS even though BarcodeDetector
  // doesn't; show the viewfinder regardless, and only run the decode loop where
  // BarcodeDetector exists.
  const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (typeof navigator.mediaDevices?.getUserMedia === "function") {
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((s) => {
        if (done) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        void video.play();
        if (BD && qrScanSupported()) {
          const detector = new BD({ formats: ["qr_code"] });
          const tick = async (): Promise<void> => {
            if (done || connecting) {
              if (!done) raf = requestAnimationFrame(() => void tick());
              return;
            }
            try {
              const codes = await detector.detect(video);
              const hit = codes.find((c) => c.rawValue);
              if (hit) {
                await attempt(hit.rawValue);
                if (done) return;
              }
            } catch {
              /* transient decode error between frames — keep scanning */
            }
            raf = requestAnimationFrame(() => void tick());
          };
          raf = requestAnimationFrame(() => void tick());
        }
      })
      .catch(() => {
        // No camera / denied — go straight to manual entry.
        byUrl.click();
      });
  } else {
    byUrl.click();
  }
}

function mkBtn(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "qrscan-btn";
  b.textContent = label;
  return b;
}
