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

import {
  connectDebugServerDiagnosed,
  debugServerUrl,
  normalizeDebugServerUrl,
  type DebugServerProbe,
} from "../../net/debugServer";
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

const HINT_SCAN = "Point at the debug-server QR";
const HINT_URL = "Enter the server URL";
const HINT_FAILED = "Retry, change the URL, or scan a different QR";
const HINT_NOT_SERVER = "That QR isn't a debug-server URL — point at the server's QR";

/** User-facing explanation of a failed connect. Honest about what is known: a
 * browser fetch failure can't tell an untrusted certificate from an unreachable
 * host, so it names both and offers the health check that tells them apart. */
export function describeConnectFailure(
  r: Extract<DebugServerProbe, { ok: false }>,
  native: boolean,
): { title: string; detail: string; healthCheck: boolean } {
  const host = hostOf(r.url);
  switch (r.kind) {
    case "invalid-url":
      return {
        title: "Not a server URL",
        detail: "Enter the full address, e.g. https://192.168.1.20:8093.",
        healthCheck: false,
      };
    case "mixed-content":
      return {
        title: `Can't use http:// from this page`,
        detail:
          "The app is served over https, so the browser blocks requests to an http:// server. " +
          "Use the server's https:// URL.",
        healthCheck: false,
      };
    case "timeout":
      return {
        title: `No answer from ${host}`,
        detail:
          "The request timed out. Check that the phone is on the same network as the server " +
          "(not cellular / a guest Wi-Fi / VPN) and that the server is running.",
        healthCheck: !native,
      };
    case "http":
      return {
        title: `${host} answered with HTTP ${r.status ?? "error"}`,
        detail: "Something answered, but not as the debug server. Check the port and that it's tools/browser_server.py.",
        healthCheck: false,
      };
    case "network":
    case "cancelled":
    default:
      return native
        ? {
            title: `Couldn't reach ${host}`,
            detail: "Check the URL, that the phone is on the server's network, and that the server is running.",
            healthCheck: false,
          }
        : {
            title: `Couldn't reach ${host}`,
            detail:
              "The browser didn't say why. Either its self-signed certificate isn't trusted yet, or the " +
              "phone can't reach that address. Open the health check: if it asks about the certificate, " +
              "accept it and tap Retry; if it doesn't load at all, it's the network or the server.",
            healthCheck: true,
          };
  }
}

/** Test seams: the QR decoder loader, the connect call and the camera. */
export interface DebugServerConnectDeps {
  loadDecoder?: () => Promise<JsQRFn | null>;
  connect?: typeof connectDebugServerDiagnosed;
  getUserMedia?: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null;
  native?: boolean;
  /** Scan tick period, ms. */
  scanMs?: number;
}

export interface DebugServerConnectHandle {
  overlay: HTMLElement;
  /** Close the sheet (same as Cancel). Idempotent. */
  close(): void;
  readonly closed: boolean;
}

/** Open the connect overlay. Observe connection state via subscribeDebugServer.
 *
 * Retry policy (#454): a scanned URL is tried once. If it fails, that exact
 * payload is suppressed while it stays in (or returns to) the viewfinder — no
 * automatic re-attempts — and a stable panel explains the failure with
 * explicit Retry / Change URL actions. A *different* QR is still tried at
 * once. Cancel during a pending attempt aborts it; nothing (DOM or toast)
 * happens after the sheet is closed. */
