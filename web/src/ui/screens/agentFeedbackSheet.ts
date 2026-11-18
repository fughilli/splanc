/**
 * "Report a problem with this answer" (docs/design/agent-feedback.md): the sheet
 * a thumbs-down on an AI turn opens. Reason chips + an optional note, a preview
 * of exactly what will be sent (redacted, per-section opt-out, rebuilt on every
 * change), explicit consent, then send — or queue it on this device when
 * offline — or export it as a file instead.
 */

import {
  DEFAULT_OMITTED,
  FEEDBACK_REASONS,
  OPT_IN_HINT,
  FEEDBACK_SECTIONS,
  sectionSummary,
  type FeedbackReason,
  type FeedbackReport,
  type FeedbackSectionId,
} from "../../feedback/agentTrace";
import { buildAppFeedback, sendOrQueue, type FeedbackScreenContext } from "../../feedback/appFeedback";
import { feedbackFile } from "../../feedback/feedbackClient";
import { Button, Chip, Sheet, Switch, icon, toast } from "../kit";

const STYLE_ID = "agent-feedback-styles";

export function installAgentFeedbackStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.afb-report { display: inline-flex; align-items: center; gap: 4px; margin-top: var(--sp-1);
  background: none; border: 0; padding: 2px 6px; border-radius: var(--r-ctrl); color: var(--text-dim);
  font: inherit; font-size: var(--f-caption); cursor: pointer; }
.afb-report:hover, .afb-report:focus-visible { color: var(--text); background: var(--surface-2); }
.afb-report svg { width: 14px; height: 14px; }
.afb-report--done { color: var(--ok); cursor: default; }
.afb { display: flex; flex-direction: column; gap: var(--sp-3); padding-bottom: var(--sp-4); }
.afb h3 { margin: 0; font-size: var(--f-body); font-weight: 600; }
.afb-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.afb-note { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; background: var(--surface-2);
  color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctrl); padding: var(--sp-2);
  font: inherit; }
.afb-sections { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--r-card); }
.afb-sec { border-top: 1px solid var(--border); }
.afb-sec:first-child { border-top: 0; }
.afb-sec-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
.afb-sec-text { flex: 1; min-width: 0; }
.afb-sec-label { display: block; }
.afb-sec-sum { display: block; color: var(--text-dim); font-size: var(--f-caption); }
.afb-sec-hint { display: block; color: var(--accent); font-size: var(--f-caption); margin-top: 2px; }
.afb-sec details { padding: 0 var(--sp-3) var(--sp-2); }
.afb-sec summary { color: var(--text-dim); font-size: var(--f-caption); cursor: pointer; }
.afb-pre { margin: var(--sp-1) 0 0; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  background: var(--bg); border-radius: var(--r-ctrl); padding: var(--sp-2); font-family: var(--font-mono);
  font-size: 0.72rem; color: var(--text-dim); }
