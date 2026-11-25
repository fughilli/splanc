/**
 * Speech output for the effect editor (D-541 PR 8): chat replies and code
 * walkthrough captions read aloud, opt-in.
 *
 * Engines (owner decision D-549): **Kokoro by default** — the open-weights
 * Kokoro-82M voice running on this device (kokoro.ts, a one-time download the
 * user starts explicitly) — with the browser's system voice
 * (`speechSynthesis`) as the fallback while Kokoro is not downloaded, still
 * loading, or failed. Nothing here talks to a server or holds a key.
 *
 * `Speaker` serialises everything spoken (reply text and walkthrough steps
 * share one queue, so two voices never overlap), splits long text into
 * sentence-sized chunks (Kokoro has a ~500-token window; Chrome's system voice
 * cuts off long utterances) and synthesises the next chunk while the current
 * one plays. `speakingNarrator` is the ExplainPlayer seam PR 7 left: a step
 * lasts as long as its speech, or its reading time when speech is off.
 *
 * Settings live in localStorage (`splanc.voice`), edited in Settings ▸ AI.
 */

import { readingPace, type Narrator } from "./explainPlayer";
import { appKokoro } from "./kokoro";

// -- settings ------------------------------------------------------------------

export type VoiceEngineId = "kokoro" | "system";

export interface VoiceSettings {
  /** Read chat replies and walkthrough steps aloud (opt-in; default off). */
  speak: boolean;
  /** Preferred engine. Kokoro by default (D-549); the system voice fills in. */
  engine: VoiceEngineId;
  /** Kokoro voice id (kokoro-js voice names). */
  kokoroVoice: string;
  /** Speaking rate multiplier (both engines). */
  rate: number;
}

export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: "af_heart", label: "Heart (US English, female)" },
  { id: "af_bella", label: "Bella (US English, female)" },
  { id: "af_nicole", label: "Nicole (US English, female, soft)" },
  { id: "am_michael", label: "Michael (US English, male)" },
  { id: "am_fenrir", label: "Fenrir (US English, male)" },
  { id: "bf_emma", label: "Emma (UK English, female)" },
  { id: "bm_george", label: "George (UK English, male)" },
  { id: "bm_fable", label: "Fable (UK English, male)" },
];

export const VOICE_RATES: Record<string, string> = { "0.85": "Slower", "1": "Normal", "1.15": "Faster", "1.3": "Fastest" };

const STORAGE = "splanc.voice";

export function defaultVoiceSettings(): VoiceSettings {
  return { speak: false, engine: "kokoro", kokoroVoice: "af_heart", rate: 1 };
}

export function normalizeVoiceSettings(raw: unknown): VoiceSettings {
  const d = defaultVoiceSettings();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const rate = typeof r["rate"] === "number" && Number.isFinite(r["rate"]) ? Math.min(2, Math.max(0.5, r["rate"])) : d.rate;
  const voice = typeof r["kokoroVoice"] === "string" && KOKORO_VOICES.some((v) => v.id === r["kokoroVoice"]) ? r["kokoroVoice"] : d.kokoroVoice;
  return {
    speak: r["speak"] === true,
    engine: r["engine"] === "system" ? "system" : "kokoro",
    kokoroVoice: voice,
    rate,
  };
}

let cached: VoiceSettings | null = null;
const listeners = new Set<(s: VoiceSettings) => void>();

export function getVoiceSettings(): VoiceSettings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const s = localStorage.getItem(STORAGE);
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  cached = normalizeVoiceSettings(raw);
  return cached;
}

export function updateVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const next = normalizeVoiceSettings({ ...getVoiceSettings(), ...patch });
  cached = next;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(next));
  } catch {
    // private mode / quota: still applies for this session
  }
  for (const fn of listeners) fn(next);
  return next;
}

/** Called after every settings change (the chat toggle and Settings ▸ AI stay
 * in step). Returns the unsubscribe. */
export function onVoiceSettings(fn: (s: VoiceSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests: forget the cached settings. */
export function resetVoiceSettingsCache(): void {
  cached = null;
}

// -- text ----------------------------------------------------------------------

/** What to say for a chat reply: markdown and code removed (a code block is
 * on screen, reading it out is noise), links reduced to their text. */
export function speakableText(md: string): string {
  let t = md.replace(/```[\s\S]*?(```|$)/g, " ");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, "a link");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s*>\s?/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/(\*\*|__)(.+?)\1/g, "$2");
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2");
  t = t.replace(/\|/g, " ");
  // Lines become sentence breaks (a list item reads as its own sentence).
  t = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;,]$/.test(l) ? l : l + "."))
    .join(" ");
  return t.replace(/\s+/g, " ").trim();
}

