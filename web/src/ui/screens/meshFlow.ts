/**
 * "Create a mesh" — the dedicated flow (owner rule 2026-11-18: its own screens, one step per
 * screen, one primary action each), and "Add a fixture to this mesh", its shorter sibling.
 *
 *   #/mesh/new[?from=<device id>]          intro → pick fixtures → name → set up → joined
 *   #/mesh/add/<mesh id>[?from=<device id>] pick fixtures → set up → joined
 *
 * The app makes the mesh's secrets here (store/meshStore.ts: a non-extractable WebCrypto
 * P-256 admin key and a sealed site secret), provisions each picked fixture over whatever
 * connection it has to it (the app's own connection, wss or Bluetooth, or a short-lived wss
 * one), then unlocks one of them as the gateway and shows the others joining and syncing.
 */

import { Button, icon, type IconName } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { installCreditsFlowStyles } from "./creditsFlow.css";
import { installMeshStyles } from "./meshUi.css";
import { deviceStore, type KnownDevice } from "../../store/deviceStore";
import { meshStore, type MeshRecord } from "../../store/meshStore";
import { meshSignerLookup } from "../../store/meshSession";
import { deviceHasMesh, meshPeers, type MeshStateInfo } from "../../net/mesh";
import { ensureUnlocked, isMemberOf, MeshAdminFailure, provisionFixture, waitForMember, type MeshAdminClient } from "../../net/meshAdmin";
import { LedMapperClient } from "../../net/client";
import { connectionRegistry, deviceHostKey } from "../../net/connectionRegistry";
import { nativeSocketFactory } from "../../net/nativeSocket";
import { flowSteps, provisionFailureText, type MeshFlowMode, type MeshFlowStep } from "./meshFlowModel";

/** A connection to one fixture for the flow. */
export interface MeshFlowClient extends MeshAdminClient {
  readonly welcome: { features?: string[] } | null;
}
export type MeshFixtureOpener = (dev: KnownDevice) => Promise<{ client: MeshFlowClient; release: () => void }>;

/** The app's own connection when it is to `dev`, else a short-lived wss client (registered
 * as that fixture's socket owner so the prober multiplexes on it). A Bluetooth-only record
 * can be reached only while it is the app's connection. */
const defaultOpener: MeshFixtureOpener = async (dev) => {
  const own = appState.client;
  if (own && own.isConnected && deviceStore.activeId() === dev.id) return { client: own, release: () => undefined };
  const url = dev.wssUrl.startsWith("ble:") ? dev.lanUrl : dev.wssUrl;
  if (!url) throw new Error("Connect to it over Bluetooth first, then add it from its Mesh section.");
  if (own && own.isConnected && deviceHostKey(own.url) === deviceHostKey(url)) return { client: own, release: () => undefined };
  const factory = nativeSocketFactory();
  const c = new LedMapperClient(url, { coldRetryLimit: 2, ...(factory ? { socketFactory: factory, certTrustPossible: false } : {}) });
  connectionRegistry.register(c);
  try {
    await c.connect();
  } catch (e) {
    connectionRegistry.unregister(c);
    c.close();
    throw new Error(`Couldn't reach it on Wi-Fi (${(e as Error).message}). Is it on?`);
  }
  return {
    client: c,
    release: () => {
      connectionRegistry.unregister(c);
      c.close();
    },
  };
};

let opener: MeshFixtureOpener = defaultOpener;
/** Tests swap in simulated fixtures. */
export function setMeshFixtureOpener(o: MeshFixtureOpener | null): void {
  opener = o ?? defaultOpener;
}

type RowState = "waiting" | "busy" | "ok" | "err";
interface FixtureRow {
  dev: KnownDevice;
  state: RowState;
  text: string;
  node?: number;
}

