/**
 * Settings ▸ Privacy: "Send feedback to Fug Studio" (docs/design/device-metrics.md).
 *
 * Off by default. One switch turns sending on; each category then has its own
 * switch. "See exactly what's sent" opens the literal next upload (and the last
 * one), field by field. "Delete my data" is its own flow: what it does, a
 * confirmation, then the result.
 *
 * The settings screen's group/row/segmented builders are passed in, like the
 * other settings sections.
 */

import { deviceMetrics } from "../../metrics/appMetrics";
import { CATEGORY_INFO, METRIC_CATEGORIES, type MetricsCollector } from "../../metrics/collector";
import { DEVICE_FIELDS, USAGE_FIELDS, type MetricCategory } from "../../metrics/metricsSchema";
import { Button, Sheet, confirmDialog, toast } from "../kit";

type GroupFn = (legend: string) => HTMLElement;
type RowFn = (name: string, hint: string, control: HTMLElement) => HTMLElement;
type SegmentedFn = <T extends string>(options: [T, string][], value: T, onPick: (v: T) => void) => HTMLElement;

const ON_OFF: ["off" | "on", string][] = [
  ["off", "Off"],
  ["on", "On"],
];

export const PRIVACY_NOTICE_URL = "https://github.com/fughilli/splanc/blob/main/docs/privacy.md";

