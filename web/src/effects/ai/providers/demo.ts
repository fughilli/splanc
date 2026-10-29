/** Public demo uses the server-held free-model key; BYOK preferences stay intact. */
import type { AiProvider } from "../provider";
import { toOpenAiMessages, toOpenAiTools, fromOpenAiMessage, finishReasonToStop } from "./openaiCompat";
import type { OaiMessage } from "./openaiCompat";

export const DEMO_AI_ENDPOINT = "https://splanc.pages.dev/api/demo-ai/chat/completions";

const DEMO_REQUEST_BYTES = 2 * 1024 * 1024;
const DEMO_PREVIEW_CHARS = 256 * 1024;

/** Keep the latest view, preserving tool results and all textual conversation. */
export function latestDemoPreview(messages: OaiMessage[]): OaiMessage[] {
  let newestMessage = -1, newestPart = -1;
  messages.forEach((message, i) => {
    if (Array.isArray(message.content)) message.content.forEach((part, j) => {
      if (part.type === "image_url") { newestMessage = i; newestPart = j; }
    });
  });
  return messages.map((message, i) => !Array.isArray(message.content) ? message : ({
    ...message,
    content: message.content.map((part, j) => part.type === "image_url" && (i !== newestMessage || j !== newestPart)
      ? { type: "text" as const, text: "[Earlier preview omitted; the latest preview is attached below.]" } : part),
  }));
}

/** Bound vision uploads regardless of screen size, pixel density or image detail. */
export function captureDemoPreview(source: HTMLCanvasElement): string {
  const image = document.createElement("canvas");
  let scale = Math.min(1, 960 / Math.max(source.width, source.height));
  for (let attempt = 0; attempt < 10; attempt++, scale *= 0.75) {
    image.width = Math.max(1, Math.round(source.width * scale));
    image.height = Math.max(1, Math.round(source.height * scale));
    const ctx = image.getContext("2d");
    if (!ctx) throw new Error("Preview capture is unavailable in this browser.");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, image.width, image.height);
    ctx.drawImage(source, 0, 0, image.width, image.height);
    const data = image.toDataURL("image/jpeg", 0.76);
    if (data.length <= DEMO_PREVIEW_CHARS) return data;
  }
  throw new Error("The preview could not be reduced to the demo image limit.");
}

/** Why a free-demo request failed, so a caller can offer a friendly fallback
 * (Acid play mode points visitors at the presets) instead of a raw error. */
export type DemoAiFailure = "busy" | "unavailable" | "size" | "timeout" | "other";

export class DemoAiError extends Error {
  constructor(message: string, readonly kind: DemoAiFailure, readonly retryAfterS?: number) {
    super(message);
    this.name = "DemoAiError";
  }
}

/** The free demo is out of capacity for now (quota, rate limit, every model down
 * or too slow): the visitor should try a preset rather than keep asking. */
export function isDemoAiBusy(e: unknown): e is DemoAiError {
  return e instanceof DemoAiError && (e.kind === "busy" || e.kind === "unavailable" || e.kind === "timeout");
}

export interface DemoProviderOptions {
  /** Client-side deadline per request (ms). The relay has its own deadline; this
   * one bounds how long a visitor stares at "thinking" on a bad cellular link. */
  timeoutMs?: number;
  /** Cap on output tokens (the relay caps at 4000). */
  maxTokens?: number;
  /** Advertise vision (capture_preview). Play mode turns it off: each capture is
   * an extra request against the shared quota. */
  vision?: boolean;
}

const SIZE_MESSAGE = "This conversation has reached the free demo’s size limit. Start a new chat to continue; your effect is saved.";

export function makeDemoProvider(endpoint = DEMO_AI_ENDPOINT, options: DemoProviderOptions = {}): AiProvider {
  const cap = Math.min(options.maxTokens ?? 4000, 4000);
  return {
    id: "openai",
    capabilities: { tools: true, vision: options.vision ?? true },
    async send(messages, opts) {
      const body = JSON.stringify({
        messages: latestDemoPreview(toOpenAiMessages(opts.system, messages)),
        tools: toOpenAiTools(opts.tools),
        max_tokens: Math.min(opts.maxTokens ?? cap, cap),
      });
      if (new TextEncoder().encode(body).byteLength > DEMO_REQUEST_BYTES) {
        throw new DemoAiError(SIZE_MESSAGE, "size");
      }
      // Combine the caller's cancel with our own deadline (AbortSignal.any is
      // missing on older Safari, so wire it by hand).
      const ctl = new AbortController();
      const outer = opts.signal;
      const onAbort = (): void => ctl.abort();
      if (outer?.aborted) ctl.abort();
      else outer?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = options.timeoutMs !== undefined
        ? setTimeout(() => { timedOut = true; ctl.abort(); }, options.timeoutMs) : undefined;
      try {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: ctl.signal,
            body,
          });
        } catch (e) {
          if (timedOut) throw new DemoAiError("The free AI took too long to answer.", "timeout");
          if (outer?.aborted) throw e;
          throw new DemoAiError("Couldn’t reach the free AI — check your connection and try again.", "unavailable");
        }
        if (!response.ok) {
          const retry = Number(response.headers.get("retry-after"));
          const retryAfterS = Number.isFinite(retry) && retry > 0 ? retry : undefined;
          if (response.status === 413) throw new DemoAiError(SIZE_MESSAGE, "size");
          if (response.status === 429) throw new DemoAiError("The free demo is busy or has reached its shared allowance. Please try again later, or use your own provider in Settings.", "busy", retryAfterS);
          if (response.status === 503) throw new DemoAiError("Free demo AI is temporarily unavailable. You can still edit Code and Uniforms, or choose your own provider in Settings.", "unavailable", retryAfterS);
          if (response.status === 504) throw new DemoAiError("The free AI took too long to answer.", "timeout");
          throw new DemoAiError(`The demo assistant could not complete this request (${response.status}). Please try again.`, "other");
        }
        let json: { choices?: { message?: unknown; finish_reason?: string }[]; error?: unknown };
        try { json = await response.json(); } catch (e) {
          if (timedOut) throw new DemoAiError("The free AI took too long to answer.", "timeout");
          throw e;
        }
        const choice = json.choices?.[0];
        if (!choice?.message || json.error) throw new DemoAiError("The demo assistant returned an incomplete response. Please try again.", "other");
        return { content: fromOpenAiMessage(choice.message as OaiMessage), stop_reason: finishReasonToStop(choice.finish_reason ?? "stop") };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
      }
    },
  };
}
