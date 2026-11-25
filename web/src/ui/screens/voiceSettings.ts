/**
 * Settings ▸ AI ▸ Voice (D-541 PR 8): read replies aloud, the engine (Kokoro
 * by default, owner decision D-549; the system voice as the fallback), the
 * Kokoro download, voice and speed, and a note on push-to-talk.
 *
 * Also the first-use sheet the editor chat opens when speech is switched on
 * before Kokoro is on the device: the ~115 MB download only ever starts from
 * an explicit Download press, here or there.
 */

import { Button, Sheet, toast } from "../kit";
import { isIosNative } from "../../net/native";
import { installSettingsStyles } from "./settings.css";
import { installAiSettingsStyles } from "./aiSettings.css";
import {
  KOKORO_VOICES,
  VOICE_RATES,
  appSpeaker,
  getVoiceSettings,
  updateVoiceSettings,
  type Speaker,
  type VoiceSettings,
} from "../../effects/ai/tts";
import { KOKORO_DOWNLOAD_MB, appKokoro, lowMemoryDevice, type KokoroVoice } from "../../effects/ai/kokoro";

const SAMPLE = "Hello! This is how replies and code walkthroughs will sound.";

/** Speech recognition for push-to-talk (the same test as acid/voice.ts,
 * without importing it: that module binds the native plugin). */
export function speechInputAvailable(): boolean {
  if (isIosNative()) return true;
  const w = globalThis as unknown as Record<string, unknown>;
  return !!(w["SpeechRecognition"] || w["webkitSpeechRecognition"]);
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * The Kokoro status and its one action, kept current: Download (explicit,
 * with the size), progress while downloading, then Test / Remove.
 */
export function kokoroBlock(k: KokoroVoice, opts: { speaker?: Speaker; onReady?: () => void } = {}): { el: HTMLElement; dispose: () => void } {
  const el = document.createElement("div");
  el.className = "vset-kokoro";
  const line = document.createElement("p");
  line.className = "vset-line";
  const bar = document.createElement("div");
  bar.className = "aiset-progress";
  const fill = document.createElement("i");
  bar.appendChild(fill);
  const actions = document.createElement("div");
  actions.className = "vset-actions";
  el.append(line, bar, actions);
  let last = "";

  function render(): void {
    const s = k.state;
    bar.hidden = s !== "downloading";
    if (s === "downloading") {
      const p = k.progress;
      fill.style.width = `${Math.round((100 * p.loaded) / Math.max(1, p.total))}%`;
      line.textContent = `Downloading the Kokoro voice… ${mb(p.loaded)} of ${mb(p.total)}. You can keep working.`;
    } else if (s === "unknown") line.textContent = "Checking for the Kokoro voice…";
    else if (s === "absent") {
      line.textContent =
        `Not on this device yet. Kokoro downloads once (about ${KOKORO_DOWNLOAD_MB} MB) and then runs here, offline. ` +
        "Until then the system voice reads." +
        (lowMemoryDevice() ? " This device reports little memory: Kokoro may be slow or fail here." : "");
    } else if (s === "loading") line.textContent = "Loading the Kokoro voice…";
    else if (s === "cached") line.textContent = "Downloaded. It loads the first time it speaks.";
    else if (s === "ready") line.textContent = "Downloaded and ready.";
    else line.textContent = `The Kokoro voice didn't load (${k.error || "unknown error"}). The system voice reads meanwhile.`;

    if (s === last) return;
    last = s;
    const btns: HTMLElement[] = [];
    if (s === "absent" || s === "failed") {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      btns.push(
        Button({
          label: s === "failed" ? "Try again" : `Download (${KOKORO_DOWNLOAD_MB} MB)`,
          icon: "download",
          variant: "primary",
          disabled: offline,
          onClick: () => {
            opts.speaker?.unlock();
            k.download().then(
              () => {
                toast("The Kokoro voice is ready.");
                opts.onReady?.();
              },
              (e: unknown) => {
                if (k.state === "failed") toast(`Kokoro didn't download: ${e instanceof Error ? e.message : String(e)}`, { error: true });
              },
            );
          },
        }),
      );
    } else if (s === "downloading") {
      btns.push(Button({ label: "Cancel", variant: "quiet", onClick: () => k.unload() }));
    } else if (s === "cached" || s === "ready") {
      if (opts.speaker) btns.push(testButton(opts.speaker));
      btns.push(
        Button({
          label: "Remove",
          icon: "trash",
          variant: "quiet",
          onClick: () => void k.remove().then(() => toast("Removed the Kokoro voice from this device.")),
        }),
      );
    }
    actions.replaceChildren(...btns);
    actions.hidden = btns.length === 0;
  }

  const unsub = k.subscribe(render);
  render();
  void k.probe().then(render);
  return { el, dispose: unsub };
}

function testButton(speaker: Speaker): HTMLButtonElement {
  return Button({
    label: "Test voice",
    icon: "play",
    variant: "quiet",
    onClick: () => {
      speaker.unlock();
      speaker.stop();
      const was = getVoiceSettings().speak;
      // A test speaks even with "read aloud" off: switch it on for the sample.
      if (!was) updateVoiceSettings({ speak: true });
      void speaker
        .warm()
        .then(() => speaker.say(SAMPLE))
        .finally(() => {
          if (!was) updateVoiceSettings({ speak: false });
        });
    },
  });
}

type Group = (legend: string) => HTMLElement;

function row(name: string, hint: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "settings-row vset-row";
  const label = document.createElement("div");
  label.className = "settings-row-label";
  const n = document.createElement("div");
  n.className = "settings-row-name";
  n.textContent = name;
  const h = document.createElement("div");
  h.className = "settings-row-hint";
  h.textContent = hint;
  label.append(n, h);
  const ctl = document.createElement("div");
  ctl.className = "settings-row-ctl";
  ctl.appendChild(control);
  r.append(label, ctl);
  return r;
}

function seg<T extends string | boolean>(choices: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const s = document.createElement("div");
  s.className = "settings-seg";
  s.setAttribute("role", "radiogroup");
  for (const [v, label] of choices) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(v === value));
    if (v === value) b.classList.add("on");
    b.addEventListener("click", () => onPick(v));
    s.appendChild(b);
  }
  return s;
}

