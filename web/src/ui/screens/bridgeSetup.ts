/**
 * "Set up a bridge" (#698): the dedicated flow for a Splanc bridge (the Raspberry Pi
 * appliance), one step per screen, each with one primary action.
 *
 *   #/bridge/setup     intro -> Wi-Fi -> online (four checked stages) -> pair -> paired
 *                      an already-paired bridge on a new network ends at "back online"
 *
 * Reached from the connect picker ("Set up a Splanc bridge"), from Live via bridge, and
 * by itself when the fixture flow's Improv device turns out to be a bridge (it hands the
 * joined address over; see addDevice.ts). The state machine is net/bridgeSetup.ts, its
 * runner ui/screens/bridgeSetupRun.ts, the real I/O ui/screens/bridgeSetupIO.ts.
 */

import { Button, PasswordReveal, icon, type IconName } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { installCreditsFlowStyles } from "./creditsFlow.css";
import { installBridgeSetupStyles } from "./bridgeSetup.css";
import {
  STAGES,
  codeShowing,
  failureCopy,
  formatPairingCode,
  pairingCodeComplete,
  stageText,
  type SetupState,
  type Step,
} from "../../net/bridgeSetup";
import { bleAvailable, type ImprovDevice } from "../../net/improv";
import { chooseImprovDevice } from "./addDevice";
import { prefs, type WifiCreds } from "../../store/prefs";
import { savedNetworks } from "../../store/savedNetworks";
import { wifiDraft } from "../../store/wifiDraft";
import { BridgeSetupRunner } from "./bridgeSetupRun";
import { bridgeSetupIO, takeBridgeHandoff } from "./bridgeSetupIO";
import { defaultName, loadCreds } from "./bridgeLive";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function para(text: string, cls: string): HTMLParagraphElement {
  return h("p", cls, text);
}

/** The progress bar's four steps: Wi-Fi, online, pair, done. */
function progressIndex(s: SetupState): number {
  const byStep: Record<Step, number> = { intro: 0, wifi: 1, checking: 2, pair: 3, paired: 4, moved: 4, failed: 2 };
  if (s.step === "failed") return s.failure?.stage === "wifi" || s.failure?.stage === null ? 1 : 2;
  return byStep[s.step];
}

