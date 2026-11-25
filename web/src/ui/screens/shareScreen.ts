/**
 * #/share: a share link opened (docs/design/share-links.md, shareSheet.ts makes them).
 *
 * The link's secret is taken out of the address bar the moment the screen mounts
 * (history.replaceState to a bare #/share), so it isn't kept in the browser's history or
 * restored with the tab. The screen then asks for the code when the link needs one, says
 * what the link holds, and adds it only when the person accepts.
 */

import { Button, toast } from "../kit";
import type { Screen } from "../app/router";
import { needsCode, openShare, parseShareLink, ShareLinkError, CODE_LEN, normalizeCode, type ParsedShare, type ShareEnvelope } from "../../net/shareLink";
import { acceptShare, previewShare } from "../../store/shareAccess";
import { deviceStore } from "../../store/deviceStore";
import { installMeshStyles } from "./meshUi.css";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The link that opened the app, held only in memory once the URL is scrubbed. */
let pending: ParsedShare | null = null;

export function ShareScreen(query: URLSearchParams): Screen {
  installMeshStyles();
  const el = h("div", "screen share-screen");
  const card = h("div", "mesh-sheet");
  el.append(card);

  let parsed: ParsedShare | null = null;
  let error: string | null = null;
  try {
    parsed = query.get("s") ? parseShareLink(query.toString()) : pending;
  } catch (e) {
    error = (e as Error).message;
  }
  pending = parsed;

  const done = (hash: string): void => {
    pending = null;
    location.hash = hash;
  };

  const showError = (msg: string): void => {
    card.replaceChildren(h("div", "device-detail-cap", "Splanc link"), h("div", "mesh-row-hint", msg));
    const actions = h("div", "mesh-actions");
    actions.append(Button({ label: "Done", onClick: () => done("#/") }));
    card.append(actions);
  };

  const showPreview = async (env: ShareEnvelope): Promise<void> => {
    const p = await previewShare(env);
    card.replaceChildren(
      h("div", "device-detail-cap", env.kind === "mesh" ? "Mesh admin access" : "A fixture"),
      h("div", "share-title", p.title),
    );
    for (const l of p.lines) card.append(h("div", "mesh-row-hint", l));
    if (p.blocked) card.append(h("div", "mesh-row-hint mesh-row-hint--warn", p.blocked));
    if (p.note) card.append(h("div", "mesh-row-hint", p.note));
    const actions = h("div", "mesh-actions");
    const add = Button({
      label: env.kind === "mesh" ? "Add this mesh" : "Add this fixture",
      variant: "primary",
      disabled: !!p.blocked,
      onClick: () =>
        void (async () => {
          add.disabled = true;
          try {
            const r = await acceptShare(env);
            toast(r.kind === "mesh" ? `“${r.name}” added to this phone` : `${r.name} added`);
            if (r.deviceId) deviceStore.setActive(r.deviceId);
            done("#/");
          } catch (e) {
            add.disabled = false;
            toast((e as Error).message, { error: true });
          }
        })(),
    });
    actions.append(add, Button({ label: "Not now", variant: "quiet", onClick: () => done("#/") }));
    card.append(actions);
  };

  const showCode = (p: ParsedShare): void => {
    card.replaceChildren(
      h("div", "device-detail-cap", "Splanc link"),
      h("div", "mesh-row-hint", "This link needs the code the sender gave you separately."),
    );
    const input = h("input", "sheet-input share-code-input");
    input.autocomplete = "off";
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.placeholder = "XXXXX-XXXXX";
    input.setAttribute("aria-label", "Code");
    const open = Button({
      label: "Open",
      variant: "primary",
      onClick: () =>
        void (async () => {
          open.disabled = true;
          try {
            await showPreview(await openShare(p, input.value));
          } catch (e) {
            open.disabled = false;
            toast((e as Error).message, { error: true });
          }
        })(),
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && normalizeCode(input.value).length === CODE_LEN) open.click();
    });
    const actions = h("div", "mesh-actions");
    actions.append(open, Button({ label: "Not now", variant: "quiet", onClick: () => done("#/") }));
    card.append(input, actions);
    setTimeout(() => input.focus(), 0);
  };

  return {
    el,
    onMount: () => {
      // Scrub the secret from the URL (and so from history and tab restore).
      if (query.get("s")) history.replaceState(history.state, "", `${location.pathname}${location.search}#/share`);
      if (error || !parsed) {
        showError(error ?? "This Splanc link is incomplete. Open the whole link the sender gave you.");
        return;
      }
      if (needsCode(parsed)) {
        showCode(parsed);
        return;
      }
      void openShare(parsed)
        .then(showPreview)
        .catch((e: unknown) => showError(e instanceof ShareLinkError ? e.message : `Couldn't open this link: ${(e as Error).message}`));
    },
  };
}
