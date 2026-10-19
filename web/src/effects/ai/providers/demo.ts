/** Public demo uses the server-held free-model key; BYOK preferences stay intact. */
import type { AiProvider } from "../provider";
import { toOpenAiMessages, toOpenAiTools, fromOpenAiMessage, finishReasonToStop } from "./openaiCompat";

export const DEMO_AI_ENDPOINT = "https://splanc.pages.dev/api/demo-ai/chat/completions";

export function makeDemoProvider(endpoint = DEMO_AI_ENDPOINT): AiProvider {
  return {
    id: "openai",
    capabilities: { tools: true, vision: true },
    async send(messages, opts) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: opts.signal ?? null,
        body: JSON.stringify({
          messages: toOpenAiMessages(opts.system, messages),
          tools: toOpenAiTools(opts.tools),
          max_tokens: Math.min(opts.maxTokens ?? 4000, 4000),
        }),
      });
      if (!response.ok) {
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
