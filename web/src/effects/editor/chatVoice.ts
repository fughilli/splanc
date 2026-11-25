/**
 * Voice in the effect editor chat (D-541 PR 8): a row under the chat input
 * with two controls, spaced apart (never crammed):
 *
 * - **Push to talk** (the mic): hold it and speak, release to send; or tap it
 *   once and it stops when you pause. Speech-to-text is the app's existing
 *   path (`createVoice()` in ui/acid/voice.ts: Web Speech in the browser, the
 *   native SpeechBridge plugin in the iOS app). Pressing it also stops the
 *   voice and jumps a walkthrough to its end (barge-in).
 * - **Read aloud** (the speaker): the opt-in toggle for speaking replies and
 *   walkthrough steps (tts.ts). Switching it on before Kokoro is on the device
 *   opens the first-use sheet (the download is always the user's choice).
 *
 * Settings ▸ AI ▸ Voice holds the same switch plus the engine, voice and speed.
 */

import { icon, toast } from "../../ui/kit";
import { getVoiceSettings, onVoiceSettings, speakableText, updateVoiceSettings, type Speaker } from "../ai/tts";
import type { KokoroVoice } from "../ai/kokoro";
import type { VoiceHooks, VoiceSession } from "../../ui/acid/voice";

/** Held at least this long, the mic is push-to-talk (release sends); a
 * shorter press is a tap (it listens until you pause). */
export const HOLD_MS = 350;

export interface ChatVoiceOptions {
  input: HTMLTextAreaElement;
  /** Send what is in the input (the chat's Send). */
  send: () => void;
  /** A turn is running (a transcript then waits in the input). */
  busy: () => boolean;
  speaker: Speaker;
  kokoro: KokoroVoice | null;
  /** Speech-to-text (null: no mic button). */
  createVoice: ((hooks: VoiceHooks) => VoiceSession | null) | null;
  /** The user started talking: stop the walkthrough. */
  onBargeIn: () => void;
  /** Kokoro not downloaded yet: ask (the first-use sheet). */
  askKokoro: (k: KokoroVoice, speaker: Speaker) => Promise<"download" | "system" | "closed">;
  now?: () => number;
}

export function micErrorText(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "The microphone is blocked. Allow it for this site in the browser's settings.";
  if (code === "no-speech") return "Didn't hear anything. Hold the mic and speak.";
  if (code === "audio-capture") return "No microphone found.";
  if (code === "network") return "Speech recognition needs a connection.";
  if (code === "aborted") return "";
  return "Didn't catch that. Try again.";
}

export class ChatVoice {
  readonly el: HTMLDivElement;
  private readonly mic: HTMLButtonElement | null = null;
  private readonly micLabel: HTMLSpanElement | null = null;
  private readonly speak: HTMLButtonElement;
  private readonly status: HTMLSpanElement;
  private session: VoiceSession | null = null;
  private listening = false;
  private pressAt = 0;
  private pressed = false;
  private viaPointer = false;
  private prefix = "";
  private readonly unsub: () => void;
  private readonly now: () => number;

  constructor(private readonly o: ChatVoiceOptions) {
    this.now = o.now ?? (() => Date.now());
    this.el = document.createElement("div");
    this.el.className = "fxvoice-bar";
    this.status = document.createElement("span");
    this.status.className = "fxvoice-status";
    this.status.setAttribute("aria-live", "polite");

    if (o.createVoice) {
      this.session = o.createVoice({
        onPartial: (t) => this.showText(t),
        onFinal: (t) => this.final(t),
        onError: (e) => this.error(e),
        onEnd: () => this.ended(),
      });
    }
    if (this.session) {
      const mic = document.createElement("button");
      mic.type = "button";
      mic.className = "fxvoice-btn fxvoice-mic";
      mic.setAttribute("aria-label", "Push to talk");
      mic.title = "Hold to talk, release to send (or tap, then speak)";
      const label = document.createElement("span");
      label.textContent = "Hold to talk";
      mic.append(icon("mic"), label);
      mic.addEventListener("pointerdown", (ev) => this.down(ev));
      mic.addEventListener("pointerup", () => this.up());
      mic.addEventListener("pointercancel", () => this.up());
      mic.addEventListener("click", () => this.click());
      // A long press must not open the text-selection / context menu.
      mic.addEventListener("contextmenu", (ev) => ev.preventDefault());
      this.mic = mic;
      this.micLabel = label;
    }

    this.speak = document.createElement("button");
    this.speak.type = "button";
    this.speak.className = "fxvoice-btn fxvoice-speak";
    this.speak.addEventListener("click", () => void this.toggleSpeak());
    if (this.mic) this.el.append(this.mic);
    this.el.append(this.status);
    if (o.speaker.available()) this.el.append(this.speak);
    this.el.hidden = !this.mic && !o.speaker.available();
    this.unsub = onVoiceSettings(() => this.renderSpeak());
    this.renderSpeak();
  }