export function openDebugServerConnect(deps: DebugServerConnectDeps = {}): DebugServerConnectHandle {
  const connect = deps.connect ?? connectDebugServerDiagnosed;
  const native = deps.native ?? isNativePlatform();
  const scanMs = deps.scanMs ?? 150;
  const getUserMedia =
    deps.getUserMedia !== undefined
      ? deps.getUserMedia
      : typeof navigator.mediaDevices?.getUserMedia === "function"
        ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
        : null;

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
  hint.textContent = HINT_SCAN;
  hint.setAttribute("aria-live", "polite");

  // Failure panel: stable guidance after a failed attempt (replaces the old
  // per-attempt error toast). Hidden until a failure.
  const fail = document.createElement("div");
  fail.className = "dbgconn-fail";
  fail.hidden = true;
  fail.setAttribute("role", "alert");
  const failTitle = document.createElement("div");
  failTitle.className = "dbgconn-fail-title";
  const failDetail = document.createElement("div");
  failDetail.className = "dbgconn-fail-detail";
  const failActions = document.createElement("div");
  failActions.className = "dbgconn-row dbgconn-fail-actions";
  const healthLink = document.createElement("a");
  healthLink.className = "qrscan-btn dbgconn-health";
  healthLink.target = "_blank";
  healthLink.rel = "noopener";
  healthLink.textContent = "Open health check";
  const retryBtn = mkBtn("Retry");
  retryBtn.classList.add("dbgconn-retry");
  const changeBtn = mkBtn("Change URL");
  changeBtn.classList.add("dbgconn-change");
  failActions.append(healthLink, changeBtn, retryBtn);
  fail.append(failTitle, failDetail, failActions);

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
  cancel.className = "qrscan-btn dbgconn-cancel";
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
  urlGo.classList.add("dbgconn-go");
  const urlBack = mkBtn("Back");
  drawerRow.append(urlBack, urlGo);
  drawer.append(urlInput, drawerRow);

  overlay.append(video, reticle, hint, fail, bar, drawer);
  document.body.appendChild(overlay);

  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let connecting = false;
  let pending: AbortController | null = null;
  /** The last URL that failed — the scanner won't auto-retry it. */
  let failedUrl: string | null = null;
  /** Last decoded payload that isn't a URL (shown once, not re-processed). */
  let ignoredPayload: string | null = null;

  const finish = (): void => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending?.abort();
    pending = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    overlay.remove();
  };

  const restingHint = (): string => (drawer.classList.contains("open") ? HINT_URL : failedUrl ? HINT_FAILED : HINT_SCAN);

  const setBusy = (busy: boolean): void => {
    retryBtn.disabled = busy;
    urlGo.disabled = busy;
    changeBtn.disabled = busy;
  };

  const openDrawer = (open: boolean): void => {
    drawer.classList.toggle("open", open);
    bar.style.display = open ? "none" : "flex";
    if (!connecting) hint.textContent = restingHint();
    if (open) urlInput.focus();
  };

  const showFailure = (r: Extract<DebugServerProbe, { ok: false }>): void => {
    const d = describeConnectFailure(r, native);
    failTitle.textContent = d.title;
    failDetail.textContent = d.detail;
    const health = d.healthCheck ? normalizeDebugServerUrl(r.url) : null;
    if (health !== null) {
      healthLink.href = health + "/ping";
      healthLink.hidden = false;
    } else {
      healthLink.removeAttribute("href");
      healthLink.hidden = true;
    }
    retryBtn.hidden = r.kind === "invalid-url" || r.kind === "mixed-content";
    fail.hidden = false;
  };

  async function attempt(raw: string): Promise<void> {
    if (done || connecting) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    connecting = true;
    setBusy(true);
    hint.textContent = `Connecting to ${hostOf(trimmed)}…`;
    const ctl = new AbortController();
    pending = ctl;
    let r: DebugServerProbe;
    try {
      r = await connect(trimmed, { signal: ctl.signal });
    } catch (e) {
      r = { ok: false, url: trimmed, kind: "network", detail: e instanceof Error ? e.message : String(e) };
    }
    // The sheet may have been dismissed (or the attempt superseded) while we
    // waited: no DOM changes, no toasts after that.
    if (done || pending !== ctl || ctl.signal.aborted) return;
    pending = null;
    connecting = false;
    setBusy(false);
    if (r.ok) {
      toast(`Connected to ${hostOf(r.url)}`);
      finish();
      return;
    }
    failedUrl = normalizeDebugServerUrl(r.url) ?? r.url;
    showFailure(r);
    hint.textContent = restingHint();
  }

  /** Handle one decoded QR payload from the scanner. Exported via the scan
   * loop only; the policy is: non-URL → say so, don't connect; the URL that
   * just failed → ignore (explicit Retry only); anything else → attempt. */
  const onDecoded = (payload: string): void => {
    if (connecting || done) return;
    const url = normalizeDebugServerUrl(payload);
    if (url === null) {
      if (ignoredPayload !== payload) {
        ignoredPayload = payload;
        if (!drawer.classList.contains("open")) hint.textContent = HINT_NOT_SERVER;
      }
      return;
    }
    if (url === failedUrl) return;
    ignoredPayload = null;
    void attempt(url);
  };

  cancel.addEventListener("click", finish);
  linkBtn.addEventListener("click", () => openDrawer(true));
  urlBack.addEventListener("click", () => openDrawer(false));
  urlGo.addEventListener("click", () => void attempt(urlInput.value));
  urlInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void attempt(urlInput.value);
  });
  retryBtn.addEventListener("click", () => {
    if (failedUrl !== null) void attempt(failedUrl);
  });
  changeBtn.addEventListener("click", () => {
    if (failedUrl !== null) urlInput.value = failedUrl;
    openDrawer(true);
  });

  // Camera + jsQR auto-scan. getUserMedia works on iOS; jsQR decodes there where
  // BarcodeDetector can't.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  const loadDecoder = deps.loadDecoder ?? loadJsQR;

  if (getUserMedia !== null) {
    getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(async (s) => {
        if (done) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        await video.play().catch(() => undefined);
        const jsQR = await loadDecoder();
        if (done) return;
        if (jsQR === null || ctx === null) {
          hint.textContent = "Tap the link button to enter the URL";
          return;
        }
        const scan = (): void => {
          timer = null;
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
              if (code?.data) onDecoded(code.data);
            } catch {
              /* transient — keep scanning */
            }
          }
          if (!done) timer = setTimeout(scan, scanMs);
        };
        scan();
      })
      .catch(() => {
        if (!done) openDrawer(true);
      });
  } else {
    openDrawer(true);
  }

  return {
    overlay,
    close: finish,
    get closed() {
      return done;
    },
  };
}

function mkBtn(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "qrscan-btn";
  b.textContent = label;
  return b;
}
