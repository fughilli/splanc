/**
 * Debug: ship device-side data to a host-side debug server (the
 * `tools/browser_server.py` HTTPS listener, default :8093) so a developer can
 * pull and analyse it — the effects library (`curl http://<host>:8092/effects`)
 * or the FX-agent AI chat logs (`.../chatlogs`, for debugging why the agent
 * failed a request). HTTPS is required because the app is served over https and
 * browsers block a POST to a plain-http LAN server (mixed content) — the server
 * auto-generates a self-signed cert the user accepts once, exactly like the
 * device cert. The chat logs can also be downloaded as JSON when there's no
 * server handy. The server URL is remembered in localStorage.
 */

import { effectStore } from "../../store/effectStore";
import { chatLogStore } from "../../store/chatLogStore";
import { Button, Sheet, toast } from "../kit";

const URL_KEY = "ledmapper.debugServer";

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

/** Open the "send effects library to debug server" sheet. `prefillUrl` (e.g.
 * from a scanned QR) overrides the remembered URL. */
export function openDebugServerSheet(prefillUrl?: string): void {
  const sheet = Sheet("Send to debug server");
  sheet.body.className = "aikey-sheet";

  const input = document.createElement("input");
  input.className = "sheet-input";
  input.type = "url";
  input.autocomplete = "off";
  input.placeholder = "https://192.168.x.x:8093";
  input.value = prefillUrl ?? localStorage.getItem(URL_KEY) ?? "";
  if (prefillUrl) localStorage.setItem(URL_KEY, prefillUrl.replace(/\/+$/, ""));

  const note = document.createElement("p");
  note.className = "aikey-note";
  note.textContent =
    "Enter the debug server's HTTPS URL. First open it once in a browser tab and " +
    "accept the certificate warning (it's self-signed), otherwise the upload is " +
    "blocked. Send your effects library (source only) or the AI chat logs (the " +
    "FX-agent transcripts, for debugging failed requests) — or download the logs.";

  const base = (): string => input.value.trim().replace(/\/+$/, "");

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
      localStorage.setItem(URL_KEY, b);
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

  /** POST a JSON payload to `<base><path>`, with the shared cert/mixed-content
   * error handling. Returns true on success. */
  async function post(path: string, payload: unknown): Promise<Response | null> {
    const b = base();
    if (!b) {
      toast("Enter the server URL first", { error: true });
      return null;
    }
    localStorage.setItem(URL_KEY, b);
    try {
      const res = await fetch(b + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast(`Server ${res.status}: ${await res.text()}`, { error: true });
        return null;
      }
      return res;
    } catch (e) {
      // Almost always a mixed-content / untrusted-cert block, which surfaces as a
      // generic TypeError with no useful detail.
      toast(
        `Upload blocked — open ${b}/ in a tab and accept the certificate first, then retry. (${
          e instanceof Error ? e.message : e
        })`,
        { error: true },
      );
      return null;
    }
  }

  async function doSendEffects(): Promise<void> {
    const effects = await effectStore.list();
    const res = await post("/effects", {
      exportedAt: new Date().toISOString(),
      count: effects.length,
      userAgent: navigator.userAgent,
      effects,
    });
    if (!res) return;
    const j = (await res.json()) as { effects?: number; bytes?: number };
    toast(`Sent ${j.effects ?? effects.length} effects (${j.bytes ?? "?"} bytes)`);
    sheet.close();
  }

  async function doSendChatLogs(): Promise<void> {
    const sessions = await chatLogStore.list();
    if (sessions.length === 0) {
      toast("No AI chat logs yet — run the FX agent first", { error: true });
      return;
    }
    const res = await post("/chatlogs", {
      exportedAt: new Date().toISOString(),
      count: sessions.length,
      userAgent: navigator.userAgent,
      sessions,
    });
    if (!res) return;
    const j = (await res.json()) as { sessions?: number; bytes?: number };
    toast(`Sent ${j.sessions ?? sessions.length} chat sessions (${j.bytes ?? "?"} bytes)`);
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

  sheet.body.append(input, note, openCert, send, sendLogs, downloadLogs);
  input.focus();
}
