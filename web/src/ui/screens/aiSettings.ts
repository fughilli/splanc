/**
 * AI settings (FUG-87) — pick where the editor's AI runs, and manage on-device
 * models. Three top-level categories (3 buttons):
 *   - Cloud — a vendor (Anthropic / OpenAI / Gemini / Grok / OpenRouter /
 *     Custom) + that vendor's API key. Anthropic uses its native API; the rest
 *     go through the OpenAI-compatible client pointed at the vendor's endpoint.
 *   - Local server (OpenAI-compatible) — Ollama / LM Studio / llama.cpp, with
 *     model listing and an Ollama model download (incl. HuggingFace GGUFs).
 *   - In-browser (WebGPU) — web-llm; a model browser where each model can be
 *     downloaded, loaded, and deleted (weights cache in the browser).
 *
 * Text inputs write through {@link setLive} (persist, no rebuild) so typing
 * doesn't lose focus; structural changes (category / vendor) rebuild via
 * {@link set}.
 */

import { Button, Card, icon, toast, type IconName } from "../kit";
import type { Router, Screen } from "../app/router";
import { installSettingsStyles } from "./settings.css";
import { installAiSettingsStyles } from "./aiSettings.css";
import {
  getAiConfig,
  updateAiConfig,
  isAiConfigured,
  kindLabel,
  CLOUD_VENDORS,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_WEBLLM_CONTEXT,
  type AiConfig,
  type ProviderKind,
  type CloudVendor,
} from "../../effects/ai/provider";
import { listOpenAiModels, pullOllamaModel } from "../../effects/ai/providers/openaiCompat";
import {
  isWebLlmSupported,
  listWebLlmModelCards,
  loadWebLlmModel,
  unloadWebLlmModel,
  downloadWebLlmModel,
  deleteWebLlmModel,
  isModelDownloaded,
  isModelLoaded,
  modelSupportsTools,
  type WebLlmModelCard,
} from "../../effects/ai/providers/webllm";

const KINDS: ProviderKind[] = ["cloud", "local", "webllm"];
const VENDORS = Object.keys(CLOUD_VENDORS) as CloudVendor[];

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

  /** Persist + rebuild (category / vendor switches). */
  function set(patch: Partial<AiConfig>): void {
    updateAiConfig(patch);
    rerender();
  }
  /** Persist without rebuilding (text inputs) — keeps focus, updates status. */
  function setLive(patch: Partial<AiConfig>): void {
    updateAiConfig(patch);
    syncStatus();
  }

  function syncStatus(): void {
    const cfg = getAiConfig();
    const ok = isAiConfigured(cfg);
    status.classList.toggle("ok", ok);
    let where = kindLabel(cfg.kind);
    if (cfg.kind === "cloud") where += ` · ${CLOUD_VENDORS[cfg.cloud.vendor].label}`;
    status.textContent = ok ? `Ready — using ${where}.` : `${where} is not configured yet.`;
  }

  function rerender(): void {
    const cfg = getAiConfig();
    syncStatus();
    let panel: HTMLElement;
    switch (cfg.kind) {
      case "local":
        panel = localPanel(cfg, setLive);
        break;
      case "webllm":
        panel = webLlmPanel();
        break;
      case "cloud":
      default:
        panel = cloudPanel(cfg, set, setLive);
        break;
    }
    body.replaceChildren(kindGroup(cfg.kind, (k) => set({ kind: k })), panel);
  }

  rerender();
  return { el };
}

// -- category chooser (3 buttons) --------------------------------------------

function kindGroup(active: ProviderKind, onPick: (k: ProviderKind) => void): HTMLElement {
  const g = group("Provider");
  const seg = document.createElement("div");
  seg.className = "settings-seg";
  for (const k of KINDS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = kindLabel(k);
    if (k === active) b.classList.add("on");
    b.addEventListener("click", () => onPick(k));
    seg.appendChild(b);
  }
  g.append(seg);
  return g;
}

// -- Cloud -------------------------------------------------------------------

