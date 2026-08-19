/**
 * Remote chat drive — replay a failing FX-agent conversation ON THE DEVICE
 * without the user retyping it. The agent enqueues prompts on the debug server
 * (`POST /chatcmd {"text": ...}`); when "Drive chat from debug server" is on
 * (Settings ▸ Debugging) and a chat screen is open, the app polls `GET /chatcmd`
 * and feeds each prompt into that screen's FX-agent chat, exactly as if typed.
 *
 * The active chat surface (effectEditor / acidMode) registers a driver on mount
 * and unregisters on unmount, so prompts only run while a chat is on-screen —
 * otherwise they wait in the server queue. Polling uses the same cert-trusting
 * transport as the rest of the debug-server traffic (net/debugServer).
 */

import { debugServerUrl, getJson } from "./debugServer";
import { toast } from "../ui/kit";

/** Runs one prompt through the on-screen FX-agent chat (resolves when done). */
export type ChatDriver = (text: string) => Promise<void> | void;

const ENABLED_KEY = "ledmapper.remoteChat";
const POLL_MS = 2000;

let driver: ChatDriver | null = null;
let polling = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function remoteChatEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "1";
}

export function setRemoteChatEnabled(on: boolean): void {
  if (on) localStorage.setItem(ENABLED_KEY, "1");
  else localStorage.removeItem(ENABLED_KEY);
  if (on) startPolling();
  else stopPolling();
}

/** Register the on-screen chat's submit function. Returns an unregister to call
 * on unmount. Polling only runs while a driver is registered AND the toggle is
 * on AND a debug server is configured. */
export function registerChatDriver(fn: ChatDriver): () => void {
  driver = fn;
  startPolling();
  return () => {
    if (driver === fn) driver = null;
    stopPolling();
  };
}

function startPolling(): void {
  if (polling || driver === null || !remoteChatEnabled()) return;
  polling = true;
  void loop();
}

function stopPolling(): void {
  polling = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function loop(): Promise<void> {
  if (!polling) return;
  const base = debugServerUrl();
  if (base && driver !== null && remoteChatEnabled()) {
    try {
      const res = await getJson(base, "/chatcmd");
      if (res.ok) {
        const body = await res.text();
        const cmd = body ? (JSON.parse(body) as { text?: unknown }) : null;
        if (cmd && typeof cmd.text === "string" && cmd.text && driver !== null) {
          toast(`Remote: ${cmd.text.slice(0, 60)}`);
          // Await the whole turn before polling again, so commands replay in
          // order and never overlap a running turn.
          await driver(cmd.text);
        }
      }
    } catch {
      // Server unreachable / cert not trusted — keep polling; it may come back.
    }
  }
  if (polling) timer = setTimeout(() => void loop(), POLL_MS);
}