export function BridgeSetupScreen(router: Router): Screen {
  installCreditsFlowStyles();
  installBridgeSetupStyles();
  const el = h("div", "screen screen--bridge-setup");
  const wrap = h("div", "cf bs");
  el.append(wrap);

  const creds = loadCreds();
  const joined = takeBridgeHandoff();
  const runner = new BridgeSetupRunner(bridgeSetupIO(), {
    hasCreds: creds !== null,
    knownSha: creds?.lan?.sha256 ?? null,
    ...(joined ? { joined } : {}),
  });

  // What the user typed survives re-renders (the code's expiry refreshes the pair page).
  const saved = prefs.getWifiList();
  const first: WifiCreds = wifiDraft.get() ?? saved[0] ?? { ssid: "", password: "" };
  let ssid = first.ssid;
  let password = first.password;
  let code = "";
  let label = defaultName();
  let btStatus = "";
  let btError = "";
  let renderedStep: Step | null = null;
  let codeHint: HTMLElement | null = null;

  function page(o: {
    hero?: IconName;
    heroTone?: "ok" | "warn" | "danger";
    title: string;
    lead?: string;
    body?: HTMLElement[];
    actions: HTMLElement;
  }): void {
    const out: HTMLElement[] = [];
    const idx = progressIndex(runner.state);
    if (idx > 0) {
      const w = h("div", "cf-progress");
      w.setAttribute("role", "progressbar");
      w.setAttribute("aria-valuemin", "1");
      w.setAttribute("aria-valuemax", "4");
      w.setAttribute("aria-valuenow", String(idx));
      w.append(h("div", "cf-progress-text", `Step ${idx} of 4`));
      const bar = h("div", "cf-progress-bar");
      for (let i = 1; i <= 4; i++) bar.append(h("i", i <= idx ? "on" : ""));
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

  function stageList(s: SetupState): HTMLElement {
    const ul = h("ul", "bs-stages");
    ul.setAttribute("aria-label", "Setup progress");
    const now = Date.now() / 1000;
    for (const id of STAGES) {
      const st = s.stages[id];
      const t = stageText(s, id, now);
      const li = h("li", `bs-stage bs-stage--${st}`);
      li.dataset["stage"] = id;
      const ic = h("span", "bs-stage-icon");
      if (st === "ok") ic.append(icon("check"));
      else if (st === "failed") ic.append(icon("alert"));
      else if (st === "later") ic.append(icon("info"));
      const text = h("div", "");
      text.append(h("div", "bs-stage-title", t.title), h("div", "bs-stage-detail", t.detail));
      li.append(ic, text);
      ul.append(li);
    }
    return ul;
  }

  function hint(ic: IconName, text: string): HTMLElement {
    const d = h("div", "bs-hint");
    d.append(icon(ic), h("span", "", text));
    return d;
  }

  function playerList(players: string[] | null): HTMLElement[] {
    if (players === null) return [para("Its fixtures show on the bridge's page in a moment.", "cf-note")];
    if (players.length === 0) {
      return [para("It doesn't see any fixtures yet. Fixtures on the same Wi-Fi show up by themselves; set one up from Devices if you haven't.", "cf-note")];
    }
    const ul = h("ul", "bs-players");
    ul.setAttribute("aria-label", "Fixtures the bridge sees");
    for (const p of players) {
      const li = h("li", "");
      li.append(icon("device"), h("span", "", p));
      ul.append(li);
    }
    return [para(players.length === 1 ? "It sees 1 fixture:" : `It sees ${players.length} fixtures:`, "cf-note"), ul];
  }

  // -- the steps ---------------------------------------------------------------------

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
    fact("plug", "Power on the bridge", "Plug in your Splanc bridge and wait for its screen to light up. It doesn't need Wi-Fi yet.");
    fact("bluetooth", "Keep this phone close", "The app gives it your Wi-Fi details over Bluetooth, then checks it comes online.");
    fact("link", "Pair it with this app", "Type the code from the bridge's screen. The app then reaches every fixture through it, from anywhere.");
    const noBle = bleAvailable() ? null : "Needs Bluetooth: use Chrome or Edge on a computer or Android phone, or the Splanc app.";
    const body: HTMLElement[] = [facts];
    if (noBle) {
      const e = para(noBle, "cf-err");
      e.setAttribute("role", "alert");
      body.push(e);
    }
    page({
      hero: "link",
      title: "Set up a bridge",
      lead: "A bridge (the Splanc Raspberry Pi) holds the connection to each of your fixtures, so the app can drive them all at once.",
      body,
      actions: actions(
        Button({ label: "Get started", disabled: noBle !== null, onClick: () => runner.dispatch({ t: "start" }) }),
        Button({ label: "Not now", onClick: () => router.back() }),
      ),
    });
  }

  function renderWifi(): void {
    const picks = h("div", "wifi-picks");
    const ssidIn = document.createElement("input");
    const passIn = document.createElement("input");
    const renderPicks = (): void => {
      picks.replaceChildren();
      for (const net of prefs.getWifiList()) {
        const b = h("button", "wifi-pick", net.ssid);
        b.type = "button";
        if (net.ssid === ssid) b.classList.add("wifi-pick--on");
        if (savedNetworks.get(net.ssid)?.state === "rejected") b.classList.add("wifi-pick--rejected");
        b.addEventListener("click", () => {
          ssid = ssidIn.value = net.ssid;
          password = passIn.value = net.password;
          wifiDraft.set({ ssid, password });
          renderPicks();
        });
        picks.append(b);
      }
    };
    const field = (labelText: string, input: HTMLElement): HTMLElement => {
      const f = h("label", "cf-field");
      f.append(h("span", "", labelText), input);
      return f;
    };
    ssidIn.type = "text";
    ssidIn.value = ssid;
    ssidIn.autocomplete = "off";
    ssidIn.setAttribute("autocapitalize", "off");
    ssidIn.spellcheck = false;
    ssidIn.addEventListener("input", () => {
      ssid = ssidIn.value;
      wifiDraft.set({ ssid, password });
      renderPicks();
    });
    passIn.value = password;
    passIn.addEventListener("input", () => {
      password = passIn.value;
      wifiDraft.set({ ssid, password });
    });
    const pw = PasswordReveal(passIn, { autocomplete: "new-password", className: "sheet-pw" });
    renderPicks();
    const body: HTMLElement[] = [];
    if (prefs.getWifiList().length > 0) body.push(h("div", "wifi-cap", "Saved networks"), picks);
    body.push(field("Wi-Fi network (SSID)", ssidIn));
    const pwField = h("div", "cf-field");
    pwField.append(h("span", "", "Wi-Fi password"), pw.el);
    body.push(pwField);
    body.push(hint("bluetooth", "Next, the Bluetooth list opens: pick “splanc-bridge” (the bridge's name, unless you renamed it)."));
    if (btError) {
      const e = para(btError, "cf-err");
      e.setAttribute("role", "alert");
      body.push(e);
    } else if (btStatus) body.push(para(btStatus, "cf-note"));
    const go = Button({
      label: "Find the bridge",
      icon: "bluetooth",
      onClick: () => {
        const c: WifiCreds = { ssid: ssidIn.value.trim(), password: passIn.value };
        if (!c.ssid) {
          btError = "Enter the Wi-Fi network's name.";
          render(true);
          return;
        }
        savedNetworks.saveOnConnect(c); // synchronous: the chooser keeps the gesture
        void (async () => {
          let device: ImprovDevice;
          try {
            device = await chooseImprovDevice(); // FIRST async call — the (web) gesture
          } catch (e) {
            const cancel = e instanceof DOMException && (e.name === "NotFoundError" || e.name === "AbortError");
            btError = cancel ? "" : `Bluetooth: ${(e as Error).message}`;
            btStatus = cancel ? "No bridge picked. Press Find the bridge to look again." : "";
            render(true);
            return;
          }
          btError = "";
          btStatus = "";
          void runner.sendWifi(device, c, (s) => {
            btStatus = s;
            const n = wrap.querySelector(".bs-status");
            if (n) n.textContent = s;
          });
        })();
      },
    });
    page({
      title: "Which Wi-Fi network?",
      lead: "The bridge joins this network. Use the one your fixtures are on, and keep this phone on it too.",
      body,
      actions: actions(go, Button({ label: "Back", onClick: () => router.back() })),
    });
  }

  function renderChecking(s: SetupState): void {
    const joining = s.stages.wifi === "active";
    const body: HTMLElement[] = [stageList(s)];
    if (joining) {
      const st = para(btStatus, "bs-status");
      st.setAttribute("role", "status");
      st.setAttribute("aria-live", "polite");
      body.push(st);
    }
    page({
      title: joining ? "Joining your Wi-Fi" : "Bringing it online",
      lead: joining
        ? "Keep this screen open and the phone near the bridge. This takes up to a minute."
        : "Checking each step on the bridge itself. After a network change it can take a minute to reconnect.",
      body,
      actions: actions(
        Button({ label: "Checking…", disabled: true }),
        ...(joining ? [Button({ label: "Edit Wi-Fi details", icon: "edit", onClick: () => runner.cancelWifi() })] : []),
      ),
    });
  }

  function codeHintText(s: SetupState): string {
    const now = Date.now() / 1000;
    if (codeShowing(s.health, now)) {
      const mins = Math.max(1, Math.round(((s.health?.code_expires_at ?? now) - now) / 60));
      return `A code is on the bridge's screen now (for about ${mins} more minute${mins === 1 ? "" : "s"}).`;
    }
    if (s.health?.state === "unpaired" || s.health?.state === "paired") {
      return "No code on its screen right now: press KEY1 on the bridge (the top key beside its small screen) for one.";
    }
    return "The code is on the bridge's screen, like ABCD\u2011EFGH. No code? Press KEY1 on the bridge for a new one.";
  }

  function renderPair(s: SetupState): void {
    const codeIn = document.createElement("input");
    codeIn.type = "text";
    codeIn.className = "cf-code";
    codeIn.placeholder = "ABCD-EFGH";
    codeIn.value = code;
    codeIn.autocomplete = "off";
    codeIn.setAttribute("autocapitalize", "characters");
    codeIn.spellcheck = false;
    codeIn.maxLength = 9;
    codeIn.disabled = s.pairBusy;
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = label;
    nameIn.maxLength = 60;
    nameIn.disabled = s.pairBusy;
    nameIn.addEventListener("input", () => (label = nameIn.value));
    const go = Button({
      label: s.pairBusy ? "Pairing…" : "Pair",
      icon: "link",
      disabled: s.pairBusy || !pairingCodeComplete(code),
      onClick: () => void runner.pair(formatPairingCode(code), label.trim() || defaultName()),
    });
    codeIn.addEventListener("input", () => {
      const f = formatPairingCode(codeIn.value);
      if (f !== codeIn.value) codeIn.value = f;
      code = f;
      go.disabled = s.pairBusy || !pairingCodeComplete(code);
    });
    codeIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !go.disabled) go.click();
    });
    const codeField = h("label", "cf-field");
    codeField.append(h("span", "", "Pairing code (on the bridge's screen)"), codeIn);
    const nameField = h("label", "cf-field");
    nameField.append(h("span", "", "Name this phone (the bridge lists it)"), nameIn);
    codeHint = hint("info", codeHintText(s));
    const body: HTMLElement[] = [stageList(s), codeField, codeHint, nameField];
    if (s.pairNote === "replaces") {
      body.push(para("This app is paired with another bridge. Pairing this one replaces it in Live via bridge.", "cf-note"));
    } else if (s.pairNote === "revoked") {
      body.push(para("This app's pairing with the bridge was removed (on the bridge, or from another device). Pair again.", "cf-note"));
    }
    if (s.pairError) {
      const e = para(s.pairError.message, "cf-err");
      e.setAttribute("role", "alert");
      body.push(e);
    }
    const net = s.ssid ? ` on “${s.ssid}”` : "";
    page({
      title: "Pair with your bridge",
      lead: `It's online${net}. Enter the code it shows to pair it with this app.`,
      body,
      actions: actions(go, Button({ label: "Not now", onClick: () => router.back() })),
    });
    if (!s.pairBusy && !s.pairError) codeIn.focus({ preventScroll: true });
  }

  function renderDone(s: SetupState): void {
    const moved = s.step === "moved";
    const net = s.ssid ? `“${s.ssid}”` : "the new network";
    page({
      hero: "check",
      heroTone: "ok",
      title: moved ? "Back online, still paired" : "Your bridge is ready",
      lead: moved
        ? `It's on ${net}${s.ip ? ` at ${s.ip}` : ""}, and this app is still paired with it. Nothing else to do.`
        : `It's online on ${net} and paired with this app.`,
      body: [stageList(s), ...playerList(s.players)],
      actions: actions(
        Button({ label: "Open the bridge", icon: "play", onClick: () => router.navigate("/bridge") }),
        Button({ label: "Done", onClick: () => router.navigate("/") }),
      ),
    });
  }

  function renderFailed(s: SetupState): void {
    const c = failureCopy(s);
    const primary = Button({
      label: c.primary.label,
      onClick: () => {
        if (c.primary.id === "connect-fixture" && s.fixtureAddress) {
          appState.connect(s.fixtureAddress);
          router.navigate("/");
        } else if (c.primary.id === "edit-wifi") runner.dispatch({ t: "edit-wifi" });
        else runner.dispatch({ t: "retry" });
      },
    });
    // One secondary at most (the app bar's back arrow closes the flow).
    const secondary =
      c.primary.id === "retry"
        ? Button({ label: "Use another network", onClick: () => runner.dispatch({ t: "edit-wifi" }) })
        : Button({ label: "Close", onClick: () => router.back() });
    // A fixture answered: the bridge's stages don't apply.
    const body: HTMLElement[] = [para(c.text, "cf-lead"), ...(s.failure?.kind === "not-a-bridge" ? [] : [stageList(s)])];
    if (s.failure?.detail) body.push(para(`Details: ${s.failure.detail}`, "bs-detail"));
    page({ hero: "alert", heroTone: "warn", title: c.title, body, actions: actions(primary, secondary) });
  }

  function render(force = false): void {
    const s = runner.state;
    // On the pair page only the code's hint follows healthz (typing must keep its focus).
    if (!force && s.step === "pair" && renderedStep === "pair" && codeHint && !s.pairBusy && !s.pairError && wrap.isConnected) {
      const span = codeHint.querySelector("span");
      if (span) span.textContent = codeHintText(s);
      return;
    }
    renderedStep = s.step;
    if (s.step === "intro") renderIntro();
    else if (s.step === "wifi") renderWifi();
    else if (s.step === "checking") renderChecking(s);
    else if (s.step === "pair") renderPair(s);
    else if (s.step === "paired" || s.step === "moved") renderDone(s);
    else renderFailed(s);
    el.dataset["step"] = s.step;
  }

  let lastStep: Step = runner.state.step;
  let lastBusy = false;
  let lastErr: unknown = null;
  runner.subscribe((s) => {
    const force = s.step !== lastStep || s.pairBusy !== lastBusy || s.pairError !== lastErr;
    lastStep = s.step;
    lastBusy = s.pairBusy;
    lastErr = s.pairError;
    render(force);
  });
  render(true);

  return {
    el,
    onMount: () => runner.start(),
    onUnmount: () => runner.dispose(),
  };
}
