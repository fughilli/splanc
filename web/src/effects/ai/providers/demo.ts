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

export function makeDemoProvider(endpoint = DEMO_AI_ENDPOINT): AiProvider {
  return {
    id: "openai",
    capabilities: { tools: true, vision: true },
    async send(messages, opts) {
      const body = JSON.stringify({
        messages: latestDemoPreview(toOpenAiMessages(opts.system, messages)),
        tools: toOpenAiTools(opts.tools),
        max_tokens: Math.min(opts.maxTokens ?? 4000, 4000),
      });
      if (new TextEncoder().encode(body).byteLength > DEMO_REQUEST_BYTES) {
        throw new Error("This conversation has reached the free demo’s size limit. Start a new chat to continue; your effect is saved.");
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: opts.signal ?? null,
        body,
      });
      if (!response.ok) {
        if (response.status === 413) throw new Error("This conversation has reached the free demo’s size limit. Start a new chat to continue; your effect is saved.");
        if (response.status === 429) throw new Error("The free demo is busy or has reached its shared allowance. Please try again later, or use your own provider in Settings.");
        if (response.status === 503) throw new Error("Free demo AI is temporarily unavailable. You can still edit Code and Uniforms, or choose your own provider in Settings.");
        throw new Error(`The demo assistant could not complete this request (${response.status}). Please try again.`);
      }
      const json = await response.json();
      const choice = json.choices?.[0];
      if (!choice?.message || json.error) throw new Error("The demo assistant returned an incomplete response. Please try again.");
      return { content: fromOpenAiMessage(choice.message), stop_reason: finishReasonToStop(choice.finish_reason ?? "stop") };
    },
  };
}