function when(t: number): string {
  if (!t) return "never";
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function para(text: string, cls = "settings-row-hint settings-full"): HTMLElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

/** The section; `rerender` rebuilds the settings panel after a change. */
export function privacyPanel(group: GroupFn, row: RowFn, segmented: SegmentedFn, rerender: () => void, m: MetricsCollector = deviceMetrics): HTMLElement[] {
  const s = m.settings();

  // -- Send feedback to Fug Studio ---------------------------------------------
  const g = group("Send feedback to Fug Studio");
  g.append(
    para(
      "Help us make Splanc better by sending how your players are doing: frame rates, memory, restarts, " +
        "Wi-Fi and Bluetooth drops, and how a mesh delivers. It's off unless you turn it on, you choose " +
        "each kind below, and you can see every value before it leaves. Never sent: names, Wi-Fi " +
        "networks, addresses, locations, maps, effects or anything you type.",
    ),
    row(
      "Send feedback",
      s.enabled ? "On: sent about every 6 hours while the app is open." : "Off: nothing is collected or sent.",
      segmented(ON_OFF, s.enabled ? "on" : "off", (v) => {
        m.setEnabled(v === "on");
        rerender();
      }),
    ),
  );
  if (s.enabled) {
    for (const c of METRIC_CATEGORIES) {
      g.append(
        row(
          CATEGORY_INFO[c].title,
          CATEGORY_INFO[c].summary,
          segmented(ON_OFF, s.categories[c] ? "on" : "off", (v) => {
            m.setCategory(c, v === "on");
            rerender();
          }),
        ),
      );
    }
    const status = s.lastResult
      ? `Last upload ${when(s.lastUploadAt)}. ${s.lastResult.ok ? "" : `Last try ${when(s.lastResult.at)}: ${s.lastResult.message}`}`
      : "Nothing sent yet. The first upload goes out a few minutes after a player connects.";
    g.append(para(status.trim()));
  }
  const actions = document.createElement("div");
  actions.className = "privacy-actions";
  actions.append(Button({ label: "See exactly what's sent", icon: "eye", block: true, onClick: () => void openWhatsSent(m) }));
  g.append(actions);

  // -- Your data --------------------------------------------------------------
  const d = group("Your data");
  d.append(
    para(
      "What's sent is kept for at most 90 days and is used only to find bugs and improve performance. " +
        "Your app and players go by random codes that change every 30 days, never linked to your " +
        "Splanc AI account or anything else about you.",
    ),
  );
  if (s.deletion) {
    const msg =
      s.deletion.status === "failed"
        ? `Deletion didn't go through (${when(s.deletion.at)}): ${s.deletion.message}`
        : `Deletion requested ${when(s.deletion.at)}. ${s.deletion.message}`;
    d.append(para(msg));
  }
  const notice = document.createElement("a");
  notice.href = PRIVACY_NOTICE_URL;
  notice.target = "_blank";
  notice.rel = "noopener";
  notice.className = "privacy-link";
  notice.textContent = "Read the privacy notice";
  const del = document.createElement("div");
  del.className = "privacy-actions";
  del.append(Button({ label: "Delete my data", icon: "trash", variant: "danger", block: true, onClick: () => void deleteFlow(m, rerender) }));
  d.append(notice, del);
  return [g, d];
}

// -- See exactly what's sent ----------------------------------------------------

function pre(text: string): HTMLElement {
  const p = document.createElement("pre");
  p.className = "privacy-payload";
  p.textContent = text;
  return p;
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "privacy-h";
  h.textContent = text;
  return h;
}

export async function openWhatsSent(m: MetricsCollector = deviceMetrics): Promise<void> {
  const sheet = Sheet("What's sent");
  sheet.body.classList.add("privacy-sheet");
  const s = m.settings();
  const render = async (): Promise<void> => {
    const next = await m.nextUpload();
    const parts: HTMLElement[] = [];
    if (!s.enabled) {
      parts.push(para("Sending is off, so nothing is collected or sent. This is what each kind would contain.", "privacy-note"));
    } else {
      parts.push(heading("Next upload"));
      if (next) {
        parts.push(para("This is the literal text the app will send, exactly as it is now.", "privacy-note"), pre(JSON.stringify(next, null, 2)));
      } else {
        parts.push(para("Nothing is waiting to be sent yet. Read the connected players now to see what they would add.", "privacy-note"));
      }
      const read = Button({
        label: "Read connected players now",
        block: true,
        onClick: () => {
          void m.sampleNow(true).then((n) => {
            toast(n ? `Read ${n} player${n === 1 ? "" : "s"}.` : "No connected player reports metrics yet (it needs newer firmware).");
            void render();
          });
        },
      });
      const actions = document.createElement("div");
      actions.className = "privacy-actions";
      actions.append(read);
      parts.push(actions);
      if (s.lastSent) parts.push(heading(`Last upload (${when(s.lastSent.at)})`), pre(JSON.stringify(s.lastSent.payload, null, 2)));
    }
    parts.push(heading("What each value means"));
    parts.push(
      para(
        "Every upload also carries the app version, the platform (web, iOS or Android), and for each player its " +
          "firmware version, board type, how it's connected, and a random code for the install and the player.",
        "privacy-note",
      ),
    );
    for (const c of METRIC_CATEGORIES) parts.push(fieldTable(c, s.enabled && s.categories[c]));
    sheet.body.replaceChildren(...parts);
  };
  await render();
}

function fieldTable(c: MetricCategory, on: boolean): HTMLElement {
  const box = document.createElement("section");
  box.className = "privacy-cat";
  const h = document.createElement("div");
  h.className = "privacy-cat-head";
  h.textContent = `${CATEGORY_INFO[c].title}: ${on ? "sent" : "not sent"}`;
  box.appendChild(h);
  const dl = document.createElement("dl");
  dl.className = "privacy-fields";
  for (const f of [...DEVICE_FIELDS, ...USAGE_FIELDS].filter((x) => x.category === c)) {
    const dt = document.createElement("dt");
    dt.textContent = f.name;
    const dd = document.createElement("dd");
    dd.textContent = f.unit ? `${f.label} (${f.unit})` : f.label;
    dl.append(dt, dd);
  }
  box.appendChild(dl);
  return box;
}

// -- Delete my data -------------------------------------------------------------

async function deleteFlow(m: MetricsCollector, rerender: () => void): Promise<void> {
  const ok = await confirmDialog({
    title: "Delete my data?",
    message:
      "Fug Studio deletes everything this app has sent, under every code it used, and sending is switched off. " +
      "It can take up to 7 days to finish. You can turn sending back on later; it starts fresh with new codes.",
    confirmLabel: "Delete my data",
    danger: true,
  });
  if (!ok) return;
  toast("Asking Fug Studio to delete your data…");
  const r = await m.deleteMyData();
  if (r.status === "failed") toast(r.message, { error: true });
  else if (r.status === "nothing") toast(r.message);
  else toast(r.status === "deleted" ? "Deletion requested. Sending is off." : "Deletion requested; it finishes within 7 days. Sending is off.");
  rerender();
}

// -- styles -----------------------------------------------------------------------

let installed = false;
export function installPrivacyStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const st = document.createElement("style");
  st.textContent = `
.privacy-actions { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
.privacy-link { display: inline-block; margin-top: var(--sp-2); color: var(--accent); }
.privacy-sheet { display: flex; flex-direction: column; gap: var(--sp-3); padding-bottom: var(--sp-5); }
.privacy-h { margin: var(--sp-3) 0 0; font-size: var(--f-body); }
.privacy-note { margin: 0; color: var(--text-dim); font-size: var(--f-caption); }
.privacy-payload {
  margin: 0; padding: var(--sp-3); max-height: 50vh; overflow: auto;
  background: var(--surface-2, rgba(127,127,127,0.08)); border: 1px solid var(--border);
  border-radius: var(--r-ctrl); font-family: var(--font-mono); font-size: 12px; line-height: 1.45;
  white-space: pre; overflow-wrap: normal;
}
.privacy-cat { border: 1px solid var(--border); border-radius: var(--r-ctrl); padding: var(--sp-3); }
.privacy-cat-head { font-weight: 600; margin-bottom: var(--sp-2); }
.privacy-fields { margin: 0; display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: var(--sp-1) var(--sp-3); }
.privacy-fields dt { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
.privacy-fields dd { margin: 0; color: var(--text-dim); font-size: var(--f-caption); }
@media (max-width: 480px) {
  .privacy-fields { grid-template-columns: minmax(0, 1fr); }
  .privacy-fields dd { margin-bottom: var(--sp-2); }
}
`;
  document.head.appendChild(st);
}
