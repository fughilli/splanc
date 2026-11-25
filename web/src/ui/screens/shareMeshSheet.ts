/**
 * Sharing a mesh (docs/design/share-links.md): first what kind of access, then the link.
 *
 *  - Revocable access (the default): a delegate key the admin key certifies, for one person,
 *    until an expiry or until revoked. They can add, remove and control fixtures; they can't
 *    block fixtures, back the mesh up or share it on. Listed under "People with access".
 *  - Full admin: the admin secret itself, as the backup carries it. It can't be taken back.
 */

import { Button, Sheet, toast } from "../kit";
import { meshStore, type MeshRecord } from "../../store/meshStore";
import { meshShareBody } from "../../store/shareAccess";
import { openShareSheet } from "./shareSheet";
import { installMeshStyles } from "./meshUi.css";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** How long revocable access lasts (seconds; 0: until revoked). */
export const ACCESS_TERMS: { label: string; s: number }[] = [
  { label: "1 day", s: 86_400 },
  { label: "1 week", s: 7 * 86_400 },
  { label: "30 days", s: 30 * 86_400 },
  { label: "Until I revoke it", s: 0 },
];
const DEFAULT_TERM = 2;

export function openShareMeshSheet(rec: MeshRecord, meshTimeS: () => Promise<number | null>): void {
  installMeshStyles();
  const sheet = Sheet(`Share “${rec.name}”`);
  const body = h("div", "mesh-sheet");
  let full = false;

  const card = (title: string, hint: string, on: boolean, pick: () => void): HTMLButtonElement => {
    const b = h("button", "share-choice");
    b.type = "button";
    b.setAttribute("aria-pressed", String(on));
    b.append(h("span", "mesh-row-title", title), h("span", "mesh-row-hint", hint));
    b.addEventListener("click", pick);
    return b;
  };
  const choices = h("div", "share-choices");
  const details = h("div", "mesh-sheet");
  const who = h("input", "sheet-input");
  who.placeholder = "e.g. Sam";
  who.setAttribute("aria-label", "Who is it for");
  who.maxLength = 40;
  const term = h("select", "sheet-input");
  term.setAttribute("aria-label", "How long");
  ACCESS_TERMS.forEach((t, i) => {
    const o = h("option", "", t.label);
    o.value = String(i);
    if (i === DEFAULT_TERM) o.selected = true;
    term.append(o);
  });

  const render = (): void => {
    choices.replaceChildren(
      card(
        "Access you can take back",
        "They can add, remove and control the fixtures. You can revoke it any time, and it can expire.",
        !full,
        () => ((full = false), render()),
      ),
      card(
        "Full admin",
        "Exactly what you have, including blocking fixtures and sharing it on. It can't be taken back.",
        full,
        () => ((full = true), render()),
      ),
    );
    details.replaceChildren();
    if (!full) {
      const label = h("label", "share-field");
      label.append(h("span", "mesh-row-hint", "Who is it for?"), who);
      const t = h("label", "share-field");
      t.append(h("span", "mesh-row-hint", "For how long?"), term);
      details.append(label, t);
    }
  };
  render();

  const actions = h("div", "mesh-actions");
  const next = Button({
    label: "Next",
    variant: "primary",
    onClick: () =>
      void (async () => {
        if (full) {
          sheet.close();
          openShareSheet({
            kind: "mesh",
            title: rec.name,
            grants: "Whoever opens this link in Splanc can add, remove, block and control every fixture in this mesh, as you can.",
            body: () => meshShareBody(rec.meshId),
          });
          return;
        }
        const name = who.value.trim();
        if (!name) {
          toast("Say who it's for, so you know whose access to revoke later", { error: true });
          who.focus();
          return;
        }
        const ttl = ACCESS_TERMS[Number(term.value)]?.s ?? 0;
        let notAfter = 0;
        let expiresAt: string | undefined;
        if (ttl) {
          const now = await meshTimeS();
          if (now === null) {
            toast("Connect to a fixture in this mesh to share access that expires", { error: true });
            return;
          }
          notAfter = now + ttl;
          expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        }
        next.disabled = true;
        try {
          const issued = await meshStore.issueDelegate(rec.meshId, expiresAt ? { label: name, notAfter, expiresAt } : { label: name, notAfter });
          sheet.close();
          openShareSheet({
            kind: "mesh",
            title: rec.name,
            grants: `Whoever opens this link in Splanc can add, remove and control the fixtures in this mesh${
              expiresAt ? ` until ${new Date(expiresAt).toLocaleDateString()}` : ""
            }. You can revoke it from this mesh's “People with access”.`,
            body: async () => issued.body,
            onShared: issued.commit,
            revocable: true,
          });
        } catch (e) {
          next.disabled = false;
          toast(`Couldn't share: ${(e as Error).message}`, { error: true });
        }
      })(),
  });
  actions.append(next);
  body.append(choices, details, actions);
  sheet.body.append(body);
}
