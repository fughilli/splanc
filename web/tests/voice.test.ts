/**
 * Voice in the effect editor (D-541 PR 8): speech output (src/effects/ai/tts.ts:
 * settings, text clean-up and chunking, the serialising Speaker, the
 * walkthrough narrator), the Kokoro engine (src/effects/ai/kokoro.ts, driven
 * through a fake worker / cache / audio), push-to-talk + the read-aloud toggle
 * under the chat (src/effects/editor/chatVoice.ts) and the Voice card in
 * Settings ▸ AI (src/ui/screens/voiceSettings.ts).
 *
 * The owner's choice (D-549) is pinned here: Kokoro is the default engine, and
 * nothing is downloaded until the user presses Download.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, fire, installFakeDom, textOf, type FakeElement } from "./fakeDom";

installFakeDom();

import {
  Speaker,
  defaultVoiceSettings,
  getVoiceSettings,
  normalizeVoiceSettings,
  pickSystemVoice,
  resetVoiceSettingsCache,
  speakableText,
  speakingNarrator,
  speechChunks,
  updateVoiceSettings,
  type KokoroLike,
  type SpeakOptions,
  type SpeechEngine,
  type VoiceSettings,
} from "../src/effects/ai/tts";
import {
  KOKORO_DOWNLOAD_MB,
  KOKORO_LIB_URL,
  KOKORO_MODEL,
  KOKORO_WEIGHTS_URL,
  KOKORO_WORKER_SOURCE,
  KokoroVoice,
  type AudioOut,
  type CacheStoreLike,
  type WorkerLike,
} from "../src/effects/ai/kokoro";
import { ExplainPlayer, type Narrator } from "../src/effects/ai/explainPlayer";
import { ChatVoice, HOLD_MS, micErrorText } from "../src/effects/editor/chatVoice";
import { voiceSettingsCard } from "../src/ui/screens/voiceSettings";
import type { VoiceHooks, VoiceSession } from "../src/ui/acid/voice";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

// -- fakes ------------------------------------------------------------------------

interface Spoken {
  engine: string;
  text: string;
  opts: SpeakOptions;
}

/** A speech engine that finishes each utterance when the test says so. */
function fakeEngine(id: "system" | "kokoro", log: Spoken[], opts: { manual?: boolean; fail?: boolean } = {}) {
  const pending: (() => void)[] = [];
  let ready = true;
  const prepared: string[] = [];
  const e: SpeechEngine & { pending: (() => void)[]; prepared: string[]; stops: number; setReady(v: boolean): void } = {
    id,
    pending,
    prepared,
    stops: 0,
    setReady: (v) => {
      ready = v;
    },
    ready: () => ready,
    speak(text, o, signal) {
      log.push({ engine: id, text, opts: o });
      if (opts.fail) return Promise.reject(new Error("speech refused"));
      if (!opts.manual) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => resolve());
      });
    },
    prepare: (t) => void prepared.push(t),
    stop() {
      e.stops++;
    },
  };
  return e;
}

function fakeKokoroLike(log: Spoken[], state: string) {
  const base = fakeEngine("kokoro", log);
  const k = Object.assign(base, {
    state,
    loads: 0,
    load() {
      if (k.state !== "cached") return;
      k.loads++;
      k.state = "loading";
    },
    whenReady: () => Promise.resolve(),
  });
  base.setReady(state === "ready");
  return k as typeof k & KokoroLike;
}

function settingsOf(patch: Partial<VoiceSettings> = {}): () => VoiceSettings {
  const s = { ...defaultVoiceSettings(), speak: true, ...patch };
  return () => s;
}