  // -- read aloud --------------------------------------------------------------

  private renderSpeak(): void {
    const on = getVoiceSettings().speak;
    this.speak.classList.toggle("on", on);
    this.speak.setAttribute("aria-pressed", String(on));
    this.speak.title = on ? "Stop reading replies aloud" : "Read replies aloud";
    this.speak.replaceChildren(icon(on ? "volume" : "volume-off"), Object.assign(document.createElement("span"), { textContent: on ? "Read aloud: on" : "Read aloud" }));
  }

  private async toggleSpeak(): Promise<void> {
    const sp = this.o.speaker;
    sp.unlock();
    if (getVoiceSettings().speak) {
      sp.stop();
      updateVoiceSettings({ speak: false });
      this.o.kokoro?.unload(); // give its memory back
      return;
    }
    const k = this.o.kokoro;
    if (getVoiceSettings().engine === "kokoro" && k) {
      const state = await k.probe();
      if (state === "absent") {
        const pick = await this.o.askKokoro(k, sp);
        if (pick === "closed") return;
      } else if (state === "cached") k.load();
    }
    updateVoiceSettings({ speak: true });
  }

  /** Speak a chat reply (when read-aloud is on). */
  speakReply(text: string): void {
    const say = speakableText(text);
    if (say) void this.o.speaker.say(say).catch(() => undefined);
  }

  /** The user sent a message (a gesture): unlock audio, stop the old speech,
   * and start loading a downloaded Kokoro so it is ready for the reply. */
  onSend(): void {
    const sp = this.o.speaker;
    sp.unlock();
    sp.stop();
    if (getVoiceSettings().speak) sp.engine();
  }

  // -- push to talk ------------------------------------------------------------

  private down(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    this.viaPointer = true;
    if (this.listening) {
      this.session?.stop(); // a second tap ends a tapped session
      return;
    }
    this.pressed = true;
    this.pressAt = this.now();
    try {
      (ev.target as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
    } catch {
      /* not capturable */
    }
    this.start();
  }

  private up(): void {
    if (!this.pressed) return;
    this.pressed = false;
    // Held: release sends. Tapped: keep listening until the pause.
    if (this.now() - this.pressAt >= HOLD_MS) this.session?.stop();
    else this.setStatus("Pause to send");
  }

  private click(): void {
    // Pointer presses are handled above; this is the keyboard (Enter/Space).
    if (this.viaPointer) {
      this.viaPointer = false;
      return;
    }
    if (this.listening) this.session?.stop();
    else this.start();
  }

  private start(): void {
    if (!this.session) return;
    this.o.speaker.unlock();
    this.o.speaker.stop();
    this.o.onBargeIn();
    const cur = this.o.input.value.trim();
    this.prefix = cur ? cur + " " : "";
    this.listening = true;
    this.mic?.classList.add("on");
    if (this.micLabel) this.micLabel.textContent = "Listening…";
    this.setStatus("");
    this.session.start();
  }

  private showText(t: string): void {
    this.o.input.value = this.prefix + t;
  }

  private final(t: string): void {
    if (!t) return;
    this.o.input.value = this.prefix + t;
    if (this.o.busy()) {
      toast("Your message is in the box: send it when the reply is done.");
      return;
    }
    this.o.send();
  }

  private error(code: string): void {
    const msg = micErrorText(code);
    if (msg) toast(msg, { error: true });
  }

  private ended(): void {
    this.listening = false;
    this.pressed = false;
    this.mic?.classList.remove("on");
    if (this.micLabel) this.micLabel.textContent = "Hold to talk";
    this.setStatus("");
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Leaving the editor: stop listening and speaking. */
  dispose(): void {
    this.unsub();
    if (this.listening) this.session?.stop();
    this.o.speaker.stop();
  }
}
