/**
 * Device settings: the "Mesh" section (docs/design/mesh.md §9, mesh M5 + M7 membership).
 * Only for players advertising "mesh" (deviceSheet.ts gates it; older firmware never sees
 * a mesh message).
 *
 *  - Not in a mesh: "Create a mesh" (the dedicated flow, meshFlow.ts) and, when this app
 *    already administers a mesh, "Add to <mesh>".
 *  - In a mesh this app administers: the connection is unlocked with the stored admin key
 *    automatically; the members (name, time sync, signal), "Show the mesh map"
 *    (#/mesh/topology), fixtures waiting to join with Admit, "Add a fixture to this mesh", "Remove from mesh", and the "Control the whole
 *    mesh" switch (M5).
 *  - In a closed mesh another phone administers: its status and where to manage it.
 *  - A dev mesh (no admin key): the M5 status + switch, as before.
 */

import { Button, Sheet, Switch, confirmDialog, icon, toast } from "../kit";
import { isBridgeFirmware, type MeshAdminOp, type MeshAdminResultInfo, type MeshStateInfo } from "../../net/mesh";
import { admitPending, ejectMember, ensureUnlocked, leaveMesh, revokeMembers, MeshAdminFailure } from "../../net/meshAdmin";
import { keepRevoked, meshStore, type MeshRecord } from "../../store/meshStore";
import { lastMeshResult, meshSignerLookup, onMeshResults, rememberMeshAll } from "../../store/meshSession";
import { meshResultSummary, meshSectionModel, nodeLabel, pendingLabel, type MeshMemberRow, type MeshResultSummary, type MeshSectionModel } from "./meshModel";
import { installMeshStyles } from "./meshUi.css";
import { toHex } from "../../net/meshKeys";
import { openShareMeshSheet } from "./shareMeshSheet";

export interface MeshSectionClient {
  getMesh(timeoutMs?: number): Promise<MeshStateInfo>;
  meshAdmin(op: MeshAdminOp, timeoutMs?: number): Promise<MeshAdminResultInfo>;
  readonly meshAll: boolean;
  setMeshAll(on: boolean): void;
  /** The fixture's welcome (its MAC keys the remembered whole-mesh switch). */
  readonly welcome?: { mac?: string } | null;
}

export interface MeshSectionOpts {
  /** The connected fixture's saved-device id and name. */
  deviceId: string;
  deviceName: string;
  onChange?: (on: boolean) => void;
  onShown?: (shown: boolean) => void;
  /** Leave the sheet for a route (the flow). */
  navigate?: (hash: string) => void;
}

