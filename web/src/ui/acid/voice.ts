/**
 * Voice-input wrapper for Acid Mode (FUG-106) — a thin, typed shim over the Web
 * Speech API (`SpeechRecognition` / `webkitSpeechRecognition`). The browser's
 * lib.dom types don't ship SpeechRecognition, so we declare the minimal surface
 * we use and feature-detect at runtime; where it's absent the screen falls back
 * to a text box.
 *
 * The mic is push-to-talk from the UI's perspective: `start()` begins listening,
 * interim results stream to `onPartial`, and the settled utterance arrives via
 * `onFinal` (also on `stop()`/end).
 */

import { isIosNative } from "../../net/native";

interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when the browser can do speech recognition (else use the text box). */
export function voiceSupported(): boolean {
  // iOS WKWebView exposes `webkitSpeechRecognition`, but it aborts immediately
  // with no transcript (verified on-device: onaudiostart → onerror "aborted" →
  // onend, no result) — the Web Speech API only functions in Safari proper, not
  // a WKWebView. Report unsupported there so Acid Mode uses its text box instead
  // of a mic that does nothing. (Real native iOS voice needs a Capacitor speech
  // plugin — a follow-up.)
  if (isIosNative()) return false;
  return recognitionCtor() !== null;
}

export interface VoiceHooks {
  /** Interim (not-yet-final) transcript as the user speaks. */
  onPartial?: (text: string) => void;
  /** The settled utterance once the user stops. Empty string → heard nothing. */
  onFinal: (text: string) => void;
  /** Recognition error (permission denied, no-speech, etc.). */
  onError?: (message: string) => void;
  /** Listening ended (naturally or via stop()). */
  onEnd?: () => void;
}

export interface VoiceSession {
  start(): void;
  stop(): void;
  readonly listening: boolean;
}

/** Create a voice session, or null if unsupported. */
export function createVoice(hooks: VoiceHooks): VoiceSession | null {
  const Ctor = recognitionCtor();
  if (Ctor === null) return null;

  const rec = new Ctor();
  rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
  rec.continuous = false;
  rec.interimResults = true;

  let listening = false;
  let finalText = "";

  rec.onresult = (ev): void => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i]!;
      const alt = res[0];
      if (!alt) continue;
      if (res.isFinal) finalText += alt.transcript;
      else interim += alt.transcript;
    }
    if (interim) hooks.onPartial?.((finalText + interim).trim());
  };
  rec.onerror = (ev): void => {
    hooks.onError?.(ev.error ?? "voice error");
  };
  rec.onend = (): void => {
    listening = false;
    hooks.onFinal(finalText.trim());
    hooks.onEnd?.();
  };

  return {
    start(): void {
      if (listening) return;
      finalText = "";
      listening = true;
      try {
        rec.start();
      } catch {
        // start() throws if called while already starting — ignore.
        listening = false;
      }
    },
    stop(): void {
      if (!listening) return;
      try {
        rec.stop();
      } catch {
        // ignore
      }
    },
    get listening(): boolean {
      return listening;
    },
  };
}