function select(label: string, options: Record<string, string>, value: string, onPick: (v: string) => void): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "aiset-field";
  const cap = document.createElement("span");
  cap.textContent = label;
  const sel = document.createElement("select");
  for (const [k, text] of Object.entries(options)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = text;
    if (k === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onPick(sel.value));
  wrap.append(cap, sel);
  return wrap;
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "aiset-note";
  p.textContent = text;
  return p;
}

export interface VoiceCardDeps {
  speaker?: Speaker;
  kokoro?: KokoroVoice | null;
}

/** The Voice card in Settings ▸ AI. */
export function voiceSettingsCard(group: Group, deps: VoiceCardDeps = {}): HTMLElement {
  const speaker = deps.speaker ?? appSpeaker();
  const kokoro = deps.kokoro === undefined ? appKokoro() : deps.kokoro;
  const card = group("Voice");
  card.classList.add("vset");
  const body = document.createElement("div");
  card.appendChild(body);
  let disposeBlock: (() => void) | null = null;

  function set(patch: Partial<VoiceSettings>): void {
    updateVoiceSettings(patch);
    if (patch.speak === false) speaker.stop();
    // Speech off, or the system voice chosen: give the model's memory back.
    if (patch.speak === false || patch.engine === "system") kokoro?.unload();
    render();
  }

  function render(): void {
    disposeBlock?.();
    disposeBlock = null;
    const s = getVoiceSettings();
    const parts: HTMLElement[] = [];
    if (!speaker.available()) {
      parts.push(note("This browser can't speak (no speech synthesis or Web Audio)."));
    } else {
      parts.push(
        row(
          "Read replies aloud",
          "Chat replies and code walkthroughs in the effect editor (also the speaker button under the chat).",
          seg<boolean>([[false, "Off"], [true, "On"]], s.speak, (v) => {
            speaker.unlock();
            set({ speak: v });
          }),
        ),
      );
      const engines: [string, string][] = kokoro ? [["kokoro", "Kokoro"], ["system", "System voice"]] : [["system", "System voice"]];
      parts.push(
        row(
          "Voice",
          kokoro
            ? "Kokoro is a natural voice that runs on this device; System is the device's built-in voice."
            : "Kokoro can't run in this browser; the system voice reads.",
          seg(engines, kokoro ? s.engine : "system", (v) => set({ engine: v as VoiceSettings["engine"] })),
        ),
      );
      if (kokoro && s.engine === "kokoro") {
        const b = kokoroBlock(kokoro, { speaker });
        disposeBlock = b.dispose;
        parts.push(b.el);
        const voices: Record<string, string> = {};
        for (const v of KOKORO_VOICES) voices[v.id] = v.label;
        parts.push(select("Kokoro voice", voices, s.kokoroVoice, (v) => set({ kokoroVoice: v })));
      } else {
        const t = document.createElement("div");
        t.className = "vset-actions";
        t.appendChild(testButton(speaker));
        parts.push(t);
      }
      parts.push(select("Speed", VOICE_RATES, String(s.rate), (v) => set({ rate: Number(v) })));
    }
    parts.push(
      note(
        speechInputAvailable()
          ? "Push to talk: hold the mic under the editor chat and speak, or tap it once and it stops when you pause. " +
              "Your browser turns the speech into text (Chrome uses Google's service, Safari and the iOS app use Apple's); no Splanc server or API key is involved."
          : "Push to talk needs speech recognition, which this browser doesn't have (Chrome, Edge and Safari do).",
      ),
    );
    body.replaceChildren(...parts);
  }

  render();
  return card;
}

