/**
 * "Share admin access" (docs/design/share-links.md): a mesh's or a fixture's admin access
 * as one Splanc link, handed to the system share sheet (Messages, mail, a chat app) or
 * copied. The link opens the receiver's Splanc at #/share (shareScreen.ts).
 *
 * The link is made when the sheet opens (and again when the code switch flips), so the
 * Share tap calls navigator.share() with nothing awaited first: iOS refuses a share that
 * isn't still inside the tap.
 */

import { Button, Sheet, Switch, toast } from "../kit";
import { formatCode, makeShareLink, type MadeLink, type ShareKind } from "../../net/shareLink";
import { APP_BASE } from "../../kits/kits";
import { installMeshStyles } from "./meshUi.css";

export interface ShareSheetOpts {
  kind: ShareKind;
  /** What is shared, as the sheet and the receiver name it. */
  title: string;
  /** What whoever opens the link can do. */
  grants: string;
  body: () => Promise<unknown>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Where links point: this app when it is served over https (a PR preview, a dev server),
 * splanc.io from the native app (capacitor://) or plain http. */
export function shareBase(loc: Pick<Location, "protocol" | "origin" | "pathname"> = location): string {
  return loc.protocol === "https:" ? `${loc.origin}${loc.pathname}` : APP_BASE;
}

export function openShareSheet(opts: ShareSheetOpts): void {
  installMeshStyles();
  const sheet = Sheet(`Share “${opts.title}”`);
  const body = h("div", "mesh-sheet");
  body.append(
    h("div", "mesh-row-hint", `${opts.grants} Send it only to someone you'd give your own phone to: a link can't be taken back.`),
  );

  let made: MadeLink | null = null;
  let withCode = false;
  let gen = 0;

  const codeRow = h("div", "mesh-row");
  const codeText = h("div", "mesh-row-text");
  const codeTitle = h("span", "mesh-row-title", "Send a code separately");
  codeTitle.id = "share-code-title";
  codeText.append(
    codeTitle,
    h("span", "mesh-row-hint", "The link then needs a code to open. Say it, or send it another way, so the link alone (say, a chat's history) isn't enough."),
  );
  const sw = Switch({
    on: false,
    label: "Send a code separately",
    onChange: (v) => {
      withCode = v;
      void build();
    },
  });
  sw.el.setAttribute("aria-labelledby", codeTitle.id);
  codeRow.append(codeText, sw.el);

  const codeBox = h("div", "share-code");
  codeBox.hidden = true;

  const share = Button({ label: "Share…", icon: "share", variant: "primary", disabled: true, onClick: () => doShare() });
  const copy = Button({ label: "Copy link", icon: "link", variant: "quiet", disabled: true, onClick: () => doCopy() });
  const actions = h("div", "mesh-actions");
  actions.append(share, copy);
  body.append(codeRow, codeBox, actions);
  sheet.body.append(body);

  const build = async (): Promise<void> => {
    const mine = ++gen;
    share.disabled = copy.disabled = true;
    try {
      const m = await makeShareLink({ kind: opts.kind, title: opts.title, body: await opts.body() }, { base: shareBase(), withCode });
      if (mine !== gen) return;
      made = m;
      codeBox.replaceChildren();
      codeBox.hidden = !m.code;
      if (m.code) {
        codeBox.append(h("div", "mesh-row-hint", "The code to send separately:"), h("div", "share-code-value", formatCode(m.code)));
      }
      share.disabled = typeof navigator.share !== "function";
      copy.disabled = false;
    } catch (e) {
      if (mine === gen) toast(`Couldn't make the link: ${(e as Error).message}`, { error: true });
    }
  };

  const text = (): string =>
    opts.kind === "mesh" ? `Open this in Splanc to manage the mesh “${opts.title}”.` : `Open this in Splanc to add “${opts.title}”.`;

  const doShare = (): void => {
    if (!made) return;
    navigator
      .share({ title: `Splanc: ${opts.title}`, text: text(), url: made.url })
      .then(() => {
        if (made?.code) toast("Now send the code another way");
      })
      .catch((e: unknown) => {
        if ((e as DOMException)?.name === "AbortError") return;
        doCopy();
      });
  };

  const doCopy = (): void => {
    if (!made) return;
    void navigator.clipboard
      ?.writeText(made.url)
      .then(() => toast(made?.code ? "Link copied. Send the code another way" : "Link copied"))
      .catch(() => toast("Couldn't copy the link", { error: true }));
  };

  void build();
}
