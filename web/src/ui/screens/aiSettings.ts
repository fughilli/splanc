/**
 * AI settings (FUG-87) — pick where the editor's AI runs, and manage on-device
 * models. Three providers:
 *   - Anthropic (cloud, BYO key) — the default;
 *   - a local OpenAI-compatible server (Ollama / LM Studio / llama.cpp / vLLM),
 *     including downloading a model into Ollama with live progress;
 *   - an in-browser WebGPU model (web-llm), downloaded from HuggingFace and
 *     cached locally, à la pocketpal-ai.
 *
 * Every control writes straight through {@link updateAiConfig} (localStorage);
 * the active provider is read fresh on the next AI turn, so changes apply live.
 */

import { Button, Card, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { installSettingsStyles } from "./settings.css";
import { installAiSettingsStyles } from "./aiSettings.css";
import {
  getAiConfig,
  updateAiConfig,
  isAiConfigured,
  providerLabel,
  DEFAULT_OPENAI_BASE_URL,
  type AiConfig,
  type ProviderId,
} from "../../effects/ai/provider";
import { listOpenAiModels, pullOllamaModel } from "../../effects/ai/providers/openaiCompat";
import { isWebLlmSupported, listWebLlmModels, loadWebLlmModel } from "../../effects/ai/providers/webllm";

const PROVIDERS: ProviderId[] = ["anthropic", "openai", "webllm"];

export function AiSettingsScreen(_router: Router): Screen {
  installSettingsStyles();
  installAiSettingsStyles();

  const el = document.createElement("div");
  el.className = "screen screen--settings";

  const head = document.createElement("h1");
  head.className = "screen-headline";
  head.textContent = "AI provider";
  const sub = document.createElement("p");
  sub.className = "screen-sub";
  sub.textContent =
    "Choose where effect generation and MIDI remapping run. Everything stays on your device — no proxy server.";
  el.append(head, sub);

  const status = document.createElement("p");
  status.className = "aiset-status";
  el.append(status);

  const body = document.createElement("div");
  el.appendChild(body);

  function set(patch: Partial<AiConfig>): void {
    updateAiConfig(patch);
    rerender();
  }

  function syncStatus(): void {
    const cfg = getAiConfig();
    const ok = isAiConfigured(cfg);
    status.classList.toggle("ok", ok);
    status.textContent = ok
      ? `Ready — using ${providerLabel(cfg.provider)}.`
      : `${providerLabel(cfg.provider)} is not configured yet.`;
  }

  function rerender(): void {
    const cfg = getAiConfig();
    syncStatus();
    let panel: HTMLElement;
    switch (cfg.provider) {
      case "openai":
        panel = openAiPanel(cfg, set);
        break;
      case "webllm":
        panel = webLlmPanel(cfg, set);
        break;
      case "anthropic":
      default:
        panel = anthropicPanel(cfg, set);
        break;
    }
    body.replaceChildren(providerGroup(cfg.provider, (p) => set({ provider: p })), panel);
  }

  rerender();
  return { el };
}

// -- provider chooser --------------------------------------------------------

function providerGroup(active: ProviderId, onPick: (p: ProviderId) => void): HTMLElement {
  const g = group("Provider");
  const seg = document.createElement("div");
  seg.className = "settings-seg";
  for (const p of PROVIDERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = providerLabel(p);
    if (p === active) b.classList.add("on");
    b.addEventListener("click", () => onPick(p));
    seg.appendChild(b);
  }
  g.append(seg);
  return g;
}

// -- Anthropic ---------------------------------------------------------------

function anthropicPanel(cfg: AiConfig, set: (p: Partial<AiConfig>) => void): HTMLElement {
  const g = group("Anthropic (cloud)");
  g.append(
    field({
      label: "API key",
      type: "password",
      value: cfg.anthropic.key,
      placeholder: "sk-ant-…",
      onInput: (v) => set({ anthropic: { ...getAiConfig().anthropic, key: v.trim() } }),
    }),
    field({
      label: "Model",
      value: cfg.anthropic.model,
      placeholder: "claude-opus-4-8",
      onInput: (v) => set({ anthropic: { ...getAiConfig().anthropic, model: v.trim() } }),
    }),
    note("Used only in your browser, sent directly to Anthropic. Never uploaded to any server."),
  );
  return g;
}

// -- Local OpenAI-compatible server ------------------------------------------

function openAiPanel(cfg: AiConfig, set: (p: Partial<AiConfig>) => void): HTMLElement {
  const g = group("Local server (OpenAI-compatible)");

  g.append(
    field({
      label: "Server URL",
      value: cfg.openai.baseUrl,
      placeholder: DEFAULT_OPENAI_BASE_URL,
      onInput: (v) => set({ openai: { ...getAiConfig().openai, baseUrl: v.trim() } }),
    }),
    field({
      label: "API key (optional)",
      type: "password",
      value: cfg.openai.key,
      placeholder: "usually blank for local servers",
      onInput: (v) => set({ openai: { ...getAiConfig().openai, key: v.trim() } }),
    }),
  );

  // Model row: a free-text field (servers name models differently) plus a
  // "List" button that fetches the server's installed models into a picker.
  const modelField = field({
    label: "Model",
    value: cfg.openai.model,
    placeholder: "e.g. llama3.1:8b",
    onInput: (v) => set({ openai: { ...getAiConfig().openai, model: v.trim() } }),
  });
  const picker = document.createElement("select");
  picker.className = "aiset-field";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    if (picker.value) set({ openai: { ...getAiConfig().openai, model: picker.value } });
  });
  const listBtn = Button({
    label: "List",
    variant: "quiet",
    onClick: async () => {
      listBtn.disabled = true;
      try {
        const models = await listOpenAiModels(getAiConfig().openai);
        fillSelect(picker, models, getAiConfig().openai.model);
        picker.style.display = models.length ? "block" : "none";
        toast(models.length ? `${models.length} model(s) available` : "No models installed");
      } catch (e) {
        toast(`List failed: ${msg(e)}`, { error: true });
      } finally {
        listBtn.disabled = false;
      }
    },
  });
  const modelRow = document.createElement("div");
  modelRow.className = "aiset-row";
  modelRow.append(modelField, listBtn);
  g.append(modelRow, picker);

  // Vision toggle — advertise the preview-image tool only if this model sees.
  g.append(
    settingsRow(
      "Vision",
      "Does this model accept images? Enables the AI to see the live preview.",
      onOff(cfg.openai.vision, (on) => set({ openai: { ...getAiConfig().openai, vision: on } })),
    ),
  );

  // Ollama pull: download a model into the server with a progress bar.
  const pullField = field({ label: "Download a model (Ollama)", placeholder: "e.g. llama3.1:8b" });
  const bar = progressBar();
  const pullBtn = Button({
    label: "Download",
    icon: "sparkles",
    onClick: async () => {
      const name = pullField.querySelector("input")?.value.trim() ?? "";
      if (!name) {
        toast("Enter a model name", { error: true });
        return;
      }
      pullBtn.disabled = true;
      bar.wrap.style.display = "block";
      try {
        await pullOllamaModel(getAiConfig().openai, name, (p) => {
          const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : 0;
          bar.set(pct, `${p.status}${p.total ? ` — ${pct}%` : ""}`);
        });
        bar.set(100, "Done");
        toast(`Downloaded ${name}`);
        set({ openai: { ...getAiConfig().openai, model: name } });
      } catch (e) {
        bar.set(0, `Failed: ${msg(e)}`);
        toast(`Download failed: ${msg(e)}`, { error: true });
      } finally {
        pullBtn.disabled = false;
      }
    },
  });
  const pullRow = document.createElement("div");
  pullRow.className = "aiset-row";
  pullRow.append(pullField, pullBtn);
  g.append(
    pullRow,
    bar.wrap,
    note(
      "Run a local model server and point the app at it. Ollama exposes " +
        "http://localhost:11434/v1; LM Studio and llama.cpp use their own ports. " +
        "For Ollama you can download a model right here; other runtimes manage " +
        "models themselves.",
    ),
  );
  return g;
}