/** Split text into chunks of whole sentences, each at most about `max`
 * characters (a longer sentence is split at a comma or space). */
export function speechChunks(text: string, max = 220): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const sentences = t.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [t];
  const out: string[] = [];
  let cur = "";
  const push = (s: string): void => {
    const v = s.trim();
    if (v) out.push(v);
  };
  for (const raw of sentences) {
    let s = raw.trim();
    while (s.length > max) {
      let cut = s.lastIndexOf(", ", max);
      if (cut < max / 3) cut = s.lastIndexOf(" ", max);
      if (cut < max / 3) cut = max;
      push(cur);
      cur = "";
      push(s.slice(0, cut + (s[cut] === "," ? 1 : 0)));
      s = s.slice(cut + 1).trim();
    }
    if (cur && cur.length + 1 + s.length > max) {
      push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  push(cur);
  return out;
}

// -- engines -------------------------------------------------------------------

export interface SpeakOptions {
  rate: number;
  voice: string;
}

/** One way of producing speech. `speak` resolves when the audio has finished
 * (or promptly after `signal` aborts) and rejects if the engine failed. */
export interface SpeechEngine {
  readonly id: VoiceEngineId;
  /** Can speak right now (system: an engine exists; Kokoro: model loaded). */
  ready(): boolean;
  speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void>;
  /** Start synthesising ahead of time (Kokoro); optional. */
  prepare?(text: string, opts: SpeakOptions): void;
  /** Stop whatever is playing. */
  stop(): void;
  /** Called from a user gesture: unlock audio (iOS needs a gesture once). */
  unlock?(): void;
}

/** The Kokoro side as the Speaker sees it (kokoro.ts implements it). */
export interface KokoroLike extends SpeechEngine {
  /** "cached": downloaded, not loaded; "ready": loaded; others: not usable. */
  readonly state: string;
  /** Load the downloaded model into memory (no download; no-op otherwise). */
  load(): void;
  /** Resolves once a downloaded model is loaded (at once if there is none). */
  whenReady(): Promise<void>;
}

// The system voice (speechSynthesis), ported from the stage demo's picker.
const BAD_VOICE =
  /Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley/;

export function pickSystemVoice(voices: readonly SpeechSynthesisVoice[], language = "en-US"): SpeechSynthesisVoice | null {
  const lang = language.slice(0, 2);
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -99;
  for (const v of voices) {
    let s = (v.lang || "").slice(0, 2) === lang ? 10 : 0;
    if ((v.lang || "") === language) s += 2;
    if (/premium|enhanced|neural|natural/i.test(v.name)) s += 5;
    if (/^(Samantha|Daniel|Karen|Moira|Ava|Zoe|Evan|Allison|Tom|Serena|Google US English|Google UK English)/.test(v.name)) s += 3;
    if (v.localService) s += 1;
    if (BAD_VOICE.test(v.name)) s -= 30;
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return best;
}

export function systemEngine(synth: SpeechSynthesis | null = typeof speechSynthesis !== "undefined" ? speechSynthesis : null): SpeechEngine | null {
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return null;
  return {
    id: "system",
    ready: () => true,
    speak(text, opts, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        const v = pickSystemVoice(synth.getVoices(), typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US");
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        }
        u.rate = 1.05 * opts.rate;
        let done = false;
        const finish = (err?: string): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (err && err !== "interrupted" && err !== "canceled") reject(new Error(err));
          else resolve();
        };
        const onAbort = (): void => {
          synth.cancel();
          finish();
        };
        u.onend = () => finish();
        u.onerror = (e) => finish(e.error);
        // Some engines never fire onend.
        const timer = setTimeout(() => finish(), 3000 + text.length * 120);
        signal.addEventListener("abort", onAbort);
        synth.resume();
        synth.speak(u);
      });
    },
    stop: () => synth.cancel(),
    unlock() {
      // iOS speaks only after a speak() inside a user gesture: a silent one.
      try {
        const u = new SpeechSynthesisUtterance("");
        u.volume = 0;
        synth.speak(u);
      } catch {
        /* ignore */
      }
    },
  };
}

