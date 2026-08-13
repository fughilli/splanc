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

/** True when we can do speech recognition (else use the text box). */
export function voiceSupported(): boolean {
  // iOS WKWebView exposes `webkitSpeechRecognition` but it aborts immediately
  // with no transcript (the Web Speech API only functions in Safari, not a
  // WKWebView). On iOS native we instead drive the native SFSpeechRecognizer via
  // @capacitor-community/speech-recognition (see NativeVoiceSession), so voice IS
  // supported there — createVoice() returns the plugin-backed session.
  if (isIosNative()) return true;
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
  // iOS: the Web Speech API is dead in a WKWebView — use the native plugin.
  if (isIosNative()) return new NativeVoiceSession(hooks);

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

/** A subscription handle (Capacitor's PluginListenerHandle) — typed structurally
 * so this module needs no value import from the plugin. */
interface Sub {
  remove(): Promise<void>;
}

/** The first-party native speech plugin (web/native-plugins/speech-bridge) — an
 * SFSpeechRecognizer wrapper registered under "SpeechBridge". Only the surface we
 * call is typed here; addListener resolves Capacitor's PluginListenerHandle. */
interface SpeechBridgePlugin {
  requestPermissions(): Promise<{ speechRecognition: string }>;
  start(opts: { language?: string; partialResults?: boolean }): Promise<{ matches?: string[] }>;
  stop(): Promise<void>;
  addListener(event: "partialResults", cb: (data: { matches: string[] }) => void): Promise<Sub>;
  addListener(event: "listeningState", cb: (data: { status: "started" | "stopped" }) => void): Promise<Sub>;
}

// Bind the plugin lazily through @capacitor/core's registerPlugin, dynamically
// imported so Capacitor never enters the browser PWA bundle — the same approach
// as net/nativeSocket.ts. Cached once resolved.
let bridgeP: Promise<SpeechBridgePlugin> | null = null;
function speechBridge(): Promise<SpeechBridgePlugin> {
  if (!bridgeP) {
    bridgeP = import("@capacitor/core").then(({ registerPlugin }) =>
      registerPlugin<SpeechBridgePlugin>("SpeechBridge"),
    );
  }
  return bridgeP;
}

/**
 * iOS native voice session (docs/design/ios-support.md §4.4). WKWebView's Web
 * Speech API aborts with no transcript, so on iOS we drive the native
 * SFSpeechRecognizer through the @splanc/speech-bridge plugin, adapted to the
 * SAME VoiceSession seam the web path uses — so acidMode.ts is unchanged.
 */
class NativeVoiceSession implements VoiceSession {
  private active = false;
  private subs: Sub[] = [];
  private lastPartial = "";

  constructor(private readonly hooks: VoiceHooks) {}

  get listening(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lastPartial = "";
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const bridge = await speechBridge();
      const perm = await bridge.requestPermissions();
      if (perm.speechRecognition !== "granted") {
        this.fail("not-allowed");
        return;
      }
      // Interim transcripts stream as the user speaks; keep the best match as the
      // running result so there's a final even if start() resolves empty.
      this.subs.push(
        await bridge.addListener("partialResults", (data) => {
          const t = data.matches?.[0] ?? "";
          if (t) {
            this.lastPartial = t;
            this.hooks.onPartial?.(t);
          }
        }),
      );
      // Belt-and-suspenders: finalize on whichever fires first — the explicit
      // "stopped" state or start()'s resolution. finish() is idempotent, so the
      // second is a no-op.
      this.subs.push(
        await bridge.addListener("listeningState", (data) => {
          if (data.status === "stopped") this.finish(this.lastPartial);
        }),
      );
      const res = await bridge.start({
        language: typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
        partialResults: true,
      });
      this.finish(res.matches?.[0] ?? this.lastPartial);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  stop(): void {
    if (!this.active) return;
    // Ending the engine drives "stopped"/start()-resolution → finish().
    void speechBridge()
      .then((b) => b.stop())
      .catch(() => undefined);
  }

  private cleanup(): void {
    const subs = this.subs;
    this.subs = [];
    for (const s of subs) void s.remove();
  }

  private finish(text: string): void {
    if (!this.active) return;
    this.active = false;
    this.cleanup();
    this.hooks.onFinal(text.trim());
    this.hooks.onEnd?.();
  }

  private fail(err: string): void {
    if (!this.active) return;
    this.active = false;
    this.cleanup();
    // onError (acidMode resets the button + shows the message); no utterance, so
    // no onFinal.
    this.hooks.onError?.(err);
    this.hooks.onEnd?.();
  }
}
