/**
 * Debug: ship the whole effects library to a host-side debug server (the
 * `tools/browser_server.py` HTTPS listener, default :8093), so a developer can
 * pull and analyse the user's custom effects (e.g. a slow one) with
 * `curl http://<host>:8092/effects`. HTTPS is required because the app is served
 * over https and browsers block a POST to a plain-http LAN server (mixed content)
 * — the server auto-generates a self-signed cert the user accepts once, exactly
 * like the device cert. The server URL is remembered in localStorage.
 */

import { effectStore } from "../../store/effectStore";
import { Button, Sheet, toast } from "../kit";

const URL_KEY = "ledmapper.debugServer";

/** Open the "send effects library to debug server" sheet. `prefillUrl` (e.g.
 * from a scanned QR) overrides the remembered URL. */
export function openDebugServerSheet(prefillUrl?: string): void {
  const sheet = Sheet("Send effects to debug server");
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
    "blocked. Your whole effects library (source only) is sent for debugging.";

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
    label: "Send library",
    icon: "effect-to-device",
    block: true,
    onClick: () => void doSend(),
  });

  async function doSend(): Promise<void> {
    const b = base();
    if (!b) {
      toast("Enter the server URL first", { error: true });
      return;
    }
    localStorage.setItem(URL_KEY, b);
    try {
      const effects = await effectStore.list();
      const payload = {
        exportedAt: new Date().toISOString(),
        count: effects.length,
        userAgent: navigator.userAgent,
        effects,
      };
      const res = await fetch(b + "/effects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast(`Server ${res.status}: ${await res.text()}`, { error: true });
        return;
      }
      const j = (await res.json()) as { effects?: number; bytes?: number };
      toast(`Sent ${j.effects ?? effects.length} effects (${j.bytes ?? "?"} bytes)`);
      sheet.close();
    } catch (e) {
      // Almost always a mixed-content / untrusted-cert block, which surfaces as a
      // generic TypeError with no useful detail.
      toast(
        `Upload blocked — open ${b}/ in a tab and accept the certificate first, then retry. (${
          e instanceof Error ? e.message : e
        })`,
        { error: true },
      );
    }
  }

  sheet.body.append(input, note, openCert, send);
  input.focus();
}