function cloudPanel(
  cfg: AiConfig,
  set: (p: Partial<AiConfig>) => void,
  setLive: (p: Partial<AiConfig>) => void,
): HTMLElement {
  const g = group("Cloud");
  const vendor = cfg.cloud.vendor;
  const meta = CLOUD_VENDORS[vendor];
  const v = cfg.cloud.vendors[vendor];

  // Patch just the active vendor's settings.
  const setVendor = (
    patch: Partial<{ key: string; model: string; baseUrl: string }>,
    live: boolean,
  ): void => {
    const c = getAiConfig();
    const vendors = { ...c.cloud.vendors, [vendor]: { ...c.cloud.vendors[vendor], ...patch } };
    (live ? setLive : set)({ cloud: { ...c.cloud, vendors } });
  };

  // Vendor picker (rebuilds to show that vendor's fields).
  g.append(
    labeledSelect<CloudVendor>(
      "Provider",
      Object.fromEntries(VENDORS.map((x) => [x, CLOUD_VENDORS[x].label])) as Record<
        CloudVendor,
        string
      >,
      vendor,
      (x) => set({ cloud: { ...getAiConfig().cloud, vendor: x } }),
    ),
  );

  // Custom endpoint (only for the "custom" vendor; others are fixed).
  if (vendor === "custom") {
    g.append(
      field({
        label: "Server URL",
        value: v.baseUrl,
        placeholder: "https://…/v1",
        onInput: (val) => setVendor({ baseUrl: val.trim() }, true),
      }),
    );
  }

  g.append(
    field({
      label: "API key",
      type: "password",
      value: v.key,
      placeholder: meta.keyHint,
      onInput: (val) => setVendor({ key: val.trim() }, true),
    }),
  );

  // Model row: free-text + a "List" button (skipped for Anthropic, which has no
  // OpenAI-style /models endpoint).
  const modelField = field({
    label: "Model",
    value: v.model,
    placeholder: meta.modelPlaceholder,
    onInput: (val) => setVendor({ model: val.trim() }, true),
  });
  if (meta.native) {
    g.append(modelField);
  } else {
    const picker = document.createElement("select");
    picker.className = "aiset-field";
    picker.style.display = "none";
    picker.addEventListener("change", () => {
      if (picker.value) set({ cloud: mergeVendor(vendor, { model: picker.value }) });
    });
    const listBtn = Button({
      label: "List",
      variant: "quiet",
      onClick: async () => {
        listBtn.disabled = true;
        try {
          const cur = getAiConfig().cloud.vendors[vendor];
          const models = await listOpenAiModels({
            baseUrl: cur.baseUrl,
            key: cur.key,
            model: cur.model,
            vision: false,
          });
          fillSelect(picker, models, cur.model);
          picker.style.display = models.length ? "block" : "none";
          toast(models.length ? `${models.length} model(s)` : "No models returned");
        } catch (e) {
          toast(`List failed: ${msg(e)}`, { error: true });
        } finally {
          listBtn.disabled = false;
        }
      },
    });
    const row = document.createElement("div");
    row.className = "aiset-row";
    row.append(modelField, listBtn);
    g.append(row, picker);
  }

  g.append(
    note(
      `Used only in your browser, sent directly to ${meta.label}. Never uploaded ` +
        `to any server. Pick a model that supports tool calling so effect ` +
        `generation and MIDI mapping work.`,
    ),
  );
  return g;
}

/** Build a full cloud patch that merges a change into one vendor. */
function mergeVendor(vendor: CloudVendor, patch: Partial<{ model: string }>): AiConfig["cloud"] {
  const c = getAiConfig().cloud;
  return { ...c, vendors: { ...c.vendors, [vendor]: { ...c.vendors[vendor], ...patch } } };
}

// -- Local OpenAI-compatible server ------------------------------------------

