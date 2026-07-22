/**
 * BYO AI key onboarding — a bottom Sheet with a masked input to paste/save/clear
 * the Anthropic API key. This is the DISCOVERABLE surface for the key that used
 * to be buried in the editor's AI panel: it's opened from the effects browser
 * (an "AI key" app-bar/settings affordance) and from the editor's first-run
 * hint. The key lives in localStorage via generate.ts's get/setApiKey.
 */

import { getApiKey, setApiKey } from "../../effects/ai/generate";
import { Button, Sheet, toast } from "../kit";

/** Open the AI-key sheet. `onChange` fires after save/clear so callers can
 * refresh any "key set?" affordance. */
export function openAiKeySheet(onChange?: () => void): void {
  const sheet = Sheet("Anthropic API key");
  sheet.body.className = "aikey-sheet";

  const status = document.createElement("div");
  status.className = "aikey-status";
  const input = document.createElement("input");
  input.className = "sheet-input";
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "sk-ant-…";
  input.value = getApiKey() ?? "";

  function syncStatus(): void {
    status.textContent = getApiKey() ? "A key is saved in this browser." : "No key set yet.";
  }
  syncStatus();

  const note = document.createElement("p");
  note.className = "aikey-note";
  note.textContent = "Used only in your browser, sent directly to Anthropic. Never uploaded to any server.";

  const save = Button({
    label: "Save key",
    icon: "sparkles",
    block: true,
    onClick: () => {
      setApiKey(input.value.trim());
      toast("Key saved");
      onChange?.();
      sheet.close();
    },
  });
  const clear = Button({
    label: "Clear key",
    icon: "trash",
    variant: "danger",
    block: true,
    onClick: () => {
      setApiKey("");
      input.value = "";
      syncStatus();
      toast("Key cleared");
      onChange?.();
    },
  });

  sheet.body.append(status, input, note, save, clear);
  input.focus();
}
