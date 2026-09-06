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
  DEFAULT_WLLAMA_CONTEXT,
  type AiConfig,
  type ProviderKind,
  type CloudVendor,
} from "../../effects/ai/provider";
import { listOpenAiModels, pullOllamaModel } from "../../effects/ai/providers/openaiCompat";
import {
  isWllamaSupported,
  loadWllamaModel,
  unloadWllamaModel,
  downloadWllamaModel,
  deleteWllamaModel,
  isWllamaModelDownloaded,
  isWllamaModelLoaded,
  wllamaModelSupportsTools,
} from "../../effects/ai/providers/wllama";
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

const KINDS: ProviderKind[] = ["cloud", "local", "webllm", "wllama"];

/** A few small, tool-capable GGUFs (Qwen family → the `<tool_call>` convention
 * our parser expects) known to run on-CPU in-browser, lightest first. The URL
 * matches wllamaModelSupportsTools() so the tool path is enabled; users can paste
 * any GGUF URL in the field below. Phones are memory/speed bound, so the small
 * ones are the realistic picks — the tiny models handle MIDI/structured tools
 * well but authoring a whole effect (set_script) wants the 1.5B. */
const RECOMMENDED_WLLAMA: { label: string; url: string }[] = [
  {
    label: "Granite 4.0 350M (Q4) — ~0.25 GB · tiniest, tool-aware (dense)",
    url: "https://huggingface.co/unsloth/granite-4.0-350m-GGUF/resolve/main/granite-4.0-350m-Q4_K_M.gguf",
  },
  {
    label: "Qwen3 0.6B (Q8) — ~0.6 GB · lightest with good tools",
    url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf",
  },
  {
    label: "Qwen2.5 0.5B Instruct (Q4) — ~0.4 GB · tiny, basic tools",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
  },
  {
    label: "Qwen2.5 1.5B Instruct (Q4) — ~1 GB · best for authoring effects",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
  },
  {
    label: "Qwen2.5 3B Instruct (Q4) — ~2 GB · most capable, heaviest",
    url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
  },
];
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
      case "wllama":
        panel = wllamaPanel();
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

// -- In-browser CPU (wllama) -------------------------------------------------
// The phone-friendly path: llama.cpp→WASM on the CPU, so it never touches the
// GPU (no freeze/artifacts) — just slower, best with a small model.

/** A friendly display name for a wllama GGUF URL (its recommended label, else
 * the filename sans extension). */