.afb-fine { color: var(--text-dim); font-size: var(--f-caption); margin: 0; line-height: 1.4; }
.afb-flags { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.afb-flag { font-size: var(--f-caption); padding: 2px 8px; border-radius: 999px; background: var(--surface-2);
  color: var(--warn); }
.afb-consent { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--f-caption); line-height: 1.4; }
.afb-consent input { margin-top: 2px; }
.afb-actions { display: flex; gap: var(--sp-2); justify-content: flex-end; flex-wrap: wrap; }
`;
  document.head.appendChild(s);
}

/** Plain-English names for the automatic findings. */
export const FLAG_LABELS: Record<string, string> = {
  claimed_sent_not_sent: "Said it sent the effect, but nothing was sent",
  held_on_uncalibrated_estimate: "Held back on an uncalibrated estimate",
  compile_failed: "The last compile failed",
  tool_error: "A tool failed",
  exhausted: "Ran out of steps",
  turn_error: "The turn ended in an error",
};

/** The small "Report" button under an AI reply. */
export function reportButton(onClick: () => void): HTMLButtonElement {
  installAgentFeedbackStyles();
  const b = document.createElement("button");
  b.type = "button";
  b.className = "afb-report";
  b.title = "Report a problem with this answer";
  b.setAttribute("aria-label", "Report a problem with this answer");
  b.append(icon("thumbs-down"));
  const t = document.createElement("span");
  t.textContent = "Report";
  b.append(t);
  b.addEventListener("click", onClick);
  return b;
}

function sectionPreview(r: FeedbackReport, id: FeedbackSectionId): string {
  const v = r.sections[id];
  return v === undefined ? "(left out)" : JSON.stringify(v, null, 2);
}

/**
 * Open the report sheet for turn `turn`. Resolves with the outcome once the
 * sheet closes ("sent" | "queued" | null when cancelled).
 */
export function openAgentFeedbackSheet(
  ctx: FeedbackScreenContext,
  turn: number,
  opts: { initialReasons?: FeedbackReason[] } = {},
): Promise<"sent" | "queued" | null> {
  installAgentFeedbackStyles();
  return new Promise((resolve) => {
    let outcome: "sent" | "queued" | null = null;
    const sheet = Sheet("Report a problem with this answer", { onClose: () => resolve(outcome) });
    const root = document.createElement("div");
    root.className = "afb";
    sheet.body.appendChild(root);

    const reasons = new Set<FeedbackReason>(opts.initialReasons ?? []);
    // Conversation + effect code start OFF: the user opts in (owner decision).
    const omit = new Set<FeedbackSectionId>(DEFAULT_OMITTED);
    let report: FeedbackReport | null = null;
    let building = 0;

    // -- what went wrong -----------------------------------------------------
    const h1 = document.createElement("h3");
    h1.textContent = "What went wrong?";
    const chips = document.createElement("div");
    chips.className = "afb-chips";
    for (const r of FEEDBACK_REASONS) {
      const c = Chip({
        label: r.label,
        on: reasons.has(r.id),
        onClick: () => {
          if (reasons.has(r.id)) reasons.delete(r.id);
          else reasons.add(r.id);
          c.classList.toggle("k-chip--on", reasons.has(r.id));
          c.setAttribute("aria-pressed", String(reasons.has(r.id)));
          void rebuild();
        },
      });
      c.dataset["reason"] = r.id;
      c.setAttribute("aria-pressed", String(reasons.has(r.id)));
      chips.appendChild(c);
    }
    const note = document.createElement("textarea");
    note.className = "afb-note";
    note.placeholder = "Anything else we should know? (optional)";
    note.maxLength = 2000;
    let noteTimer: ReturnType<typeof setTimeout> | null = null;
    note.addEventListener("input", () => {
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(() => void rebuild(), 400);
    });

    // -- found automatically -------------------------------------------------
    const flagsWrap = document.createElement("div");
    flagsWrap.className = "afb-flags";

    // -- what will be sent ---------------------------------------------------
    const h2 = document.createElement("h3");
    h2.textContent = "What will be sent";
    const always = document.createElement("p");
    always.className = "afb-fine";
    always.textContent =
      "Always: your reasons and note, the app version, which AI and model you use, the findings above and a fingerprint " +
      "of the AI's instructions. Never: passwords, Wi-Fi names, keys or tokens, fixture names or addresses, or where you are.";
    const secWrap = document.createElement("div");
    secWrap.className = "afb-sections";
    const sums = new Map<FeedbackSectionId, HTMLElement>();
    const pres = new Map<FeedbackSectionId, HTMLElement>();
    for (const s of FEEDBACK_SECTIONS) {
      const row = document.createElement("div");
      row.className = "afb-sec";
      row.dataset["section"] = s.id;
      const head = document.createElement("div");
      head.className = "afb-sec-head";
      const text = document.createElement("div");
      text.className = "afb-sec-text";
      const label = document.createElement("span");
      label.className = "afb-sec-label";
      label.textContent = s.label;
      const sum = document.createElement("span");
      sum.className = "afb-sec-sum";
      text.append(label, sum);
      if (DEFAULT_OMITTED.includes(s.id)) {
        const hint = document.createElement("span");
        hint.className = "afb-sec-hint";
        hint.textContent = OPT_IN_HINT;
        text.append(hint);
      }
      const sw = Switch({
        on: !omit.has(s.id),
        label: `Include: ${s.label}`,
        onChange: (on) => {
          if (on) omit.delete(s.id);
          else omit.add(s.id);
          void rebuild();
        },
      });
      head.append(text, sw.el);
      const det = document.createElement("details");
      const ds = document.createElement("summary");
      ds.textContent = "Show exactly what's sent";
      const pre = document.createElement("pre");
      pre.className = "afb-pre";
      det.append(ds, pre);
      row.append(head, det);
      secWrap.appendChild(row);
      sums.set(s.id, sum);
      pres.set(s.id, pre);
    }
    const sizeLine = document.createElement("p");
    sizeLine.className = "afb-fine";

    // -- consent + actions ----------------------------------------------------
    const consent = document.createElement("label");
    consent.className = "afb-consent";
    const box = document.createElement("input");
    box.type = "checkbox";
    const ctext = document.createElement("span");
    ctext.textContent =
      "Send this to the Splanc team to help fix the AI. It's stored privately (never posted publicly), kept for 90 days, " +
      "and you can ask for it to be deleted.";
    consent.append(box, ctext);
    const exportBtn = Button({ label: "Export instead", variant: "quiet", icon: "download", onClick: () => void doExport() });
    const sendBtn = Button({ label: "Send report", onClick: () => void doSend() });
    const actions = document.createElement("div");
    actions.className = "afb-actions";
    actions.append(exportBtn, sendBtn);
    box.addEventListener("change", syncButtons);

    root.append(h1, chips, note, flagsWrap, h2, always, secWrap, sizeLine, consent, actions);

    function syncButtons(): void {
      sendBtn.disabled = !(report && reasons.size > 0 && box.checked);
      exportBtn.disabled = !(report && reasons.size > 0);
    }

    async function rebuild(): Promise<void> {
      const mine = ++building;
      const r = await buildAppFeedback(ctx, {
        turn,
        reasons: [...reasons],
        note: note.value,
        omit: [...omit],
        ...(report ? { id: report.id } : {}),
      });
      if (mine !== building) return;
      report = r;
      flagsWrap.replaceChildren();
      for (const f of r.flags) {
        const el = document.createElement("span");
        el.className = "afb-flag";
        el.textContent = FLAG_LABELS[f] ?? f;
        flagsWrap.appendChild(el);
      }
      for (const s of FEEDBACK_SECTIONS) {
        sums.get(s.id)!.textContent = sectionSummary(r, s.id);
        pres.get(s.id)!.textContent = sectionPreview(r, s.id);
      }
      const kb = Math.ceil(JSON.stringify(r).length / 1024);
      sizeLine.textContent =
        `About ${kb} KB. ${r.redactions} private detail${r.redactions === 1 ? "" : "s"} masked.` +
        (r.truncated.length ? ` Shortened to fit: ${r.truncated.join("; ")}.` : "");
      syncButtons();
    }

    async function doSend(): Promise<void> {
      if (!report || !box.checked || reasons.size === 0) return;
      sendBtn.disabled = true;
      const r = await sendOrQueue(report);
      if (r.state === "sent") {
        outcome = "sent";
        toast("Thanks — report sent. You'll see its status under the answer.");
        sheet.close();
      } else if (r.state === "queued") {
        outcome = "queued";
        toast(r.message);
        sheet.close();
      } else {
        toast(r.message, { error: true });
        syncButtons();
      }
    }

    function doExport(): void {
      if (!report) return;
      const f = feedbackFile(report);
      const url = URL.createObjectURL(new Blob([f.text], { type: f.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    void rebuild();
  });
}