// -- In-browser WebGPU (web-llm) ---------------------------------------------

function webLlmPanel(cfg: AiConfig, set: (p: Partial<AiConfig>) => void): HTMLElement {
  const g = group("In-browser (WebGPU)");
  const supported = isWebLlmSupported();

  if (!supported) {
    g.append(
      note(
        "This browser doesn't expose WebGPU, so in-browser inference isn't " +
          "available. Try a recent Chrome/Edge, or use a local server instead.",
      ),
    );
    return g;
  }

  const modelField = field({
    label: "Model",
    value: cfg.webllm.model,
    placeholder: "e.g. Llama-3.1-8B-Instruct-q4f32_1-MLC",
    onInput: (v) => set({ webllm: { ...getAiConfig().webllm, model: v.trim() } }),
  });
  const picker = document.createElement("select");
  picker.className = "aiset-field";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    if (picker.value) set({ webllm: { ...getAiConfig().webllm, model: picker.value } });
  });
  const browseBtn = Button({
    label: "Browse",
    variant: "quiet",
    onClick: async () => {
      browseBtn.disabled = true;
      try {
        const models = await listWebLlmModels();
        fillSelect(picker, models, getAiConfig().webllm.model);
        picker.style.display = models.length ? "block" : "none";
      } catch (e) {
        toast(`Couldn't load model list: ${msg(e)}`, { error: true });
      } finally {
        browseBtn.disabled = false;
      }
    },
  });
  const modelRow = document.createElement("div");
  modelRow.className = "aiset-row";
  modelRow.append(modelField, browseBtn);

  const bar = progressBar();
  const loadBtn = Button({
    label: "Download / load model",
    icon: "sparkles",
    block: true,
    onClick: async () => {
      const model = getAiConfig().webllm.model;
      if (!model) {
        toast("Pick a model first", { error: true });
        return;
      }
      loadBtn.disabled = true;
      bar.wrap.style.display = "block";
      try {
        await loadWebLlmModel(model, (p) => bar.set(Math.round(p.progress * 100), p.text));
        bar.set(100, "Ready");
        toast("Model loaded");
      } catch (e) {
        bar.set(0, `Failed: ${msg(e)}`);
        toast(`Load failed: ${msg(e)}`, { error: true });
      } finally {
        loadBtn.disabled = false;
      }
    },
  });

  g.append(
    modelRow,
    picker,
    loadBtn,
    bar.wrap,
    note(
      "The model runs entirely in your browser on the GPU. Weights download " +
        "from HuggingFace on first use (hundreds of MB to a few GB) and are cached " +
        "locally, so later runs are offline. Larger models need more GPU memory.",
    ),
  );
  return g;
}