function localPanel(cfg: AiConfig, setLive: (p: Partial<AiConfig>) => void): HTMLElement {
  const g = group("Local server (OpenAI-compatible)");

  g.append(
    field({
      label: "Server URL",
      value: cfg.local.baseUrl,
      placeholder: DEFAULT_OPENAI_BASE_URL,
      onInput: (v) => setLive({ local: { ...getAiConfig().local, baseUrl: v.trim() } }),
    }),
    field({
      label: "API key (optional)",
      type: "password",
      value: cfg.local.key,
      placeholder: "usually blank for local servers",
      onInput: (v) => setLive({ local: { ...getAiConfig().local, key: v.trim() } }),
    }),
  );

  const modelField = field({
    label: "Model",
    value: cfg.local.model,
    placeholder: "e.g. llama3.1:8b",
    onInput: (v) => setLive({ local: { ...getAiConfig().local, model: v.trim() } }),
  });
  const picker = document.createElement("select");
  picker.className = "aiset-field";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    if (picker.value) setLive({ local: { ...getAiConfig().local, model: picker.value } });
  });
  const listBtn = Button({
    label: "List",
    variant: "quiet",
    onClick: async () => {
      listBtn.disabled = true;
      try {
        const models = await listOpenAiModels(getAiConfig().local);
        fillSelect(picker, models, getAiConfig().local.model);
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

  g.append(
    settingsRow(
      "Vision",
      "Does this model accept images? Enables the AI to see the live preview.",
      onOff(cfg.local.vision, (on) => setLive({ local: { ...getAiConfig().local, vision: on } })),
    ),
  );

  const pullField = field({
    label: "Download a model (Ollama)",
    placeholder: "llama3.1:8b or hf.co/user/repo:Q4_K_M",
  });
  const bar = progressBar();
  const pullBtn = Button({
    label: "Download",
    icon: "download",
    onClick: async () => {
      const name = pullField.querySelector("input")?.value.trim() ?? "";
      if (!name) {
        toast("Enter a model name", { error: true });
        return;
      }
      pullBtn.disabled = true;
      bar.wrap.style.display = "block";
      try {
        await pullOllamaModel(getAiConfig().local, name, (p) => {
          const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : 0;
          bar.set(pct, `${p.status}${p.total ? ` — ${pct}%` : ""}`);
        });
        bar.set(100, "Done");
        toast(`Downloaded ${name}`);
        setLive({ local: { ...getAiConfig().local, model: name } });
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
        "For Ollama you can download a model right here — including any " +
        "HuggingFace GGUF via an hf.co/user/repo:quant reference. Pick an instruct " +
        "model that supports tool calling so effect generation and MIDI mapping work.",
    ),
  );
  return g;
}

// -- In-browser WebGPU (web-llm) — the model browser -------------------------

function webLlmPanel(): HTMLElement {
  const g = group("In-browser (WebGPU)");
  if (!isWebLlmSupported()) {
    g.append(
      note(
        "This browser doesn't expose WebGPU, so in-browser inference isn't " +
          "available. Try a recent Chrome/Edge, or use a local server instead.",
      ),
    );
    return g;
  }

  // Local state — chips update in place; only the list rebuilds (not this whole
  // panel), so search focus and in-flight operations survive.
  let toolsOnly = true;
  let query = "";
  let cards: WebLlmModelCard[] = [];
  const downloaded = new Map<string, boolean>();
  const busy = new Map<string, "download" | "load" | "delete">();
  const active = (): string => getAiConfig().webllm.model;
  const pinned = (): string[] => getAiConfig().webllm.pinned;

  const warn = note("");
  warn.classList.add("aiset-warn");
  function refreshWarn(): void {
    const m = active();
    const bad = m !== "" && !modelSupportsTools(m);
    warn.style.display = bad ? "block" : "none";
    if (bad) {
      warn.textContent =
        `⚠ ${m} can't use tools, so it can't generate effects or map MIDI — ` +
        `it will only chat. Pick a model with the “Tools” badge.`;
    }
  }

  const search = field({
    label: "Search models",
    placeholder: "e.g. Hermes, Llama, Phi",
    onInput: (v) => {
      query = v.trim().toLowerCase();
      renderCards();
    },
  });
  const filterRow = settingsRow(
    "Tool-calling only",
    "Only show models that can drive effect generation & MIDI mapping.",
    onOff(toolsOnly, (on) => {
      toolsOnly = on;
      renderCards();
    }),
  );

  // Context window (tokens). web-llm's per-model default (often 4096) is too
  // small for our grounded prompts (ContextWindowSizeExceededError); configurable
  // here. Takes effect on the next load (the engine reloads if it changed).
  const ctxField = field({
    label: "Context window (tokens)",
    type: "number",
    value: String(getAiConfig().webllm.contextWindowSize),
    placeholder: String(DEFAULT_WEBLLM_CONTEXT),
    onInput: (v) => {
      const n = parseInt(v, 10);
      updateAiConfig({
        webllm: {
          ...getAiConfig().webllm,
          contextWindowSize: Number.isFinite(n) && n > 0 ? n : DEFAULT_WEBLLM_CONTEXT,
        },
      });
    },
  });

  const cardsEl = document.createElement("div");
  cardsEl.className = "aiset-cards";
  const listStatus = document.createElement("div");
  listStatus.className = "aiset-progress-text";
  listStatus.textContent = "Loading model list…";

  /** Resolve a model id to a card (synthesizing one for pinned/custom ids). */
  function cardFor(id: string): WebLlmModelCard {
    const found = cards.find((c) => c.id === id);
    if (found) return found;
    return {
      id,
      vramMB: null,
      lowResource: false,
      tools: modelSupportsTools(id),
      hfUrl: `https://huggingface.co/mlc-ai/${id}`,
    };
  }

  function renderCards(): void {
    const pins = pinned();
    const shown: WebLlmModelCard[] = [
      ...pins.map(cardFor),
      ...cards.filter(
        (c) =>
          !pins.includes(c.id) &&
          (!toolsOnly || c.tools) &&
          c.id.toLowerCase().includes(query),
      ),
    ];
    cardsEl.replaceChildren();
    if (cards.length && !shown.length) {
      const e = document.createElement("div");
      e.className = "aiset-progress-text";
      e.textContent = "No models match this filter.";
      cardsEl.append(e);
    }
    for (const c of shown) cardsEl.append(chipEl(c));
  }

  function chipEl(card: WebLlmModelCard): HTMLElement {
    const id = card.id;
    const el = document.createElement("div");
    el.className = "aiset-card" + (id === active() ? " on" : "");

    const nameRow = document.createElement("div");
    nameRow.className = "aiset-card-head";
    const name = document.createElement("div");
    name.className = "aiset-card-name";
    name.textContent = id;

    // Controls: download (↓ / ✓ / bar), delete (trash), load (</>).
    const controls = document.createElement("div");
    controls.className = "aiset-card-ctrls";
    const dlBtn = ctrl("download", "Download");
    const trashBtn = ctrl("trash", "Delete downloaded model", "red");
    const loadBtn = ctrl("code", "Load model");
    controls.append(dlBtn, trashBtn, loadBtn);
    nameRow.append(name, controls);

    const chipBar = progressBar();
    chipBar.wrap.classList.add("aiset-chip-progress");

    const badges = document.createElement("div");
    badges.className = "aiset-badges";
    if (card.tools) badges.append(badge("Tools", "tools"));
    if (card.vramMB) badges.append(badge(`${(card.vramMB / 1024).toFixed(1)} GB VRAM`));
    if (card.lowResource) badges.append(badge("Low-resource"));

    el.append(nameRow, chipBar.wrap, badges);
    if (card.hfUrl) {
      const a = document.createElement("a");
      a.href = card.hfUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "View on HuggingFace ↗";
      el.append(a);
    }

    // -- visual state application -------------------------------------------
    function applyDownload(): void {
      const isDl = downloaded.get(id) === true;
      const b = busy.get(id);
      dlBtn.classList.toggle("green", isDl && b !== "download");
      dlBtn.classList.toggle("blue", !isDl && b !== "download");
      dlBtn.classList.toggle("busy", b === "download");
      setIcon(dlBtn, isDl && b !== "download" ? "check" : "download");
      dlBtn.disabled = b !== undefined;
      trashBtn.style.display = isDl && b === undefined ? "" : "none";
      if (b !== "download") chipBar.wrap.style.display = "none";
    }
    function applyLoad(): void {
      const loaded = isModelLoaded(id);
      const b = busy.get(id);
      loadBtn.classList.toggle("yellow", loaded && b !== "load");
      loadBtn.classList.toggle("gray", !loaded && b !== "load");
      loadBtn.classList.toggle("busy", b === "load");
      loadBtn.disabled = b !== undefined && b !== "load";
    }
    applyDownload();
    applyLoad();

    // Reflect the cached state asynchronously (once per chip).
    if (!downloaded.has(id)) {
      void isModelDownloaded(id).then((d) => {
        downloaded.set(id, d);
        applyDownload();
      });
    }

    // -- handlers ------------------------------------------------------------
    dlBtn.addEventListener("click", async () => {
      if (busy.get(id)) return;
      busy.set(id, "download");
      chipBar.wrap.style.display = "block";
      chipBar.set(0, "Starting…");
      applyDownload();
      try {
        await downloadWebLlmModel(id, (p) =>
          chipBar.set(Math.round(p.progress * 100), p.text || "Downloading…"),
        );
        downloaded.set(id, true);
        toast(`Downloaded ${id}`);
      } catch (e) {
        toast(`Download failed: ${msg(e)}`, { error: true });
      } finally {
        busy.delete(id);
        applyDownload();
      }
    });

    trashBtn.addEventListener("click", async () => {
      if (busy.get(id)) return;
      if (!confirm(`Delete downloaded model?\n\n${id}\n\nThis frees its cached weights.`)) return;
      busy.set(id, "delete");
      applyDownload();
      try {
        await deleteWebLlmModel(id);
        downloaded.set(id, false);
        if (active() === id) {
          updateAiConfig({ webllm: { ...getAiConfig().webllm, model: "" } });
          refreshWarn();
        }
        toast(`Deleted ${id}`);
      } catch (e) {
        toast(`Delete failed: ${msg(e)}`, { error: true });
      } finally {
        busy.delete(id);
        applyDownload();
        applyLoad();
        el.classList.toggle("on", id === active());
      }
    });

    loadBtn.addEventListener("click", async () => {
      if (busy.get(id) && busy.get(id) !== "load") return;
      const wasLoaded = isModelLoaded(id);
      busy.set(id, "load");
      applyLoad();
      try {
        if (wasLoaded) {
          await unloadWebLlmModel();
          updateAiConfig({ webllm: { ...getAiConfig().webllm, model: "" } });
          toast("Model unloaded");
        } else {
          await loadWebLlmModel(
            id,
            (p) => chipBar.set(Math.round(p.progress * 100), p.text || "Loading…"),
            getAiConfig().webllm.contextWindowSize,
          );
          downloaded.set(id, true);
          updateAiConfig({ webllm: { ...getAiConfig().webllm, model: id } });
          toast(`Loaded ${id}`);
        }
      } catch (e) {
        toast(`${wasLoaded ? "Unload" : "Load"} failed: ${msg(e)}`, { error: true });
      } finally {
        busy.delete(id);
        applyLoad();
        applyDownload();
        refreshWarn();
        // Refresh the "active" highlight across chips.
        for (const other of cardsEl.querySelectorAll(".aiset-card")) {
          other.classList.remove("on");
        }
        el.classList.toggle("on", id === active());
      }
    });

    return el;
  }

  // Add a model by id (pins it so its chip shows). Validated against the catalog
  // — only listed MLC models can actually run in-browser.
  const addField = field({
    label: "Add a model by id",
    placeholder: "e.g. Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
  });
  const addBtn = Button({
    label: "Add",
    variant: "quiet",
    onClick: () => {
      const id = addField.querySelector("input")?.value.trim() ?? "";
      if (!id) {
        toast("Enter a model id", { error: true });
        return;
      }
      if (!cards.some((c) => c.id === id)) {
        toast(`“${id}” isn't in web-llm's catalog`, { error: true });
        return;
      }
      const pins = pinned();
      if (!pins.includes(id)) {
        updateAiConfig({ webllm: { ...getAiConfig().webllm, pinned: [...pins, id] } });
      }
      const input = addField.querySelector("input");
      if (input) input.value = "";
      renderCards();
      toast(`Added ${id}`);
    },
  });
  const addRow = document.createElement("div");
  addRow.className = "aiset-row";
  addRow.append(addField, addBtn);

  g.append(
    warn,
    ctxField,
    search,
    filterRow,
    cardsEl,
    listStatus,
    addRow,
    note(
      "Models run entirely in your browser on the GPU; weights download from " +
        "HuggingFace on first use and cache locally. Use ↓ to download, </> to " +
        "load/unload, and the trash icon to delete. Only listed MLC-compiled " +
        "models work here — to run an arbitrary HuggingFace GGUF, use the local " +
        "server (Ollama). Tool-calling (needed to generate effects and map MIDI) " +
        "is limited to models with a “Tools” badge.",
    ),
  );

  refreshWarn();
  listWebLlmModelCards()
    .then((cs) => {
      cards = cs;
      listStatus.textContent = `${cs.length} models available`;
      renderCards();
    })
    .catch((e) => {
      listStatus.textContent = `Couldn't load model list: ${msg(e)}`;
    });

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

function badge(text: string, kind?: string): HTMLElement {
  const b = document.createElement("span");
  b.className = "aiset-badge" + (kind ? ` ${kind}` : "");
  b.textContent = text;
  return b;
}

/** A small round icon-button used for the per-chip download/load/delete actions. */
function ctrl(iconName: IconName, title: string, kind?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "aiset-ctrl" + (kind ? ` ${kind}` : "");
  b.title = title;
  b.setAttribute("aria-label", title);
  b.appendChild(icon(iconName));
  return b;
}

/** Swap the glyph inside a ctrl button. */
function setIcon(btn: HTMLButtonElement, iconName: IconName): void {
  btn.replaceChildren(icon(iconName));
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

/** A labeled <select> (used for the cloud vendor picker). */
function labeledSelect<T extends string>(
  label: string,
  labels: Record<T, string>,
  value: T,
  onPick: (v: T) => void,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "aiset-field";
  const cap = document.createElement("span");
  cap.textContent = label;
  const sel = document.createElement("select");
  for (const key of Object.keys(labels) as T[]) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = labels[key];
    if (key === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onPick(sel.value as T));
  wrap.append(cap, sel);
  return wrap;
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