// -- the speaker ----------------------------------------------------------------

export interface SpeakerDeps {
  system: SpeechEngine | null;
  kokoro: KokoroLike | null;
  settings?: () => VoiceSettings;
}

/** The one place speech goes through (see the file comment). */
export class Speaker {
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by stop(): queued speech from before is dropped. */
  private epoch = 0;
  private current: AbortController | null = null;
  private readonly settings: () => VoiceSettings;

  constructor(private readonly d: SpeakerDeps) {
    this.settings = d.settings ?? getVoiceSettings;
  }

  /** Speaking is switched on and some engine can speak. */
  enabled(): boolean {
    return this.settings().speak && this.engine() !== null;
  }

  /** Any engine at all on this device (Kokoro counts once downloadable). */
  available(): boolean {
    return this.d.system !== null || this.d.kokoro !== null;
  }

  /** The engine speech uses now: Kokoro when chosen and loaded; else the
   * system voice (and a downloaded Kokoro starts loading for next time). */
  engine(): SpeechEngine | null {
    const s = this.settings();
    const k = this.d.kokoro;
    if (s.engine === "kokoro" && k) {
      if (k.ready()) return k;
      if (k.state === "cached") k.load();
    }
    return this.d.system ?? (k?.ready() ? k : null);
  }

  /** Wait for a downloaded Kokoro to load (the Test button), else nothing. */
  async warm(): Promise<void> {
    if (this.settings().engine === "kokoro") await this.d.kokoro?.whenReady().catch(() => undefined);
  }

  /** Which engine is speaking right now ("kokoro" | "system" | null). */
  engineId(): VoiceEngineId | null {
    return this.engine()?.id ?? null;
  }

  private opts(): SpeakOptions {
    const s = this.settings();
    return { rate: s.rate, voice: s.kokoroVoice };
  }

  /** Speak `text` after anything already queued. Resolves when it has been
   * spoken (or dropped by stop() / `signal`). Speech off: resolves at once. */
  say(text: string, signal?: AbortSignal): Promise<void> {
    const chunks = speechChunks(text);
    if (!this.enabled() || chunks.length === 0) return Promise.resolve();
    const epoch = this.epoch;
    const run = async (): Promise<void> => {
      for (let i = 0; i < chunks.length; i++) {
        if (epoch !== this.epoch || signal?.aborted) return;
        const engine = this.engine();
        if (!engine || !this.settings().speak) return;
        const next = chunks[i + 1];
        if (next) engine.prepare?.(next, this.opts());
        const ac = new AbortController();
        this.current = ac;
        const onAbort = (): void => ac.abort();
        signal?.addEventListener("abort", onAbort);
        try {
          await engine.speak(chunks[i]!, this.opts(), ac.signal);
        } finally {
          signal?.removeEventListener("abort", onAbort);
          if (this.current === ac) this.current = null;
        }
      }
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Start synthesising `text` early (the walkthrough's next steps). */
  prepare(text: string): void {
    if (!this.enabled()) return;
    const first = speechChunks(text)[0];
    if (first) this.engine()?.prepare?.(first, this.opts());
  }

  /** Stop speaking and drop everything queued. */
  stop(): void {
    this.epoch++;
    this.current?.abort();
    this.current = null;
    this.d.system?.stop();
    this.d.kokoro?.stop();
  }

  /** From a user gesture (send, the mic, the toggle): unlock audio output. */
  unlock(): void {
    this.d.kokoro?.unlock?.();
    this.d.system?.unlock?.();
  }
}

/** The walkthrough narrator (ExplainPlayer's seam): speak each step while
 * speech is on, else hold it for its reading time. A failed speech falls back
 * to reading time, so a step never flashes past. */
export function speakingNarrator(speaker: Speaker, fallback: Narrator = readingPace()): Narrator {
  return {
    present: async (text, signal) => {
      if (!speaker.enabled() || !text.trim()) return fallback.present(text, signal);
      try {
        await speaker.say(text, signal);
      } catch {
        if (!signal.aborted) await fallback.present(text, signal);
      }
    },
    prepare: (text) => speaker.prepare(text),
  };
}

let app: Speaker | null = null;

/** The app's speaker (Kokoro + the system voice, settings from storage). */
export function appSpeaker(): Speaker {
  app ??= new Speaker({ system: systemEngine(), kokoro: appKokoro() });
  return app;
}
