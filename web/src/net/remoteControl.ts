/**
 * DEBUG-SESSION remote control: lets the debugging container drive the app end to
 * end without the user tapping anything — open a workspace, load/unload/switch a
 * model, tweak config, and run prompts — by polling the debug server's /cmd queue
 * (tools/browser_server.py) and dispatching. Results + errors go back to /dbg (and
 * the console, which the dev server forwards to the container).
 *
 * Starts at boot whenever a debug server URL is configured (no separate toggle),
 * so infra commands (nav / model) work from any screen; `prompt`/`newchat` need a
 * chat surface, which registers itself via setActiveChat().
 *
 * This is debug scaffolding, not a product feature.
 */

import { debugServerUrl, getJson, shipDbg } from "./debugServer";
import { getAiConfig, updateAiConfig } from "../effects/ai/provider";
import { loadWllamaModel, unloadWllamaModel } from "../effects/ai/providers/wllama";
import { effectStore } from "../store/effectStore";
import { toast } from "../ui/kit";

interface Nav {
  navigate: (path: string) => void;
}
interface ChatSurface {
  submit: (text: string) => Promise<void> | void;
  newChat: () => void;
}

let nav: Nav | null = null;
let activeChat: ChatSurface | null = null;
let polling = false;

/** The on-screen chat registers itself so `prompt`/`newchat` commands can run. */
export function setActiveChat(s: ChatSurface | null): void {
  activeChat = s;
}

/** Start polling the debug server's /cmd queue (idempotent). */
export function startRemoteControl(router: Nav): void {
  nav = router;
  if (polling) return;
  polling = true;
  void loop();
}

function done(msg: string, extra?: Record<string, unknown>): void {
  shipDbg({ kind: "cmd", msg, ...(extra ?? {}) });
}

async function dispatch(cmd: Record<string, unknown>): Promise<void> {
  const type = String(cmd["type"] ?? "");
  try {
    if (type === "nav" || type === "openEffect") {
      const path = type === "openEffect" ? `/effects/edit/${String(cmd["id"])}` : String(cmd["path"]);
      nav?.navigate(path);
      done("nav " + path);
    } else if (type === "prompt") {
      if (!activeChat) return done("prompt: no chat surface (open an effect first)");
      const text = String(cmd["text"] ?? "");
      done("prompt start", { text: text.slice(0, 80) });
      await activeChat.submit(text);
      done("prompt done");
    } else if (type === "newchat") {
      activeChat?.newChat();
      done("newchat");
    } else if (type === "grammar") {
      // Toggle the DEBUG grammar-constrained wllama sampling (see wllama.ts).
      if (cmd["on"]) localStorage.setItem("wllama.grammar", "envelope");
      else localStorage.removeItem("wllama.grammar");
      done(`grammar=${cmd["on"] ? "envelope" : "off"}`);
    } else if (type === "config") {
      updateAiConfig(cmd["patch"] as Parameters<typeof updateAiConfig>[0]);
      done("config updated");
    } else if (type === "setWllama") {
      const w = getAiConfig().wllama;
      updateAiConfig({
        wllama: {
          ...w,
          ...(cmd["url"] != null ? { model: String(cmd["url"]) } : {}),
          ...(cmd["ctx"] != null ? { contextWindowSize: Number(cmd["ctx"]) } : {}),
          ...(cmd["threads"] != null ? { nThreads: Number(cmd["threads"]) } : {}),
        },
      });
      done("wllama config set", { wllama: getAiConfig().wllama });
    } else if (type === "loadModel") {
      const w = getAiConfig().wllama;
      updateAiConfig({
        wllama: {
          ...w,
          ...(cmd["url"] != null ? { model: String(cmd["url"]) } : {}),
          ...(cmd["ctx"] != null ? { contextWindowSize: Number(cmd["ctx"]) } : {}),
          ...(cmd["threads"] != null ? { nThreads: Number(cmd["threads"]) } : {}),
        },
      });
      const c = getAiConfig().wllama;
      done("loadModel start", { model: c.model.split("/").pop(), ctx: c.contextWindowSize });
      await loadWllamaModel(c.model, c.contextWindowSize, c.nThreads);
      done("loadModel done");
    } else if (type === "unloadModel") {
      await unloadWllamaModel();
      done("unloaded");
    } else if (type === "reload") {
      done("reloading");
      location.reload();
    } else if (type === "status") {
      const cfg = getAiConfig();
      done("status", {
        cfgKind: cfg.kind,
        wllama: cfg.wllama,
        grammar: localStorage.getItem("wllama.grammar") ?? "off",
        isolated:
          typeof globalThis !== "undefined" &&
          (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
        hasChat: activeChat !== null,
        path: location.hash,
      });
    } else if (type === "listEffects") {
      const list = (await effectStore.list()).map((e) => ({ id: e.id, name: e.name }));
      done("effects", { count: list.length, effects: list.slice(0, 40) });
    } else {
      done("unknown cmd: " + type);
    }
  } catch (e) {
    done("cmd error", { type, error: e instanceof Error ? e.message : String(e) });
  }
}

async function loop(): Promise<void> {
  if (!polling) return;
  const base = debugServerUrl();
  if (base) {
    try {
      const res = await getJson(base, "/cmd");
      if (res.ok) {
        const body = await res.text();
        const cmd = body ? (JSON.parse(body) as Record<string, unknown>) : null;
        if (cmd && cmd["type"]) {
          toast(`Remote cmd: ${String(cmd["type"])}`);
          await dispatch(cmd);
        }
      }
    } catch {
      // server unreachable / cert — keep polling
    }
  }
  if (polling) setTimeout(() => void loop(), 1500);
}
