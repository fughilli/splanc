/**
 * "Connect debug server" flow — a camera viewfinder that auto-connects the moment
 * it recognises the server's QR (no button press), plus a chainlink button that
 * slides up a drawer for manual URL entry. It ONLY connects — the actions on the
 * connection (send/download) live in Settings ▸ Debugging.
 *
 * QR decoding uses jsQR (pure JS) rather than the native BarcodeDetector, because
 * iOS WKWebView — the primary target — doesn't implement BarcodeDetector. jsQR is
 * loaded lazily; if it can't load, the chainlink → URL path still works.
 */

import { connectDebugServer, debugServerUrl } from "../../net/debugServer";
import { isNativePlatform } from "../../net/native";
import { icon, toast } from "../kit";

type JsQRFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { inversionAttempts?: string },
) => { data: string } | null;

async function loadJsQR(): Promise<JsQRFn | null> {
  try {
    // @ts-ignore — jsqr is in the lockfile and bundled by the host build (vite);
    // it isn't installed in the dev container, so tsc can't resolve it here.
    const mod = await import("jsqr");
    const fn = (mod as unknown as { default?: JsQRFn }).default ?? (mod as unknown as JsQRFn);
    return typeof fn === "function" ? fn : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Open the connect overlay. Observe connection state via subscribeDebugServer. */
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
  hint.textContent = "Point at the debug-server QR";

  // Bottom bar: chainlink (manual URL) + cancel. Chainlink instead of a long
  // "Connect by URL" label.
  const bar = document.createElement("div");
  bar.className = "qrscan-bar";
  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "qrscan-btn qrscan-btn--icon";
  linkBtn.title = "Connect by URL";
  linkBtn.setAttribute("aria-label", "Connect by URL");
  linkBtn.append(icon("link"));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "qrscan-btn";
  cancel.textContent = "Cancel";
  bar.append(linkBtn, cancel);

  // Manual-URL drawer — a bottom sheet, hidden until the chainlink is tapped.
  const drawer = document.createElement("div");
  drawer.className = "dbgconn-drawer";
  const urlInput = document.createElement("input");
  urlInput.className = "dbgconn-input";
  urlInput.type = "url";
  urlInput.autocomplete = "off";
  urlInput.placeholder = "https://192.168.x.x:8093";
  urlInput.value = debugServerUrl();
  const drawerRow = document.createElement("div");
  drawerRow.className = "dbgconn-row";
  const urlGo = mkBtn("Connect");
  const urlBack = mkBtn("Back");
  drawerRow.append(urlBack, urlGo);
  drawer.append(urlInput, drawerRow);

  overlay.append(video, reticle, hint, bar, drawer);
  document.body.appendChild(overlay);

  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let connecting = false;

  const finish = (): void => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  };

  const openDrawer = (open: boolean): void => {
    drawer.classList.toggle("open", open);
    bar.style.display = open ? "none" : "flex";
    hint.textContent = open ? "Enter the server URL" : "Point at the debug-server QR";
    if (open) urlInput.focus();
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
    hint.textContent = drawer.classList.contains("open") ? "Enter the server URL" : "Point at the debug-server QR";
    toast(
      isNativePlatform()
        ? `Couldn't reach ${hostOf(u)} — check the URL and that the server is running.`
        : `Couldn't reach ${hostOf(u)} — open ${u}/ in a tab and accept the certificate, then retry.`,
      { error: true },
    );
  }

  cancel.addEventListener("click", finish);
  linkBtn.addEventListener("click", () => openDrawer(true));
  urlBack.addEventListener("click", () => openDrawer(false));
  urlGo.addEventListener("click", () => void attempt(urlInput.value));
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void attempt(urlInput.value);
  });

  // Camera + jsQR auto-scan. getUserMedia works on iOS; jsQR decodes there where
  // BarcodeDetector can't.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  if (typeof navigator.mediaDevices?.getUserMedia === "function") {
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(async (s) => {
        if (done) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        await video.play().catch(() => undefined);
        const jsQR = await loadJsQR();
        if (jsQR === null || ctx === null) {
          hint.textContent = "Tap the link button to enter the URL";
          return;
        }
        const scan = (): void => {
          if (done) return;
          if (!connecting && video.readyState >= 2 && video.videoWidth > 0) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            try {
              const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
                inversionAttempts: "attemptBoth",
              });
              if (code?.data) {
                void attempt(code.data);
              }
            } catch {
              /* transient — keep scanning */
            }
          }
          if (!done) timer = setTimeout(scan, 150);
        };
        scan();
      })
      .catch(() => {
        openDrawer(true);
      });
  } else {
    openDrawer(true);
  }
}

function mkBtn(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "qrscan-btn";
  b.textContent = label;
  return b;
}