// -- small local builders ----------------------------------------------------

function group(legend: string): HTMLElement {
  const card = Card();
  card.classList.add("settings-group");
  const l = document.createElement("div");
  l.className = "settings-legend";
  l.textContent = legend;
  card.appendChild(l);
  return card;
}

function field(opts: {
  label: string;
  type?: string;
  value?: string;
  placeholder?: string;
  onInput?: (v: string) => void;
}): HTMLElement {
  const label = document.createElement("label");
  label.className = "aiset-field";
  const cap = document.createElement("span");
  cap.textContent = opts.label;
  const input = document.createElement("input");
  input.type = opts.type ?? "text";
  input.autocomplete = "off";
  if (opts.value) input.value = opts.value;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.onInput) input.addEventListener("input", () => opts.onInput?.(input.value));
  label.append(cap, input);
  return label;
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "aiset-note";
  p.textContent = text;
  return p;
}

function settingsRow(name: string, hint: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "settings-row";
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

function onOff(value: boolean, onPick: (on: boolean) => void): HTMLElement {
  const seg = document.createElement("div");
  seg.className = "settings-seg";
  for (const [v, label] of [
    [false, "Off"],
    [true, "On"],
  ] as [boolean, string][]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (v === value) b.classList.add("on");
    b.addEventListener("click", () => onPick(v));
    seg.appendChild(b);
  }
  return seg;
}

function fillSelect(sel: HTMLSelectElement, options: string[], current: string): void {
  sel.replaceChildren();
  if (!options.includes(current) && current) options = [current, ...options];
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    if (o === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

interface Bar {
  wrap: HTMLElement;
  set: (pct: number, text: string) => void;
}
function progressBar(): Bar {
  const wrap = document.createElement("div");
  wrap.style.display = "none";
  const track = document.createElement("div");
  track.className = "aiset-progress";
  const fill = document.createElement("i");
  track.appendChild(fill);
  const text = document.createElement("div");
  text.className = "aiset-progress-text";
  wrap.append(track, text);
  return {
    wrap,
    set: (pct, t) => {
      fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      text.textContent = t;
    },
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