/**
 * The first-use sheet (the chat's speaker toggle, Kokoro not downloaded):
 * explain the download and let the user start it, or read with the system
 * voice for now. Resolves once a choice is made (or the sheet is closed).
 */
export function kokoroFirstUseSheet(k: KokoroVoice, speaker: Speaker): Promise<"download" | "system" | "closed"> {
  installSettingsStyles();
  installAiSettingsStyles();
  return new Promise((resolve) => {
    let picked: "download" | "system" | "closed" = "closed";
    let block: { el: HTMLElement; dispose: () => void } | null = null;
    const sheet = Sheet("Read replies aloud", {
      onClose: () => {
        block?.dispose();
        resolve(picked);
      },
    });
    sheet.body.classList.add("vset-sheet");
    const intro = document.createElement("p");
    intro.textContent =
      `The default voice is Kokoro, a natural voice that runs on this device. It needs a one-time download of about ${KOKORO_DOWNLOAD_MB} MB, ` +
      "kept on this device afterwards. Until it's downloaded, your device's system voice reads.";
    const warn = document.createElement("p");
    warn.className = "aiset-note";
    warn.textContent = lowMemoryDevice()
      ? "This device reports little memory: Kokoro may be slow or fail here. The system voice works everywhere."
      : "On a phone, use Wi-Fi for the download. You can remove it any time in Settings ▸ AI ▸ Voice.";
    const actions = document.createElement("div");
    actions.className = "vset-actions vset-actions--sheet";
    actions.append(
      Button({
        label: `Download Kokoro (${KOKORO_DOWNLOAD_MB} MB)`,
        icon: "download",
        variant: "primary",
        onClick: () => {
          picked = "download";
          speaker.unlock();
          void k.download().then(
            () => toast("The Kokoro voice is ready."),
            (e: unknown) => {
              if (k.state === "failed") toast(`Kokoro didn't download: ${e instanceof Error ? e.message : String(e)}`, { error: true });
            },
          );
          // The progress shows here; the download carries on if the sheet closes.
          block = kokoroBlock(k, { onReady: () => sheet.close() });
          actions.replaceChildren(Button({ label: "Done", variant: "quiet", onClick: () => sheet.close() }));
          sheet.body.insertBefore(block.el, actions);
        },
      }),
      Button({
        label: "Use the system voice for now",
        variant: "quiet",
        onClick: () => {
          picked = "system";
          sheet.close();
        },
      }),
    );
    sheet.body.append(intro, warn, actions);
  });
}