class FakeWorker implements WorkerLike {
  sent: Record<string, unknown>[] = [];
  terminated = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  postMessage(msg: unknown): void {
    this.sent.push(msg as Record<string, unknown>);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: Record<string, unknown>): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function fakeCaches(have: string[] = []): CacheStoreLike & { entries: Set<string>; deleted: string[] } {
  const entries = new Set(have);
  const deleted: string[] = [];
  return {
    entries,
    deleted,
    async open() {
      return {
        match: async (url: string) => (entries.has(url) ? {} : undefined),
        keys: async () => [...entries].map((url) => ({ url })),
        delete: async (req: { url: string } | string) => entries.delete(typeof req === "string" ? req : req.url),
      };
    },
    async delete(name: string) {
      deleted.push(name);
      return true;
    },
  };
}

function fakeAudio(): AudioOut & { played: number[]; unlocks: number } {
  const a = {
    played: [] as number[],
    unlocks: 0,
    play: async (samples: Float32Array) => {
      a.played.push(samples.length);
    },
    stop: () => undefined,
    unlock: () => {
      a.unlocks++;
    },
  };
  return a;
}

function kokoroWith(caches = fakeCaches()) {
  const workers: FakeWorker[] = [];
  const audio = fakeAudio();
  const k = new KokoroVoice({
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    audio,
    caches,
    stallMs: () => 1000,
  });
  return { k, workers, audio, caches };
}

// -- settings and text ---------------------------------------------------------

test("voice settings: Kokoro is the default engine (D-549), reading aloud is opt-in", () => {
  const d = defaultVoiceSettings();
  assert.equal(d.engine, "kokoro");
  assert.equal(d.speak, false);
  assert.deepEqual(normalizeVoiceSettings(null), d);
  assert.deepEqual(normalizeVoiceSettings({ engine: "nope", speak: "yes", kokoroVoice: "zz_bad", rate: 99 }), { ...d, rate: 2 });
  assert.equal(normalizeVoiceSettings({ engine: "system" }).engine, "system");
});

test("voice settings persist and notify", () => {
  resetVoiceSettingsCache();
  localStorage.removeItem("splanc.voice");
  assert.equal(getVoiceSettings().speak, false);
  updateVoiceSettings({ speak: true, kokoroVoice: "bm_george" });
  resetVoiceSettingsCache();
  assert.equal(getVoiceSettings().speak, true);
  assert.equal(getVoiceSettings().kokoroVoice, "bm_george");
  updateVoiceSettings(defaultVoiceSettings());
});

test("speakableText drops code and markdown, keeps the words", () => {
  const md = [
    "## Done",
    "I made it **breathe** with `sin(t)`:",
    "```fx",
    "uniform float speed : 0..4 = 1;",
    "```",
    "- slower at the *base*",
    "- see [the docs](https://example.com/x)",
    "More at https://splanc.io/docs",
  ].join("\n");
  assert.equal(speakableText(md), "Done. I made it breathe with sin(t): slower at the base. see the docs. More at a link.");
  assert.equal(speakableText("```\nonly code\n```"), "");
});

test("speechChunks keeps whole sentences under the limit and splits long ones", () => {
  assert.deepEqual(speechChunks("One. Two! Three?"), ["One. Two! Three?"]);
  const s = speechChunks("First sentence here. Second one there. Third.", 25);
  assert.deepEqual(s, ["First sentence here.", "Second one there. Third."]);
  const long = "word ".repeat(100).trim() + ".";
  for (const c of speechChunks(long, 60)) assert.ok(c.length <= 60, c);
  assert.equal(speechChunks(long, 60).join(" "), long);
  assert.deepEqual(speechChunks("  "), []);
});

test("pickSystemVoice prefers a natural voice in the user's language over novelty voices", () => {
  const v = (name: string, lang: string, localService = true) => ({ name, lang, localService }) as SpeechSynthesisVoice;
  const voices = [v("Zarvox", "en-US"), v("Thomas", "fr-FR"), v("Samantha", "en-US"), v("Ava (Premium)", "en-US")];
  assert.equal(pickSystemVoice(voices, "en-US")?.name, "Ava (Premium)");
  assert.equal(pickSystemVoice(voices, "fr-FR")?.name, "Thomas");
  assert.equal(pickSystemVoice([], "en-US"), null);
});

// -- the speaker -----------------------------------------------------------------

test("Speaker: speech off speaks nothing; on, it uses the system voice until Kokoro is ready", async () => {
  const log: Spoken[] = [];
  const system = fakeEngine("system", log);
  const kokoro = fakeKokoroLike(log, "absent");
  const off = new Speaker({ system, kokoro, settings: settingsOf({ speak: false }) });
  await off.say("Hello there.");
  assert.equal(log.length, 0);
  assert.equal(off.enabled(), false);

  const on = new Speaker({ system, kokoro, settings: settingsOf() });
  await on.say("Hello there.");
  assert.deepEqual(log.map((l) => l.engine), ["system"]);
  assert.equal(kokoro.loads, 0, "an absent Kokoro is never loaded (or downloaded) by speaking");
});

test("Speaker: a downloaded Kokoro starts loading on first speech and speaks once ready", async () => {
  const log: Spoken[] = [];
  const system = fakeEngine("system", log);
  const kokoro = fakeKokoroLike(log, "cached");
  const sp = new Speaker({ system, kokoro, settings: settingsOf({ kokoroVoice: "af_bella", rate: 1.15 }) });
  await sp.say("First.");
  assert.equal(kokoro.loads, 1);
  assert.equal(log[0]!.engine, "system");
  kokoro.state = "ready";
  kokoro.setReady(true);
  await sp.say("Second.");
  assert.equal(log[1]!.engine, "kokoro");
  assert.deepEqual(log[1]!.opts, { voice: "af_bella", rate: 1.15 });
  const sys = new Speaker({ system, kokoro, settings: settingsOf({ engine: "system" }) });
  assert.equal(sys.engineId(), "system");
});

test("Speaker: one queue (no overlap), next chunk prepared ahead, stop() drops the rest", async () => {
  const log: Spoken[] = [];
  const kokoro = fakeKokoroLike(log, "ready");
  const manual = fakeEngine("kokoro", log, { manual: true });
  Object.assign(kokoro, { speak: manual.speak, prepare: manual.prepare });
  const sp = new Speaker({ system: null, kokoro, settings: settingsOf() });
  const long = "Alpha sentence one is here. " + "Beta ".repeat(60).trim() + ".";
  const a = sp.say(long);
  const b = sp.say("Gamma.");
  await flush();
  assert.equal(log.length, 1, "only one utterance at a time");
  assert.equal(manual.prepared.length, 1, "the next chunk is synthesised while this one plays");
  manual.pending.shift()!();
  await flush();
  assert.equal(log.length, 2);
  sp.stop();
  await a;
  await b;
  await flush();
  assert.equal(log.length, 2, "queued speech is dropped by stop()");
  assert.ok(manual.stops >= 0);
});

test("speakingNarrator: reading pace when speech is off, speech when on, reading pace when speech fails", async () => {
  const log: Spoken[] = [];
  const slept: string[] = [];
  const fallback: Narrator = { present: async (t) => void slept.push(t) };
  const offSp = new Speaker({ system: fakeEngine("system", log), kokoro: null, settings: settingsOf({ speak: false }) });
  await speakingNarrator(offSp, fallback).present("Step one.", new AbortController().signal);
  assert.deepEqual(slept, ["Step one."]);
  const onSp = new Speaker({ system: fakeEngine("system", log), kokoro: null, settings: settingsOf() });
  await speakingNarrator(onSp, fallback).present("Step two.", new AbortController().signal);
  assert.equal(log.at(-1)!.text, "Step two.");
  assert.deepEqual(slept, ["Step one."]);
  const bad = new Speaker({ system: fakeEngine("system", log, { fail: true }), kokoro: null, settings: settingsOf() });
  await speakingNarrator(bad, fallback).present("Step three.", new AbortController().signal);
  assert.deepEqual(slept, ["Step one.", "Step three."]);
});

test("ExplainPlayer asks the narrator to prepare the step after the one playing", async () => {
  const prepared: string[] = [];
  const gates: (() => void)[] = [];
  const narrator: Narrator = {
    present: () => new Promise<void>((r) => gates.push(r)),
    prepare: (t) => void prepared.push(t),
  };
  const p = new ExplainPlayer({ narrator, onView: () => undefined });
  p.start();
  p.add({ call: "c", i: 0, say: "One", keep: false });
  p.add({ call: "c", i: 1, say: "Two", keep: false });
  p.add({ call: "c", i: 2, say: "Three", keep: false });
  await flush();
  assert.ok(prepared.includes("Two"), JSON.stringify(prepared));
  assert.ok(!prepared.includes("Three"), "only the next step, not the whole list");
  gates.shift()!();
  await flush();
  assert.ok(prepared.includes("Three"));
  p.clear();
});

// -- Kokoro -------------------------------------------------------------------------

test("Kokoro: nothing is fetched until Download; the probe reads the browser cache", async () => {
  const fresh = kokoroWith();
  assert.equal(await fresh.k.probe(), "absent");
  fresh.k.load(); // not on disk: load() must not download
  assert.equal(fresh.workers.length, 0);
  const sp = new Speaker({ system: fakeEngine("system", []), kokoro: fresh.k, settings: settingsOf() });
  await sp.say("Hello.");
  assert.equal(fresh.workers.length, 0, "speaking never starts the download");

  const have = kokoroWith(fakeCaches([KOKORO_WEIGHTS_URL]));
  assert.equal(await have.k.probe(), "cached");
});

test("Kokoro: Download loads the pinned q8 model on WASM in a worker, with progress", async () => {
  const { k, workers } = kokoroWith();
  await k.probe();
  const states: string[] = [];
  k.subscribe(() => states.push(k.state));
  const done = k.download();
  assert.equal(workers.length, 1);
  const w = workers[0]!;
  assert.deepEqual(w.sent[0], { t: "load", lib: KOKORO_LIB_URL, model: KOKORO_MODEL, dtype: "q8", device: "wasm" });
  assert.match(KOKORO_LIB_URL, /kokoro-js@1\.2\.1\//, "a pinned library version");
  w.reply({ t: "progress", file: "onnx/model_quantized.onnx", loaded: 46_000_000, total: 92_361_116 });
  w.reply({ t: "progress", file: "config.json", loaded: 100, total: 100 });
  assert.equal(k.state, "downloading");
  assert.equal(k.progress.loaded, 46_000_100);
  w.reply({ t: "ready" });
  await done;
  assert.equal(k.state, "ready");
  assert.deepEqual([...new Set(states)], ["downloading", "ready"]);
  assert.ok(KOKORO_DOWNLOAD_MB >= 100, "the size the user is told covers weights + runtime");
});

test("Kokoro: speaking posts a gen request and plays the samples; unload keeps it on disk", async () => {
  const { k, workers, audio } = kokoroWith();
  const ready = k.download();
  workers[0]!.reply({ t: "ready" });
  await ready;
  const o = { voice: "af_heart", rate: 1 };
  k.prepare("Hi.", o);
  const said = k.speak("Hi.", o, new AbortController().signal);
  const gens = workers[0]!.sent.filter((m) => m["t"] === "gen");
  assert.equal(gens.length, 1, "prepared clip is reused, not synthesised twice");
  assert.deepEqual({ ...gens[0], id: 0 }, { t: "gen", id: 0, text: "Hi.", voice: "af_heart", speed: 1 });
  workers[0]!.reply({ t: "audio", id: gens[0]!["id"], audio: new Float32Array(2400), rate: 24000 });
  await said;
  assert.deepEqual(audio.played, [2400]);
  k.unload();
  assert.equal(workers[0]!.terminated, true);
  assert.equal(k.state, "cached", "unloading frees memory, not the download");
});

test("Kokoro: a failed load reports the error (the system voice keeps reading); remove() deletes the cache", async () => {
  const caches = fakeCaches([KOKORO_WEIGHTS_URL, `https://huggingface.co/${KOKORO_MODEL}/resolve/main/config.json`, "https://other/x"]);
  const { k, workers } = kokoroWith(caches);
  await k.probe();
  const p = k.whenReady();
  workers[0]!.reply({ t: "error", message: "out of memory" });
  await assert.rejects(p, /out of memory/);
  assert.equal(k.state, "failed");
  assert.equal(k.error, "out of memory");
  await k.remove();
  assert.deepEqual([...caches.entries], ["https://other/x"]);
  assert.deepEqual(caches.deleted, ["kokoro-voices"]);
  assert.equal(k.state, "absent");
});

test("Kokoro: a stalled synthesis rejects instead of hanging the walkthrough", async () => {
  const w = new FakeWorker();
  const k = new KokoroVoice({ spawn: () => w, audio: fakeAudio(), caches: null, stallMs: () => 5 });
  const r = k.download();
  w.reply({ t: "ready" });
  await r;
  await assert.rejects(k.speak("never answered", { voice: "af_heart", rate: 1 }, new AbortController().signal), /too long/);
});

test("the worker source is plain JS that imports the library it is told to", () => {
  assert.match(KOKORO_WORKER_SOURCE, /await import\(m\.lib\)/);
  assert.match(KOKORO_WORKER_SOURCE, /from_pretrained\(m\.model/);
  assert.doesNotMatch(KOKORO_WORKER_SOURCE, /require\(|: string|=>\s*void/);
});

// -- chat: push to talk + read aloud --------------------------------------------------

function fakeSession() {
  let hooks: VoiceHooks | null = null;
  const s = {
    starts: 0,
    stops: 0,
    listening: false,
    hooks: () => hooks!,
    make: (h: VoiceHooks): VoiceSession => {
      hooks = h;
      return {
        start: () => {
          s.starts++;
          s.listening = true;
        },
        stop: () => {
          s.stops++;
        },
        get listening() {
          return s.listening;
        },
      };
    },
    end(text: string) {
      s.listening = false;
      hooks!.onFinal(text);
      hooks!.onEnd?.();
    },
  };
  return s;
}

function chatVoiceRig(opts: { kokoroState?: "absent" | "cached"; busy?: boolean; ask?: "download" | "system" | "closed" } = {}) {
  resetVoiceSettingsCache();
  updateVoiceSettings(defaultVoiceSettings());
  const input = document.createElement("textarea");
  const sent: string[] = [];
  const session = fakeSession();
  const log: Spoken[] = [];
  const kk = kokoroWith(fakeCaches(opts.kokoroState === "cached" ? [KOKORO_WEIGHTS_URL] : []));
  const speaker = new Speaker({ system: fakeEngine("system", log), kokoro: kk.k });
  let t = 1000;
  const asked: number[] = [];
  let bargeIns = 0;
  const cv = new ChatVoice({
    input,
    send: () => {
      sent.push(input.value);
      input.value = "";
    },
    busy: () => opts.busy ?? false,
    speaker,
    kokoro: kk.k,
    createVoice: session.make,
    onBargeIn: () => void bargeIns++,
    askKokoro: async () => {
      asked.push(1);
      return opts.ask ?? "system";
    },
    now: () => t,
  });
  return {
    cv,
    input,
    sent,
    session,
    log,
    kk,
    asked,
    bargeIns: () => bargeIns,
    advance: (ms: number) => {
      t += ms;
    },
    mic: () => asFake(cv.el).querySelector(".fxvoice-mic")!,
    speakBtn: () => asFake(cv.el).querySelector(".fxvoice-speak")!,
  };
}

test("push to talk: hold, speak, release sends the transcript", () => {
  const r = chatVoiceRig();
  const mic = r.mic();
  fire(mic, "pointerdown", { button: 0, pointerId: 1 });
  assert.equal(r.session.starts, 1);
  assert.equal(r.bargeIns(), 1, "talking stops a playing walkthrough");
  assert.match(textOf(mic), /Listening/);
  r.session.hooks().onPartial?.("make it");
  assert.equal(asFake(r.input).value, "make it");
  r.advance(HOLD_MS + 50);
  fire(mic, "pointerup", { button: 0 });
  assert.equal(r.session.stops, 1, "release ends listening");
  fire(mic, "click");
  assert.equal(r.session.starts, 1, "the click after a press is not a second press");
  r.session.end("make it blue");
  assert.deepEqual(r.sent, ["make it blue"]);
  assert.match(textOf(mic), /Hold to talk/);
  r.cv.dispose();
});

test("push to talk: a tap keeps listening until the pause; a busy chat keeps the text in the box", () => {
  const r = chatVoiceRig({ busy: true });
  asFake(r.input).value = "also";
  fire(r.mic(), "pointerdown", { button: 0, pointerId: 1 });
  r.advance(80);
  fire(r.mic(), "pointerup", { button: 0 });
  assert.equal(r.session.stops, 0, "a tap does not stop at release");
  r.session.end("slower please");
  assert.deepEqual(r.sent, []);
  assert.equal(asFake(r.input).value, "also slower please");
  r.cv.dispose();
});

test("push to talk: keyboard toggles; mic errors read plainly", () => {
  const r = chatVoiceRig();
  fire(r.mic(), "click");
  assert.equal(r.session.starts, 1);
  fire(r.mic(), "click");
  assert.equal(r.session.stops, 1);
  assert.match(micErrorText("not-allowed"), /blocked/);
  assert.equal(micErrorText("aborted"), "");
  r.cv.dispose();
});

test("read aloud: first switch-on asks about the Kokoro download; closing the sheet leaves it off", async () => {
  const r = chatVoiceRig({ kokoroState: "absent", ask: "closed" });
  fire(r.speakBtn(), "click");
  await flush();
  assert.equal(r.asked.length, 1);
  assert.equal(getVoiceSettings().speak, false);
  assert.equal(r.kk.workers.length, 0, "no download without the user's Download press");
  r.cv.dispose();

  const s = chatVoiceRig({ kokoroState: "absent", ask: "system" });
  fire(s.speakBtn(), "click");
  await flush();
  assert.equal(getVoiceSettings().speak, true, "system voice for now");
  assert.equal(asFake(s.speakBtn()).getAttribute("aria-pressed"), "true");
  s.cv.speakReply("Done. I made it **blue**.");
  await flush();
  assert.deepEqual(s.log.map((l) => l.text), ["Done. I made it blue."]);
  fire(s.speakBtn(), "click");
  await flush();
  assert.equal(getVoiceSettings().speak, false);
  s.cv.dispose();
});

test("read aloud: with Kokoro downloaded, switching on asks nothing and starts loading it", async () => {
  const r = chatVoiceRig({ kokoroState: "cached" });
  fire(r.speakBtn(), "click");
  await flush();
  assert.equal(r.asked.length, 0);
  assert.equal(getVoiceSettings().speak, true);
  assert.equal(r.kk.workers.length, 1, "loads from the cache");
  assert.equal(r.kk.k.state, "loading");
  r.cv.dispose();
  updateVoiceSettings(defaultVoiceSettings());
});

// -- Settings ▸ AI ▸ Voice --------------------------------------------------------------

function group(legend: string): HTMLElement {
  const g = document.createElement("div");
  const l = document.createElement("div");
  l.className = "settings-legend";
  l.textContent = legend;
  g.appendChild(l);
  return g;
}

test("Settings ▸ AI ▸ Voice: Kokoro selected by default with an explicit sized Download", async () => {
  resetVoiceSettingsCache();
  updateVoiceSettings(defaultVoiceSettings());
  const kk = kokoroWith();
  const speaker = new Speaker({ system: fakeEngine("system", []), kokoro: kk.k });
  const card = asFake(voiceSettingsCard(group, { speaker, kokoro: kk.k }));
  await flush();
  const text = textOf(card);
  assert.match(text, /Read replies aloud/);
  assert.match(text, /Push to talk|speech recognition/);
  const voiceSeg = card.querySelectorAll(".settings-seg")[1]!;
  assert.equal(voiceSeg.querySelector(".on")?.textContent, "Kokoro");
  const dl = card.querySelectorAll("button").find((b: FakeElement) => /Download \(\d+ MB\)/.test(b.textContent));
  assert.ok(dl, text);
  assert.match(dl!.textContent, new RegExp(`${KOKORO_DOWNLOAD_MB} MB`));
  assert.equal(kk.workers.length, 0);
  dl!.click();
  assert.equal(kk.workers.length, 1, "Download starts it");
  await flush();
  assert.match(textOf(card), /Downloading the Kokoro voice/);
  const cancel = card.querySelectorAll("button").find((b: FakeElement) => b.textContent === "Cancel");
  cancel!.click();
  assert.equal(kk.workers[0]!.terminated, true);
  // Switching to the system voice hides the Kokoro block.
  voiceSeg.querySelectorAll("button")[1]!.click();
  assert.equal(getVoiceSettings().engine, "system");
  assert.doesNotMatch(textOf(card), /Download \(/);
  updateVoiceSettings(defaultVoiceSettings());
});

test("Settings ▸ AI ▸ Voice: where nothing can speak, it says so", () => {
  const speaker = new Speaker({ system: null, kokoro: null });
  const card = asFake(voiceSettingsCard(group, { speaker, kokoro: null }));
  assert.match(textOf(card), /can't speak/);
});
