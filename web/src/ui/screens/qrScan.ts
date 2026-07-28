/**
 * Minimal QR scanner overlay using the native BarcodeDetector API (Chrome /
 * Android — the phone target). Opens a rear-camera viewfinder and resolves with
 * the first decoded value, or null if cancelled / unsupported / no camera (the
 * caller then falls back to manual URL entry).
 */

import { toast } from "../kit";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

export function qrScanSupported(): boolean {
  return (
    "BarcodeDetector" in window &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/** Open the scanner; resolve the decoded string, or null if it wasn't obtained
 * (cancel / no support / camera denied). */
export async function scanQr(): Promise<string | null> {
  const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!BD || typeof navigator.mediaDevices?.getUserMedia !== "function") return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (e) {
    toast(`Camera unavailable: ${e instanceof Error ? e.message : e}`, { error: true });
    return null;
  }

  return new Promise<string | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "qrscan";

    const video = document.createElement("video");
    video.className = "qrscan-video";
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;

    const reticle = document.createElement("div");
    reticle.className = "qrscan-reticle";

    const hint = document.createElement("div");
    hint.className = "qrscan-hint";
    hint.textContent = "Point at the debug-server QR";

    const bar = document.createElement("div");
    bar.className = "qrscan-bar";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "qrscan-btn";
    cancel.textContent = "Cancel";
    const manual = document.createElement("button");
    manual.type = "button";
    manual.className = "qrscan-btn";
    manual.textContent = "Type it instead";
    bar.append(cancel, manual);

    overlay.append(video, reticle, hint, bar);
    document.body.appendChild(overlay);

    let done = false;
    let raf = 0;
    const finish = (val: string | null): void => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(val);
    };
    cancel.addEventListener("click", () => finish(null));
    manual.addEventListener("click", () => finish(null));

    const detector = new BD({ formats: ["qr_code"] });
    const tick = async (): Promise<void> => {
      if (done) return;
      try {
        const codes = await detector.detect(video);
        const hit = codes.find((c) => c.rawValue);
        if (hit) {
          finish(hit.rawValue);
          return;
        }
      } catch {
        /* transient decode error between frames — keep scanning */
      }
      raf = requestAnimationFrame(() => void tick());
    };
    void video.play().then(() => (raf = requestAnimationFrame(() => void tick())));
  });
}