/** How often the open section re-reads the mesh (joiners, sync, members). */
const POLL_MS = 3000;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function MeshSection(client: MeshSectionClient, opts: MeshSectionOpts): HTMLElement {
  installMeshStyles();
  const el = h("div", "mesh-section");
  el.hidden = true;
  const go = (hash: string): void => (opts.navigate ? opts.navigate(hash) : void (location.hash = hash));
  let lastKey = "";
  let busy = false;

  const render = (
    m: MeshSectionModel,
    rec: MeshRecord | undefined,
    meshes: MeshRecord[],
    last: MeshResultSummary | null,
    held: { meshId: number; node: number } | null,
  ): void => {
    // Re-render only on a visible change (the poll must not reset a focused button).
    const key = JSON.stringify([m, meshes.map((x) => [x.meshId, x.name]), last, held, rec?.role, rec?.delegates]);
    if (key === lastKey) return;
    lastKey = key;
    el.replaceChildren();
    el.hidden = false;
    opts.onShown?.(true);
    el.append(h("div", "device-detail-cap", m.kind === "none" ? "Mesh" : m.meshName));
    el.append(h("div", "mesh-status-line", m.status));

    if (m.kind === "none") {
      const actions = h("div", "mesh-actions");
      const from = encodeURIComponent(opts.deviceId);
      for (const x of meshes) {
        actions.append(Button({ label: `Add to “${x.name}”`, icon: "plus", onClick: () => go(`#/mesh/add/${x.meshId}?from=${from}`) }));
      }
      actions.append(
        Button({
          label: "Create a mesh",
          icon: "graph",
          variant: meshes.length ? "quiet" : "primary",
          onClick: () => go(`#/mesh/new?from=${from}`),
        }),
        Button({ label: "Use a mesh from another phone", variant: "quiet", onClick: () => openImportSheet() }),
      );
      el.append(actions);
      return;
    }
    if (m.kind === "joining") return;

    if (m.canControl) el.append(controlRow(m.members.length - 1));

    el.append(h("div", "mesh-sub", "Fixtures in this mesh"));
    const list = h("ul", "mesh-members");
    for (const row of m.members) list.append(memberItem(row, m, rec));
    el.append(list);

    // The mesh map (#/mesh/topology): where each fixture is, its links and its health.
    const mapRow = h("div", "mesh-actions");
    mapRow.append(Button({ label: "Show the mesh map", icon: "graph", variant: "quiet", onClick: () => go("#/mesh/topology") }));
    el.append(mapRow);

    if (last && (m.kind === "admin" || m.kind === "dev")) el.append(lastChange(last));

    if (m.pending.length) {
      const box = h("div", "mesh-pending");
      box.append(h("div", "mesh-pending-title", m.pending.length === 1 ? "A new fixture wants to join" : `${m.pending.length} new fixtures want to join`));
      for (const p of m.pending) {
        const row = h("div", "mesh-pending-row");
        const text = h("div", "mesh-row-text");
        const bridge = isBridgeFirmware(p.firmware);
        text.append(
          h("span", "mesh-row-title", pendingLabel(p)),
          h("span", "mesh-row-hint", bridge ? "A Splanc bridge, asking to join on its own radio. Admit it only if it is yours." : "Nearby, asking to join. Admit it only if it is yours."),
        );
        const admit = Button({
          label: "Admit",
          variant: "primary",
          onClick: () =>
            void act(admit, async () => {
              await admitPending(client, p);
              if (rec && p.node && p.keyHash) {
                await meshStore.putMember(rec.meshId, { deviceId: "", label: pendingLabel(p), node: p.node, keyHash: toHex(p.keyHash) });
              }
              toast(`${pendingLabel(p)} admitted`);
            }),
        });
        row.append(text, admit);
        box.append(row);
      }
      el.append(box);
    }

    if (m.kind === "foreign") {
      el.append(
        h(
          "div",
          "mesh-row-hint",
          "This mesh was created on another phone or browser, which holds its admin key. Manage it there, " +
            "or bring it here with that phone's mesh backup. If the key is lost, reset the fixture's mesh from " +
            "its USB console (MESH LEAVE).",
        ),
      );
      const actions = h("div", "mesh-actions");
      if (held) {
        // A fixture shared on its own (a "fixture" share link): its token lets this phone
        // take it out of the mesh, though another phone administers the mesh.
        const out = Button({ label: "Take it out of this mesh", variant: "danger", onClick: () => void leaveWithToken(out, held) });
        actions.append(out);
      }
      actions.append(Button({ label: "Use a mesh from another phone", variant: "quiet", onClick: () => openImportSheet() }));
      el.append(actions);
      return;
    }
    if (m.kind === "admin" && rec) {
      const actions = h("div", "mesh-actions");
      actions.append(
        Button({ label: "Add a fixture to this mesh", icon: "plus", onClick: () => go(`#/mesh/add/${rec.meshId}`) }),
        Button({ label: "Remove from mesh", variant: "quiet", onClick: () => openMemberSheet(m.members[0]!, m, rec) }),
      );
      if (rec.role === "delegate") {
        // Revocable access someone shared (docs/design/share-links.md): no blocking, backups
        // or sharing on; the owner can take it back.
        el.append(
          h(
            "div",
            "mesh-row-hint",
            `Shared with you by this mesh's owner${rec.delegateUntil ? ` until ${new Date(rec.delegateUntil).toLocaleDateString()}` : ""}. ` +
              "They can take it back. Blocking fixtures and sharing the mesh stay with them.",
          ),
        );
      } else {
        actions.append(
          Button({ label: "Share admin access", icon: "share", variant: "quiet", onClick: () => void shareMesh(rec) }),
          Button({ label: "Back up this mesh", variant: "quiet", onClick: () => void openBackupSheet(rec) }),
        );
      }
      el.append(actions);
      if (rec.role === "admin" && rec.delegates.length) el.append(peopleBox(rec));
    }
  };

  /** The mesh's admin access as a share link (docs/design/share-links.md): revocable
   * access for one person (the default) or the full admin secret. */
  const shareMesh = async (rec: MeshRecord): Promise<void> => {
    if (!(await meshStore.exportable(rec.meshId))) {
      toast("This mesh was made before it could be shared. Create it again to share it.", { error: true });
      return;
    }
    openShareMeshSheet(rec, async () => (await client.getMesh().catch(() => null))?.meshS ?? null);
  };

  /** "People with access": revocable access this phone shared, each revocable. */
  const peopleBox = (rec: MeshRecord): HTMLElement => {
    const box = h("div", "mesh-section");
    box.append(h("div", "mesh-sub", "People with access"));
    const ul = h("ul", "mesh-people");
    for (const d of rec.delegates) {
      const li = h("li", "mesh-person");
      const text = h("div", "mesh-row-text");
      const expired = !!d.expiresAt && Date.parse(d.expiresAt) <= Date.now();
      const status = d.revoked
        ? "Revoked"
        : expired
          ? "Expired"
          : d.expiresAt
            ? `Until ${new Date(d.expiresAt).toLocaleDateString()}`
            : "Until you revoke it";
      text.append(h("span", "mesh-row-title", d.label), h("span", "mesh-row-hint", status));
      li.append(text);
      if (!d.revoked && !expired) {
        const revoke = Button({ label: "Revoke", variant: "danger", onClick: () => void revokePerson(revoke, rec, d.keyHash, d.label) });
        li.append(revoke);
      } else if (expired && !d.revoked) {
        li.append(Button({ label: "Remove", variant: "quiet", onClick: () => void meshStore.dropDelegate(rec.meshId, d.keyHash).then(() => ((lastKey = ""), refresh())) }));
      }
      ul.append(li);
    }
    box.append(ul);
    return box;
  };

  const revokePerson = async (btn: HTMLButtonElement, rec: MeshRecord, keyHash: string, label: string): Promise<void> => {
    const ok = await confirmDialog({
      title: `Revoke ${label}'s access?`,
      message:
        "The mesh changes its keys and every fixture stops taking their commands within a minute. " +
        "Fixtures that are off right now miss the new keys and need adding again.",
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    await act(btn, async () => {
      const signer = await meshStore.signer(rec.meshId);
      const r = await revokeMembers(client, signer, rec, [{ node: 0, keyHash }], undefined, keepRevoked(rec));
      try {
        await meshStore.rotated(rec.meshId, r);
      } finally {
        r.siteSecret.fill(0);
      }
      await meshStore.markDelegateRevoked(rec.meshId, keyHash);
      toast(`${label}'s access revoked; the mesh has new keys`);
    });
  };

  const leaveWithToken = async (btn: HTMLButtonElement, held: { meshId: number; node: number }): Promise<void> => {
    const ok = await confirmDialog({
      title: `Take ${opts.deviceName} out of this mesh?`,
      message: "It leaves the mesh and turns its mesh off. The other fixtures keep playing. You can add it to a mesh of your own afterwards.",
      confirmLabel: "Take it out",
      danger: true,
    });
    if (!ok) return;
    await act(btn, async () => {
      const tok = await meshStore.provisionerToken(held.meshId, held.node);
      try {
        await leaveMesh(client, tok);
      } finally {
        tok?.fill(0);
      }
      await meshStore.dropFixtureToken(held.meshId, held.node);
      toast(`${opts.deviceName} left the mesh`);
    });
  };

  /** D-442: the mesh's admin secret (and site secret) as one text, for a second phone. */
  const openBackupSheet = async (rec: MeshRecord): Promise<void> => {
    const sheet = Sheet(`Back up “${rec.name}”`);
    const body = h("div", "mesh-sheet");
    if (!(await meshStore.exportable(rec.meshId))) {
      body.append(h("div", "mesh-row-hint", "This mesh was made before backups existed. Create it again to back it up."));
      sheet.body.append(body);
      return;
    }
    const text = await meshStore.exportBackup(rec.meshId);
    body.append(
      h(
        "div",
        "mesh-row-hint",
        "Whoever has this text can add, remove and control every fixture in this mesh. Keep it like a password: " +
          "in a password manager, or a file only you can open. On another phone, open a fixture's Mesh section and " +
          "choose “Use a mesh from another phone”.",
      ),
    );
    const area = h("textarea", "mesh-backup-text");
    area.readOnly = true;
    area.value = text;
    area.rows = 5;
    area.setAttribute("aria-label", "Mesh backup");
    const actions = h("div", "mesh-actions");
    actions.append(
      Button({
        label: "Copy",
        variant: "primary",
        onClick: () =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => toast("Mesh backup copied"))
            .catch(() => toast("Couldn't copy: select the text and copy it", { error: true })),
      }),
      Button({
        label: "Save as a file",
        variant: "quiet",
        onClick: () => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain" }));
          a.download = `${rec.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "mesh"}.splanc-mesh.txt`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
      }),
    );
    body.append(area, actions);
    sheet.body.append(body);
  };

  /** D-442: a mesh backed up on another phone (openBackupSheet), pasted here. */
  const openImportSheet = (): void => {
    const sheet = Sheet("Use a mesh from another phone");
    const body = h("div", "mesh-sheet");
    body.append(h("div", "mesh-row-hint", "Paste the mesh backup made on the other phone (“Back up this mesh”). This phone can then add, remove and control the mesh's fixtures too."));
    const area = h("textarea", "mesh-backup-text");
    area.rows = 5;
    area.placeholder = "splanc-mesh-1:…";
    area.setAttribute("aria-label", "Mesh backup");
    const actions = h("div", "mesh-actions");
    const add = Button({
      label: "Add this mesh",
      variant: "primary",
      onClick: () =>
        void (async () => {
          try {
            const rec = await meshStore.importBackup(area.value);
            area.value = "";
            toast(`“${rec.name}” added to this phone`);
            sheet.close();
            lastKey = "";
            await refresh();
          } catch (e) {
            toast((e as Error).message, { error: true });
          }
        })(),
    });
    actions.append(add);
    body.append(area, actions);
    sheet.body.append(body);
  };

  /** Which fixtures got the last whole-mesh change (an effect, a slider, brightness). */
  const lastChange = (sum: MeshResultSummary): HTMLElement => {
    const box = h("div", "mesh-last");
    box.setAttribute("aria-live", "polite");
    box.append(h("div", "mesh-sub", "Last change sent to the mesh"), h("div", sum.allOk ? "mesh-last-line" : "mesh-last-line mesh-last-line--warn", sum.partial ? `${sum.line} so far` : sum.line));
    const ul = h("ul", "mesh-last-rows");
    for (const r of sum.rows) {
      const li = h("li", r.ok ? "mesh-last-row" : "mesh-last-row mesh-last-row--bad");
      const dot = h("span", r.ok ? "mesh-member-dot mesh-member-dot--ok" : "mesh-member-dot mesh-member-dot--bad");
      li.append(dot, h("span", "mesh-last-name", r.name), h("span", "mesh-member-detail", r.text));
      ul.append(li);
    }
    box.append(ul);
    return box;
  };

  const controlRow = (others: number): HTMLElement => {
    const row = h("div", "mesh-row");
    const text = h("div", "mesh-row-text");
    const title = h("span", "mesh-row-title", "Control the whole mesh");
    title.id = "mesh-all-title";
    text.append(
      title,
      h(
        "span",
        "mesh-row-hint",
        `Effects, sliders, brightness and crossfades also go to the ${others} other fixture${others === 1 ? "" : "s"}. ` +
          "Each change lands on the same frame; a slider being dragged follows within a few milliseconds.",
      ),
    );
    const sw = Switch({
      on: client.meshAll,
      label: "Control the whole mesh",
      onChange: (v) => {
        client.setMeshAll(v);
        rememberMeshAll(client.welcome?.mac, v);
        opts.onChange?.(v);
      },
    });
    sw.el.setAttribute("aria-labelledby", title.id);
    row.append(text, sw.el);
    return row;
  };

  const memberItem = (row: MeshMemberRow, m: MeshSectionModel, rec: MeshRecord | undefined): HTMLElement => {
    const li = h("li", "");
    const b = h("button", "mesh-member");
    b.type = "button";
    const dot = h("span", row.synced ? "mesh-member-dot mesh-member-dot--ok" : "mesh-member-dot");
    const text = h("span", "mesh-row-text");
    text.append(h("span", "mesh-member-name", row.self ? `${row.name} (this one)` : row.name), h("span", "mesh-member-detail", row.detail));
    const chev = h("span", "mesh-member-chev");
    chev.append(icon("chevron"));
    b.append(dot, text, chev);
    b.addEventListener("click", () => openMemberSheet(row, m, rec));
    li.append(b);
    return li;
  };

  const openMemberSheet = (row: MeshMemberRow, m: MeshSectionModel, rec: MeshRecord | undefined): void => {
    const sheet = Sheet(row.self ? `${row.name} (this one)` : row.name);
    const body = h("div", "mesh-sheet");
    const kv = (k: string, v: string): HTMLElement => {
      const r = h("div", "mesh-kv");
      r.append(h("span", "", k), h("span", "", v));
      return r;
    };
    body.append(kv("Mesh", m.meshName), kv("Status", row.detail), kv("Mesh node", nodeLabel(row.node).replace("Fixture ", "")));
    if (m.kind !== "admin" || !rec) {
      body.append(h("div", "mesh-row-hint", "Only the phone or browser that created this mesh can remove fixtures from it."));
      sheet.body.append(body);
      return;
    }
    const actions = h("div", "mesh-actions");
    const canEject = row.self || row.keyHash !== null;
    if (!canEject) {
      body.append(h("div", "mesh-row-hint", "This app did not add this fixture, so it does not know its key. Connect to it and remove it from its own Mesh section."));
    }
    const remove = Button({
      label: row.self ? "Remove this fixture from the mesh" : "Remove from mesh",
      variant: "danger",
      disabled: !canEject,
      onClick: () =>
        void (async () => {
          const ok = await confirmDialog({
            title: `Remove ${row.name}?`,
            message: row.self
              ? `It leaves “${m.meshName}” and turns its mesh off. You can add it again later.`
              : `It leaves “${m.meshName}” and turns its mesh off. The other fixtures keep playing. You can add it again later.`,
            confirmLabel: "Remove",
            danger: true,
          });
          if (!ok) return;
          await act(remove, async () => {
            if (row.self) {
              const tok = await meshStore.provisionerToken(rec.meshId, row.node).catch(() => null);
              try {
                await leaveMesh(client, tok);
              } finally {
                tok?.fill(0);
              }
            }
            else await ejectMember(client, row.node, row.keyHash!);
            await meshStore.dropMember(rec.meshId, row.node);
            toast(`${row.name} removed from the mesh`);
            sheet.close();
          });
        })(),
    });
    actions.append(remove);
    if (!row.self && row.keyHash !== null && rec.role === "admin") {
      const block = Button({
        label: "Block it for good…",
        variant: "quiet",
        onClick: () =>
          void (async () => {
            const ok = await confirmDialog({
              title: `Block ${row.name} for good?`,
              message:
                "For a lost or given-away fixture. The mesh changes its keys and this fixture can never rejoin, even with a reset. " +
                "Its mesh turns useless within a minute; the others keep playing.",
              confirmLabel: "Block for good",
              danger: true,
            });
            if (!ok) return;
            await act(block, async () => {
              const signer = await meshStore.signer(rec.meshId);
              const r = await revokeMembers(client, signer, rec, [{ node: row.node, keyHash: row.keyHash! }], undefined, keepRevoked(rec));
              try {
                await meshStore.rotated(rec.meshId, r);
              } finally {
                r.siteSecret.fill(0);
              }
              toast(`${row.name} blocked; the mesh has new keys`);
              sheet.close();
            });
          })(),
      });
      actions.append(block);
    }
    body.append(actions);
    sheet.body.append(body);
  };

  const act = async (btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      await fn();
      lastKey = "";
      await refresh();
    } catch (e) {
      toast(e instanceof MeshAdminFailure ? `The fixture said: ${e.message}` : `Couldn't do that: ${(e as Error).message}`, { error: true });
    } finally {
      busy = false;
      btn.disabled = false;
    }
  };

  const hide = (): void => {
    el.hidden = true;
    opts.onShown?.(false);
  };

  const refresh = async (): Promise<void> => {
    let s = await client.getMesh();
    const meshes = await meshStore.list().catch(() => [] as MeshRecord[]);
    const rec = s.on ? meshes.find((x) => x.meshId === (s.meshId ?? 0) >>> 0) : undefined;
    // Unlock this connection with the stored key (once per connection; renewed near expiry).
    if (rec && s.member && s.adminKey) {
      const before = s.session;
      if ((await ensureUnlocked(client as unknown as MeshSectionClient & object, meshSignerLookup, s)) && !before) {
        s = await client.getMesh();
      }
    }
    const lr = lastMeshResult(client);
    const last = lr ? meshResultSummary(lr, (n) => rec?.members.find((x) => x.node === n)?.label ?? nodeLabel(n), s.node ? { node: s.node, name: opts.deviceName } : undefined) : null;
    let held: { meshId: number; node: number } | null = null;
    if (s.on && !rec && s.meshId && s.node) {
      const tok = await meshStore.provisionerToken(s.meshId, s.node).catch(() => null);
      if (tok) held = { meshId: s.meshId >>> 0, node: s.node };
      tok?.fill(0);
    }
    render(meshSectionModel(s, rec, opts.deviceName), rec, s.on ? [] : meshes, last, held);
  };

  const tick = (): void => {
    if (!el.isConnected) return; // the sheet re-rendered or closed
    if (!busy) void refresh().catch(() => (lastKey === "" ? hide() : undefined));
    setTimeout(tick, POLL_MS);
  };
  // A new per-member result: show it without waiting for the poll.
  const unsub = onMeshResults((c) => {
    if (!el.isConnected && lastKey !== "") return unsub();
    if (c === client && !busy) void refresh().catch(() => undefined);
  });
  try {
    void refresh()
      .then(() => setTimeout(tick, POLL_MS))
      .catch(hide);
  } catch {
    hide();
  }
  return el;
}
