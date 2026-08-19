/**
 * "Connect debug server" — point the app at a developer's host-side debug server
 * (tools/browser_server.py, default HTTPS :8093) and ship device-side data there
 * to pull and analyse: the effects library (`curl http://<host>:8092/effects`)
 * or the FX-agent AI chat logs (`.../chatlogs`, for debugging failed requests).
 *
 * Cert trust: the server presents a self-signed cert (like a device). On iOS the
 * upload goes through the WssBridge cert bridge (net/debugServer → nativeHttp),
 * so it's trusted automatically — no manual step. In the browser PWA a self-signed
 * POST is blocked until the user opens the URL once and accepts the cert; the
 * "Open server to accept cert" button (shown only on the web) does that. Chat logs
 * can also be downloaded as JSON when there's no server handy. URL is remembered
 * in localStorage (net/debugServer), filled by typing or scanning the server QR.
 */

import { effectStore } from "../../store/effectStore";
import { chatLogStore } from "../../store/chatLogStore";
import { debugServerUrl, setDebugServerUrl, postJson } from "../../net/debugServer";
import { isNativePlatform } from "../../net/native";
import { Button, Sheet, toast } from "../kit";

/** Trigger a client-side file download (fallback when there's no debug server —
 * e.g. debugging from the phone alone; the JSON can then be AirDropped/shared). */
function downloadJson(name: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open the "Connect debug server" sheet. `prefillUrl` (e.g. from a scanned QR)
 * overrides the remembered URL. */
export function openDebugServerSheet(prefillUrl?: string): void {
  const sheet = Sheet("Connect debug server");
  sheet.body.className = "aikey-sheet";
  const native = isNativePlatform();

  const input = document.createElement("input");
  input.className = "sheet-input";
  input.type = "url";
  input.autocomplete = "off";
  input.placeholder = "https://192.168.x.x:8093";
  input.value = prefillUrl ?? debugServerUrl();
  if (prefillUrl) setDebugServerUrl(prefillUrl);

  const note = document.createElement("p");
  note.className = "aikey-note";
  note.textContent = native
    ? "Enter (or scan) the debug server's HTTPS URL. Its self-signed certificate " +
      "is trusted automatically on this device — just send. Ship your effects " +
      "library (source only) or the AI chat logs (FX-agent transcripts, for " +
      "debugging failed requests), or download the logs."
    : "Enter the debug server's HTTPS URL. First open it once in a browser tab and " +
      "accept the certificate warning (it's self-signed), otherwise the upload is " +
      "blocked. Ship your effects library (source only) or the AI chat logs (the " +
      "FX-agent transcripts, for debugging failed requests) — or download the logs.";

  const base = (): string => input.value.trim().replace(/\/+$/, "");

  // Browser only: the manual cert-accept round-trip. On native the bridge trusts
  // the cert, so this step is unnecessary.
  const openCert = Button({
    label: "Open server to accept cert",
    icon: "link",
    variant: "quiet",
    block: true,
    onClick: () => {
      const b = base();
      if (!b) {
        toast("Enter the server URL first", { error: true });
        return;
      }
      setDebugServerUrl(b);
      window.open(b + "/", "_blank", "noopener");
    },
  });

  const send = Button({
    label: "Send effects library",
    icon: "effect-to-device",
    block: true,
    onClick: () => void doSendEffects(),
  });

  const sendLogs = Button({
    label: "Send AI chat logs",
    icon: "sparkles",
    block: true,
    onClick: () => void doSendChatLogs(),
  });

  const downloadLogs = Button({
    label: "Download AI chat logs",
    icon: "download",
    variant: "quiet",
    block: true,
    onClick: () => void doDownloadChatLogs(),
  });

  /** POST a JSON payload to `<base><path>` (via the native cert bridge or fetch),
   * with shared cert/mixed-content error handling. Returns the parsed JSON, or
   * null on failure (a toast is shown). */
  async function post(path: string, payload: unknown): Promise<Record<string, unknown> | null> {
    const b = base();
    if (!b) {
      toast("Enter the server URL first", { error: true });
      return null;
    }
    setDebugServerUrl(b);
    try {
      const res = await postJson(b, path, payload);
      if (!res.ok) {
        toast(`Server ${res.status}: ${await res.text()}`, { error: true });
        return null;
      }
      return JSON.parse(await res.text()) as Record<string, unknown>;
    } catch (e) {
      // On the web this is almost always a mixed-content / untrusted-cert block,
      // which surfaces as a generic TypeError with no useful detail.
      const hint = native
        ? `Upload failed — is the server reachable at ${b}? (${e instanceof Error ? e.message : e})`
        : `Upload blocked — open ${b}/ in a tab and accept the certificate first, then retry. (${
            e instanceof Error ? e.message : e
          })`;
      toast(hint, { error: true });
      return null;
    }
  }

  async function doSendEffects(): Promise<void> {
    const effects = await effectStore.list();
    const j = await post("/effects", {
      exportedAt: new Date().toISOString(),
      count: effects.length,
      userAgent: navigator.userAgent,
      effects,
    });
    if (!j) return;
    toast(`Sent ${(j.effects as number) ?? effects.length} effects (${(j.bytes as number) ?? "?"} bytes)`);
    sheet.close();
  }

  async function doSendChatLogs(): Promise<void> {
    const sessions = await chatLogStore.list();
    if (sessions.length === 0) {
      toast("No AI chat logs yet — run the FX agent first", { error: true });
      return;
    }
    const j = await post("/chatlogs", {
      exportedAt: new Date().toISOString(),
      count: sessions.length,
      userAgent: navigator.userAgent,
      sessions,
    });
    if (!j) return;
    toast(`Sent ${(j.sessions as number) ?? sessions.length} chat sessions (${(j.bytes as number) ?? "?"} bytes)`);
    sheet.close();
  }

  async function doDownloadChatLogs(): Promise<void> {
    const sessions = await chatLogStore.list();
    if (sessions.length === 0) {
      toast("No AI chat logs yet — run the FX agent first", { error: true });
      return;
    }
    downloadJson(`ledmapper-chatlogs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, {
      exportedAt: new Date().toISOString(),
      count: sessions.length,
      userAgent: navigator.userAgent,
      sessions,
    });
    toast(`Downloaded ${sessions.length} chat session(s)`);
  }

  sheet.body.append(input, note);
  if (!native) sheet.body.append(openCert);
  sheet.body.append(send, sendLogs, downloadLogs);
  input.focus();
}