function para(text: string, cls: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function whereText(d: KnownDevice): string {
  if (deviceStore.activeId() === d.id && appState.client?.isConnected) return "Connected now";
  if (d.wssUrl.startsWith("ble:")) return d.lanUrl ? "Reachable on Wi-Fi" : "Bluetooth only: connect to it first";
  return "On Wi-Fi";
}

export function MeshFlowScreen(router: Router, mode: MeshFlowMode, opts: { meshId?: number; from?: string } = {}): Screen {
  installCreditsFlowStyles();
  installMeshStyles();
  const el = h("div", "screen screen--mesh");
  const wrap = h("div", "cf");
  el.append(wrap);

  const steps = flowSteps(mode);
  let step: MeshFlowStep = steps[0]!;
  let rec: MeshRecord | null = null;
  let error = "";
  let disposed = false;
  let meshName = "Home mesh";
  const picked = new Set<string>(opts.from ? [opts.from] : []);
  let rows: FixtureRow[] = [];
  let gateway: { client: MeshFlowClient; release: () => void } | null = null;
  let gatewayState: MeshStateInfo | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const candidates = (): KnownDevice[] => {
    const inMesh = new Set((rec?.members ?? []).map((m) => m.deviceId));
    const active = deviceStore.activeId();
    // The connected fixture first: it becomes the gateway the others are watched through.
    return deviceStore
      .list()
      .filter((d) => !inMesh.has(d.id))
      .sort((a, b) => Number(b.id === active) - Number(a.id === active));
  };

  const goto = (s: MeshFlowStep): void => {
    step = s;
    error = "";
    render();
    wrap.querySelector<HTMLElement>(".cf-title")?.focus({ preventScroll: true });
  };
  const next = (): void => {
    const i = steps.indexOf(step);
    if (i + 1 < steps.length) goto(steps[i + 1]!);
  };
  const back = (): void => {
    const i = steps.indexOf(step);
    if (i > 0) goto(steps[i - 1]!);
    else router.back();
  };

  function page(o: { hero?: IconName; heroTone?: "ok" | "warn"; title: string; lead?: string; body?: HTMLElement[]; actions: HTMLElement }): void {
    const out: HTMLElement[] = [];
    const idx = steps.indexOf(step) + 1;
    if (steps.length > 1) {
      const w = h("div", "cf-progress");
      w.setAttribute("role", "progressbar");
      w.setAttribute("aria-valuemin", "1");
      w.setAttribute("aria-valuemax", String(steps.length));
      w.setAttribute("aria-valuenow", String(idx));
      w.append(h("div", "cf-progress-text", `Step ${idx} of ${steps.length}`));
      const bar = h("div", "cf-progress-bar");
      for (let i = 1; i <= steps.length; i++) bar.append(h("i", i <= idx ? "on" : ""));
      w.append(bar);
      out.push(w);
    }
    if (o.hero) {
      const hero = h("div", "cf-hero" + (o.heroTone ? ` cf-hero--${o.heroTone}` : ""));
      hero.append(icon(o.hero));
      out.push(hero);
    }
    const t = h("h1", "cf-title", o.title);
    t.tabIndex = -1;
    out.push(t);
    if (o.lead) out.push(para(o.lead, "cf-lead"));
    out.push(...(o.body ?? []));
    if (error) {
      const e = para(error, "cf-err");
      e.setAttribute("role", "alert");
      out.push(e);
    }
    out.push(o.actions);
    wrap.replaceChildren(...out);
  }

  function actions(primary: HTMLButtonElement | null, ...secondary: HTMLButtonElement[]): HTMLElement {
    const a = h("div", "cf-actions");
    if (primary) a.append(primary);
    for (const s of secondary) {
      s.classList.add("k-btn--quiet");
      a.append(s);
    }
    return a;
  }

  const render = (): void => {
    if (disposed) return;
    if (step === "intro") renderIntro();
    else if (step === "pick") renderPick();
    else if (step === "name") renderName();
    else if (step === "setup") renderSetup();
    else renderJoined();
  };

  function renderIntro(): void {
    const facts = h("ul", "cf-facts");
    const fact = (ic: IconName, title: string, text: string): void => {
      const li = h("li", "");
      const i = h("span", "cf-fact-icon");
      i.append(icon(ic));
      const body = h("div", "");
      body.append(h("div", "cf-fact-title", title), h("div", "cf-fact-text", text));
      li.append(i, body);
      facts.append(li);
    };
    fact("device", "Pick your fixtures", "Any of your Splanc fixtures with mesh firmware. They talk to each other directly, no extra hardware.");
    fact("check", "This phone keeps the key", "The app makes the mesh's admin key and keeps it on this device. Only it can add or remove fixtures.");
    fact("play", "Control them together", "Effects, brightness and sliders then change on every fixture on the same frame (a slider being dragged follows within milliseconds).");
    page({
      hero: "graph",
      title: "Create a mesh",
      lead: "Link your fixtures so they play together, controlled from whichever one this phone is connected to.",
      body: [facts],
      actions: actions(Button({ label: "Get started", variant: "primary", onClick: next }), Button({ label: "Not now", onClick: () => router.back() })),
    });
  }

  function renderPick(): void {
    const list = h("div", "mf-pick");
    const devs = candidates();
    for (const d of devs) {
      const row = h("label", "mf-pick-row");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = picked.has(d.id);
      cb.addEventListener("change", () => {
        if (cb.checked) picked.add(d.id);
        else picked.delete(d.id);
        render();
      });
      const text = h("span", "");
      text.append(h("span", "mf-pick-name", d.label), h("span", "mf-pick-where", whereText(d)));
      row.append(cb, text);
      list.append(row);
    }
    for (const id of [...picked]) if (!devs.some((d) => d.id === id)) picked.delete(id);
    const need = mode === "new" ? 2 : 1;
    const enough = picked.size >= need;
    const cont = Button({
      label: mode === "new" ? "Continue" : picked.size > 1 ? `Add ${picked.size} fixtures` : "Add fixture",
      variant: "primary",
      disabled: !enough,
      onClick: () => (mode === "new" ? next() : void startSetup()),
    });
    const body: HTMLElement[] = [list];
    if (!devs.length) {
      body.push(para(mode === "new" ? "Add your fixtures to the app first (Devices ▸ Add device)." : "Every fixture this app knows is already in this mesh.", "cf-note"));
    } else {
      body.push(para(enough ? `${picked.size} selected.` : mode === "new" ? "Pick at least two." : "Pick at least one.", "cf-note"));
    }
    page({
      title: mode === "new" ? "Which fixtures?" : `Add to “${rec?.name ?? "your mesh"}”`,
      lead: "Each one needs mesh firmware and to be switched on. The app sets them up one at a time.",
      body,
      actions: actions(cont, Button({ label: "Back", onClick: back })),
    });
  }

  function renderName(): void {
    const field = h("label", "cf-field");
    field.append(h("span", "", "Mesh name"));
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 40;
    input.value = meshName;
    input.autocomplete = "off";
    input.addEventListener("input", () => (meshName = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void startSetup();
    });
    field.append(input);
    page({
      title: "Name your mesh",
      lead: "Just for you, so you can tell meshes apart. You can have more than one.",
      body: [field, para(`${picked.size} fixtures will join it.`, "cf-note")],
      actions: actions(Button({ label: "Create mesh", variant: "primary", onClick: () => void startSetup() }), Button({ label: "Back", onClick: back })),
    });
  }

  function stepList(): HTMLElement {
    const ul = h("ul", "mf-steps");
    for (const r of rows) {
      const li = h("li", `mf-step mf-step--${r.state}`);
      const ic = h("span", "mf-step-icon");
      if (r.state === "ok") ic.append(icon("check"));
      else if (r.state === "err") ic.append(icon("alert"));
      const text = h("div", "");
      text.append(h("div", "mf-step-name", r.dev.label), h("div", "mf-step-text", r.text));
      li.append(ic, text);
      ul.append(li);
    }
    return ul;
  }

  function renderSetup(): void {
    const running = rows.some((r) => r.state === "busy" || r.state === "waiting");
    const ok = rows.filter((r) => r.state === "ok").length;
    const failed = rows.filter((r) => r.state === "err").length;
    const primary = running
      ? Button({ label: "Setting up…", variant: "primary", disabled: true })
      : ok > 0
        ? Button({ label: "Continue", variant: "primary", onClick: () => void startJoined() })
        : null;
    const retry = !running && failed > 0 ? Button({ label: failed > 1 ? "Try the failed ones again" : "Try again", onClick: () => void provisionAll(rows.filter((r) => r.state === "err")) }) : null;
    page({
      title: running ? "Setting up your fixtures" : failed ? "Some fixtures didn't join" : "All set up",
      lead: running ? "Keep this screen open. Each fixture takes a few seconds." : `${ok} of ${rows.length} in “${rec?.name ?? meshName}”.`,
      body: [stepList()],
      actions: actions(primary, ...(retry ? [retry] : []), ...(!running && ok === 0 ? [Button({ label: "Back", onClick: back })] : [])),
    });
  }

  function renderJoined(): void {
    const joined = rows.filter((r) => r.state === "ok");
    const s = gatewayState;
    const peers = new Map(meshPeers(s).map((m) => [m.node, m]));
    const gwNode = s?.node;
    let synced = 0;
    const ul = h("ul", "mf-steps");
    for (const r of joined) {
      const self = r.node !== undefined && r.node === gwNode;
      const m = r.node !== undefined ? peers.get(r.node) : undefined;
      const sync = self ? (s?.sync ?? 0) : (m?.sync ?? -1);
      const inMesh = self || m !== undefined;
      if (inMesh && sync >= 2) synced++;
      const state: RowState = inMesh && sync >= 2 ? "ok" : "busy";
      const text = !inMesh
        ? "Finding the others…"
        : sync >= 2
          ? self
            ? "In the mesh · time synced · connected to this phone"
            : `In the mesh · time synced${m?.rssi ? ` · ${m.rssi} dBm` : ""}`
          : "In the mesh · syncing time…";
      const li = h("li", `mf-step mf-step--${state}`);
      const ic = h("span", "mf-step-icon");
      if (state === "ok") ic.append(icon("check"));
      const t = h("div", "");
      t.append(h("div", "mf-step-name", r.dev.label), h("div", "mf-step-text", text));
      li.append(ic, t);
      ul.append(li);
    }
    const all = joined.length > 0 && synced === joined.length;
    page({
      ...(all ? { hero: "check" as IconName, heroTone: "ok" as const } : {}),
      title: all ? "Your mesh is ready" : "Joining up",
      lead: all
        ? `${joined.length} fixtures in “${rec?.name ?? meshName}”, in sync. Turn on “Control the whole mesh” in a fixture's Mesh section to change them all at once.`
        : "They find each other over the air and line up their clocks. This takes up to half a minute.",
      body: [ul],
      actions: actions(Button({ label: all ? "Done" : "Finish in the background", variant: all ? "primary" : "quiet", onClick: finish })),
    });
  }

  async function startSetup(): Promise<void> {
    if (!picked.size) return;
    error = "";
    try {
      if (!rec) {
        if (mode !== "new") throw new Error("That mesh isn't on this device any more.");
        rec = await meshStore.create(meshName);
      }
    } catch (e) {
      error = `Couldn't create the mesh here: ${(e as Error).message}`;
      render();
      return;
    }
    const devs = deviceStore.list().filter((d) => picked.has(d.id));
    // The app's own connection first: it becomes the gateway the others join through.
    const active = deviceStore.activeId();
    devs.sort((a, b) => Number(b.id === active) - Number(a.id === active));
    rows = devs.map((dev) => ({ dev, state: "waiting", text: "Waiting…" }));
    step = "setup";
    render();
    await provisionAll(rows);
  }

  async function provisionAll(which: FixtureRow[]): Promise<void> {
    for (const r of which) {
      r.state = "waiting";
      r.text = "Waiting…";
    }
    render();
    for (const r of which) {
      if (disposed) return;
      await provisionOne(r);
      render();
    }
  }

  async function provisionOne(r: FixtureRow): Promise<void> {
    const mesh = rec!;
    const set = (state: RowState, text: string): void => {
      r.state = state;
      r.text = text;
      if (!disposed && step === "setup") render();
    };
    set("busy", "Connecting…");
    let conn: { client: MeshFlowClient; release: () => void } | null = null;
    try {
      conn = await opener(r.dev);
      if (!deviceHasMesh(conn.client.welcome)) {
        set("err", "Its firmware has no mesh support. Update it (Flash firmware), then add it.");
        return;
      }
      const before = await conn.client.getMesh();
      if (isMemberOf(before, mesh.meshId) && before.node) {
        r.node = before.node;
        set("ok", "Already in this mesh");
        return;
      }
      set("busy", "Sending the mesh keys…");
      const site = await meshStore.siteSecret(mesh.meshId);
      let res;
      try {
        res = await provisionFixture(conn.client, mesh, site);
      } finally {
        site.fill(0);
      }
      r.node = res.member.node;
      rec = await meshStore.putMember(mesh.meshId, { deviceId: r.dev.id, label: r.dev.label, ...res.member }, res.provisionerToken);
      res.provisionerToken?.fill(0);
      set("busy", "Joining…");
      const s = await waitForMember(conn.client, mesh.meshId, { timeoutMs: 20_000, aborted: () => disposed });
      set("ok", isMemberOf(s, mesh.meshId) ? "Joined" : "Mesh on; still finding the others");
    } catch (e) {
      set("err", e instanceof MeshAdminFailure ? provisionFailureText(e.code, e.message) : (e as Error).message);
    } finally {
      conn?.release();
    }
  }

  async function startJoined(): Promise<void> {
    step = "joined";
    render();
    const first = rows.find((r) => r.state === "ok");
    if (!first) return;
    try {
      gateway = await opener(first.dev);
      await ensureUnlocked(gateway.client as MeshFlowClient & object, meshSignerLookup);
    } catch (e) {
      error = `Couldn't reach ${first.dev.label} to watch the mesh: ${(e as Error).message}`;
      render();
      return;
    }
    const poll = async (): Promise<void> => {
      if (disposed || !gateway) return;
      try {
        gatewayState = await gateway.client.getMesh();
        error = "";
      } catch (e) {
        error = `Lost ${first.dev.label}: ${(e as Error).message}`;
      }
      if (step === "joined") render();
      pollTimer = setTimeout(() => void poll(), 1500);
    };
    await poll();
  }

  function finish(): void {
    router.leave(router.origin() ?? "/maps");
  }

  return {
    el,
    onMount: () => {
      void (async () => {
        if (mode === "add") {
          rec = (await meshStore.get(opts.meshId ?? 0)) ?? null;
          if (!rec) error = "This device doesn't hold that mesh's key.";
        }
        render();
      })();
    },
    onUnmount: () => {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      gateway?.release();
      gateway = null;
    },
  };
}