function wllamaTitle(url: string): string {
  const rec = RECOMMENDED_WLLAMA.find((m) => m.url === url);
  if (rec) return rec.label;
  const file = url.split("/").pop() ?? url;
  return file.replace(/\.gguf(\?.*)?$/i, "");
}
/** The HuggingFace model page for a `…/resolve/<rev>/<file>.gguf` URL. */
function wllamaHfUrl(url: string): string | undefined {
  return url.match(/^(https:\/\/huggingface\.co\/[^/]+\/[^/]+)\/resolve\//)?.[1];
}

// In-browser CPU (wllama): the phone-friendly path. Uses the SAME model-manager
// component as WebGPU (scrollview cards + download/load/delete + search + add).
function wllamaPanel(): HTMLElement {
  const cfgW = (): AiConfig["wllama"] => getAiConfig().wllama;
  const toVM = (url: string): ModelVM => {
    const tools = wllamaModelSupportsTools(url);
    return {
      id: url,
      title: wllamaTitle(url),
      tools,
      badges: tools ? [{ label: "Tools", kind: "tools" }] : [],
      hfUrl: wllamaHfUrl(url),
    };
  };
  const threadsField = field({
    label: "Threads (0 = auto)",
    type: "number",
    value: String(cfgW().nThreads),
    onInput: (v) => {
      const n = parseInt(v, 10);
      if (n >= 0) updateAiConfig({ wllama: { ...cfgW(), nThreads: n } });
    },
  });
  const src: ModelSource = {
    title: "In-browser (CPU)",
    supported: isWllamaSupported(),
    unsupportedNote: "This browser has no WebAssembly — the CPU model can't run here.",
    // wllama models are arbitrary GGUFs (not a curated tool-only catalog), so
    // don't hide non-tool models by default.
    toolsOnlyDefault: false,
    extraFields: [threadsField],
    ctx: {
      get: () => cfgW().contextWindowSize,
      default: DEFAULT_WLLAMA_CONTEXT,
      set: (n) => updateAiConfig({ wllama: { ...cfgW(), contextWindowSize: n } }),
    },
    active: () => cfgW().model,
    pinned: () => cfgW().pinned,
    addPin: (id) => {
      const p = cfgW().pinned;
      if (!p.includes(id)) updateAiConfig({ wllama: { ...cfgW(), pinned: [...p, id] } });
    },
    loadCatalog: async () => RECOMMENDED_WLLAMA.map((m) => toVM(m.url)),
    cardFor: (id) => toVM(id),
    isDownloaded: (id) => isWllamaModelDownloaded(id),
    isLoaded: (id) => isWllamaModelLoaded(id),
    download: (id, onP) => downloadWllamaModel(id, onP),
    load: (id, onP) => loadWllamaModel(id, cfgW().contextWindowSize, cfgW().nThreads, onP),
    unload: () => unloadWllamaModel(),
    delete: (id) => deleteWllamaModel(id),
    setActive: (id) => updateAiConfig({ wllama: { ...cfgW(), model: id } }),
    clearActive: () => updateAiConfig({ wllama: { ...cfgW(), model: "" } }),
    add: {
      label: "Add a model by GGUF URL",
      placeholder: "https://huggingface.co/…/resolve/main/model.gguf",
      validate: (id) =>
        /^https?:\/\/.+\.gguf(\?.*)?$/i.test(id)
          ? null
          : "Enter a direct .gguf URL (a HuggingFace “resolve” link)",
    },
    footerNote:
      "Runs the model on the CPU, in your browser, on your device — it never touches " +
      "the GPU, so it won't freeze the phone the way the WebGPU option can. It's slower " +
      "(a few tokens/sec) and best with a small (1–3B) model. Weights download from " +
      "HuggingFace on first use and cache locally. Multi-threading needs a " +
      "cross-origin-isolated page; otherwise it runs single-threaded. Tool-calling " +
      "(needed to generate effects and map MIDI) works on Qwen2.5-Instruct / Hermes models.",
    toolsWarn: (id) =>
      id && !wllamaModelSupportsTools(id)
        ? `⚠ ${wllamaTitle(id)} isn't a tool-calling model, so it can only chat — it ` +
          `can't generate effects or map MIDI. Pick a model with the “Tools” badge.`
        : null,
  };
  return modelManagerPanel(src);
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

// -- Shared in-browser model manager (WebGPU + CPU) --------------------------
// One component drives BOTH in-browser tabs: the scrollview of model cards with
// per-model download / load / delete controls + progress, a search box, a
// "tool-calling only" filter, an "add by id/URL" field, and a configurable
// context window. Each provider supplies a ModelSource adapter.

/** A model as shown in the manager (webllm: id-named; wllama: URL-keyed). */
interface ModelVM {
  /** Stable key passed to download/load/delete + compared to the active model. */
  id: string;
  /** Display name in the card head. */
  title: string;
  /** Can it drive tool calls (effect generation + MIDI mapping)? */
  tools: boolean;
  badges: { label: string; kind?: string }[];
  hfUrl?: string | undefined;
}

/** Progress of a per-model download / load (0..1 + a label). */
interface ManagerProgress {
  progress: number;
  text: string;
}

/** Per-provider behavior the shared manager drives. */
interface ModelSource {
  title: string;
  supported: boolean;
  unsupportedNote: string;
  /** Whether the "Tool-calling only" filter starts on. */
  toolsOnlyDefault: boolean;
  /** Extra provider-specific fields (e.g. wllama threads), shown under context. */
  extraFields?: HTMLElement[];
  ctx: { get: () => number; default: number; set: (n: number) => void };
  active: () => string;
  pinned: () => string[];
  addPin: (id: string) => void;
  loadCatalog: () => Promise<ModelVM[]>;
  cardFor: (id: string) => ModelVM;
  isDownloaded: (id: string) => Promise<boolean>;
  isLoaded: (id: string) => boolean;
  download: (id: string, onProgress: (p: ManagerProgress) => void) => Promise<void>;
  load: (id: string, onProgress: (p: ManagerProgress) => void) => Promise<void>;
  unload: () => Promise<void>;
  delete: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  clearActive: () => void;
  add: {
    label: string;
    placeholder: string;
    /** Return an error message to reject the id, or null to accept. `catalog` is
     * the loaded model list (so webllm can require catalog membership). */
    validate: (id: string, catalog: ModelVM[]) => string | null;
  };
  footerNote: string;
  /** Warning shown when the active model can't tool-call (or null). */
  toolsWarn: (id: string) => string | null;
}

function modelManagerPanel(src: ModelSource): HTMLElement {
  const g = group(src.title);
  if (!src.supported) {
    g.append(note(src.unsupportedNote));
    return g;
  }

  // Local state — chips update in place; only the list rebuilds (not this whole
  // panel), so search focus and in-flight operations survive.
  let toolsOnly = src.toolsOnlyDefault;
  let query = "";
  let cards: ModelVM[] = [];
  const downloaded = new Map<string, boolean>();
  const busy = new Map<string, "download" | "load" | "delete">();

  const warn = note("");
  warn.classList.add("aiset-warn");
  function refreshWarn(): void {
    const w = src.toolsWarn(src.active());
    warn.style.display = w ? "block" : "none";
    if (w) warn.textContent = w;
  }

  const search = field({
    label: "Search models",
    placeholder: "e.g. Hermes, Llama, Qwen, Phi",
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

  // Context window (tokens). The per-model default is often too small for our
  // grounded prompts; configurable here. Takes effect on the next load.
  const ctxField = field({
    label: "Context window (tokens)",
    type: "number",
    value: String(src.ctx.get()),
    placeholder: String(src.ctx.default),
    onInput: (v) => {
      const n = parseInt(v, 10);
      src.ctx.set(Number.isFinite(n) && n > 0 ? n : src.ctx.default);
    },
  });

  const cardsEl = document.createElement("div");
  cardsEl.className = "aiset-cards";
  const listStatus = document.createElement("div");
  listStatus.className = "aiset-progress-text";
  listStatus.textContent = "Loading model list…";

  function renderCards(): void {
    const pins = src.pinned();
    const shown: ModelVM[] = [
      ...pins.map((id) => src.cardFor(id)),
      ...cards.filter(
        (c) =>
          !pins.includes(c.id) &&
          (!toolsOnly || c.tools) &&
          (c.title.toLowerCase().includes(query) || c.id.toLowerCase().includes(query)),
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

  function chipEl(card: ModelVM): HTMLElement {
    const id = card.id;
    const el = document.createElement("div");
    el.className = "aiset-card" + (id === src.active() ? " on" : "");

    const nameRow = document.createElement("div");
    nameRow.className = "aiset-card-head";
    const name = document.createElement("div");
    name.className = "aiset-card-name";
    name.textContent = card.title;

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
    for (const b of card.badges) badges.append(badge(b.label, b.kind));

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
      const loaded = src.isLoaded(id);
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
      void src.isDownloaded(id).then((d) => {
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
        await src.download(id, (p) =>
          chipBar.set(Math.round(p.progress * 100), p.text || "Downloading…"),
        );
        downloaded.set(id, true);
        toast(`Downloaded ${card.title}`);
      } catch (e) {
        toast(`Download failed: ${msg(e)}`, { error: true });
      } finally {
        busy.delete(id);
        applyDownload();
      }
    });

    trashBtn.addEventListener("click", async () => {
      if (busy.get(id)) return;
      if (!confirm(`Delete downloaded model?\n\n${card.title}\n\nThis frees its cached weights.`))
        return;
      busy.set(id, "delete");
      applyDownload();
      try {
        await src.delete(id);
        downloaded.set(id, false);
        if (src.active() === id) {
          src.clearActive();
          refreshWarn();
        }
        toast(`Deleted ${card.title}`);
      } catch (e) {
        toast(`Delete failed: ${msg(e)}`, { error: true });
      } finally {
        busy.delete(id);
        applyDownload();
        applyLoad();
        el.classList.toggle("on", id === src.active());
      }
    });

    loadBtn.addEventListener("click", async () => {
      if (busy.get(id) && busy.get(id) !== "load") return;
      const wasLoaded = src.isLoaded(id);
      busy.set(id, "load");
      applyLoad();
      try {
        if (wasLoaded) {
          await src.unload();
          src.clearActive();
          toast("Model unloaded");
        } else {
          await src.load(id, (p) =>
            chipBar.set(Math.round(p.progress * 100), p.text || "Loading…"),
          );
          downloaded.set(id, true);
          src.setActive(id);
          toast(`Loaded ${card.title}`);
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
        el.classList.toggle("on", id === src.active());
      }
    });

    return el;
  }

  // Add a model by id/URL (pins it so its chip shows).
  const addField = field({ label: src.add.label, placeholder: src.add.placeholder });
  const addBtn = Button({
    label: "Add",
    variant: "quiet",
    onClick: () => {
      const id = addField.querySelector("input")?.value.trim() ?? "";
      if (!id) {
        toast("Enter a model id/URL", { error: true });
        return;
      }
      const err = src.add.validate(id, cards);
      if (err) {
        toast(err, { error: true });
        return;
      }
      src.addPin(id);
      const input = addField.querySelector("input");
      if (input) input.value = "";
      renderCards();
      toast(`Added ${src.cardFor(id).title}`);
    },
  });
  const addRow = document.createElement("div");
  addRow.className = "aiset-row";
  addRow.append(addField, addBtn);

  g.append(warn, ctxField, ...(src.extraFields ?? []), search, filterRow, cardsEl, listStatus, addRow, note(src.footerNote));

  refreshWarn();
  src
    .loadCatalog()
    .then((cs) => {
      cards = cs;
      listStatus.textContent = `${cs.length} models available`;
      renderCards();
    })
    .catch((e) => {
      listStatus.textContent = `Couldn't load model list: ${msg(e)}`;
      renderCards(); // still show pinned/custom models
    });

  return g;
}

// -- In-browser WebGPU (web-llm) — the model browser -------------------------

function webLlmPanel(): HTMLElement {
  const cfgW = (): AiConfig["webllm"] => getAiConfig().webllm;
  const toVM = (c: WebLlmModelCard): ModelVM => {
    const badges: { label: string; kind?: string }[] = [];
    if (c.tools) badges.push({ label: "Tools", kind: "tools" });
    if (c.vramMB) badges.push({ label: `${(c.vramMB / 1024).toFixed(1)} GB VRAM` });
    if (c.lowResource) badges.push({ label: "Low-resource" });
    return { id: c.id, title: c.id, tools: c.tools, badges, hfUrl: c.hfUrl ?? undefined };
  };
  const src: ModelSource = {
    title: "In-browser (WebGPU)",
    supported: isWebLlmSupported(),
    unsupportedNote:
      "This browser doesn't expose WebGPU, so in-browser (WebGPU) inference isn't " +
      "available. Try a recent Chrome/Edge, use the CPU option, or a local server. " +
      "On phones the CPU option is recommended — WebGPU can freeze the device.",
    toolsOnlyDefault: true,
    ctx: {
      get: () => cfgW().contextWindowSize,
      default: DEFAULT_WEBLLM_CONTEXT,
      set: (n) => updateAiConfig({ webllm: { ...cfgW(), contextWindowSize: n } }),
    },
    active: () => cfgW().model,
    pinned: () => cfgW().pinned,
    addPin: (id) => {
      const p = cfgW().pinned;
      if (!p.includes(id)) updateAiConfig({ webllm: { ...cfgW(), pinned: [...p, id] } });
    },
    loadCatalog: () => listWebLlmModelCards().then((cs) => cs.map(toVM)),
    cardFor: (id) =>
      toVM({
        id,
        vramMB: null,
        lowResource: false,
        tools: modelSupportsTools(id),
        hfUrl: `https://huggingface.co/mlc-ai/${id}`,
      }),
    isDownloaded: (id) => isModelDownloaded(id),
    isLoaded: (id) => isModelLoaded(id),
    download: (id, onP) => downloadWebLlmModel(id, onP),
    load: (id, onP) => loadWebLlmModel(id, onP, cfgW().contextWindowSize),
    unload: () => unloadWebLlmModel(),
    delete: (id) => deleteWebLlmModel(id),
    setActive: (id) => updateAiConfig({ webllm: { ...cfgW(), model: id } }),
    clearActive: () => updateAiConfig({ webllm: { ...cfgW(), model: "" } }),
    add: {
      label: "Add a model by id",
      placeholder: "e.g. Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
      // Only listed MLC models can actually run in-browser.
      validate: (id, catalog) =>
        catalog.some((c) => c.id === id) ? null : `“${id}” isn't in web-llm's catalog`,
    },
    footerNote:
      "Models run entirely in your browser on the GPU; weights download from " +
      "HuggingFace on first use and cache locally. Use ↓ to download, </> to " +
      "load/unload, and the trash icon to delete. Only listed MLC-compiled models " +
      "work here — to run an arbitrary HuggingFace GGUF, use the CPU option or a " +
      "local server (Ollama). Tool-calling (needed to generate effects and map MIDI) " +
      "is limited to models with a “Tools” badge. On a phone, prefer the CPU option — " +
      "a big WebGPU model can freeze the device.",
    toolsWarn: (id) =>
      id && !modelSupportsTools(id)
        ? `⚠ ${id} can't use tools, so it can't generate effects or map MIDI — it will ` +
          `only chat. Pick a model with the “Tools” badge.`
        : null,
  };
  return modelManagerPanel(src);
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
