/**
 * App shell (design doc §3.2 / §7.3) — the persistent chrome around screens:
 * a top app bar (contextual title + back affordance + device status pill) and
 * a bottom tab bar (Maps / Effects / Device). The router mounts screens into
 * the shell's outlet.
 *
 * Per the owner's DECISION (§9 Q1): the device surface is BOTH an app-bar pill
 * AND a tab — tapping either opens the device sheet.
 */

import { IconButton, StatusPill, icon, type IconName, type PillHandle } from "../kit";
import { openDeviceSheet } from "../screens/deviceSheet";
import { installMenuItem, onInstallChange } from "./pwa";
import { appState } from "./state";
import { subscribeTabMenu, type TabMenuItem } from "./tabMenu";
import type { Router } from "./router";

interface Tab {
  id: string;
  label: string;
  icon: IconName;
  route: string;
}

const TABS: Tab[] = [
  { id: "maps", label: "Maps", icon: "map", route: "/maps" },
  { id: "effects", label: "Effects", icon: "sparkles", route: "/effects" },
  { id: "device", label: "Device", icon: "device", route: "" }, // opens the sheet
];

export class Shell {
  readonly root: HTMLElement;
  readonly outlet: HTMLElement;
  private titleEl!: HTMLElement;
  private backBtn!: HTMLButtonElement;
  private pill!: PillHandle;
  private tabBar!: HTMLElement;
  private appBar!: HTMLElement;
  private router: Router | null = null;
  // App-bar ⋯ overflow menu (currently the PWA install entry).
  private menuWrap!: HTMLElement;
  private kebab!: HTMLButtonElement;
  private menu!: HTMLElement;
  private menuOpen = false;
  // Context-relevant ⋯ items for the current tab (below the divider).
  private tabItems: TabMenuItem[] = [];

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "shell";
    this.outlet = document.createElement("main");
    this.outlet.className = "shell-outlet";
    this.buildAppBar();
    this.buildTabBar();
    this.root.append(this.appBar, this.outlet, this.tabBar);
    appState.subscribe(() => this.syncPill());
    this.syncPill();
  }

  attach(router: Router): void {
    this.router = router;
    window.addEventListener("hashchange", () => this.syncTabs());
    this.syncTabs();
  }

  private buildAppBar(): void {
    this.appBar = document.createElement("header");
    this.appBar.className = "app-bar";
    this.backBtn = IconButton("back", { title: "Back", onClick: () => this.router?.back() });
    this.backBtn.style.display = "none";
    this.titleEl = document.createElement("h1");
    this.titleEl.className = "app-bar-title";
    this.titleEl.textContent = "Splanc";
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    this.pill = StatusPill(() => openDeviceSheet());
    // ⋯ overflow menu (anchored popup). Holds the PWA install action; the whole
    // affordance hides itself when there's nothing to offer.
    this.menuWrap = document.createElement("div");
    this.menuWrap.className = "appbar-menu-wrap";
    this.kebab = IconButton("more", { title: "More", onClick: () => this.toggleMenu() });
    this.menu = document.createElement("div");
    this.menu.className = "appbar-menu";
    this.menu.style.display = "none";
    this.menuWrap.append(this.kebab, this.menu);
    this.appBar.append(this.backBtn, this.titleEl, spacer, this.pill.el, this.menuWrap);
    this.rebuildMenu();
    onInstallChange(() => this.rebuildMenu());
    // Screens register/clear their tab-specific items; reflect them live.
    subscribeTabMenu((items) => {
      this.tabItems = items;
      this.rebuildMenu();
    });
  }

  /** Repopulate the ⋯ menu and hide the whole affordance when it's empty. */
  private rebuildMenu(): void {
    this.menu.replaceChildren();
    // Settings (Appearance + Capture tabs) — always available.
    this.menu.appendChild(
      this.menuItem("settings", "Settings", () => this.router?.navigate("/settings")),
    );
    // MIDI controllers (connect + name controls) — always available.
    this.menu.appendChild(
      this.menuItem("midi", "MIDI controllers", () => this.router?.navigate("/settings/midi")),
    );
    // Performance (FUG-11): the live/predicted frame-budget panel + budget bar,
    // and from there device calibration + the profile manager. Always available
    // so it's discoverable (offline it shows the predicted cost model).
    this.menu.appendChild(
      this.menuItem("graph", "Performance", () => this.router?.navigate("/perf")),
    );
    const install = installMenuItem(() => this.closeMenu());
    if (install) this.menu.appendChild(install);
    // Docs: deep-links to the About screen's Documentation tab, which links out
    // to the published developer docs (and, soon, the user guide) — FUG-104.
    this.menu.appendChild(
      this.menuItem("help", "Docs", () => this.router?.navigate("/about?tab=docs")),
    );
    // About: project description, licensing/copyright, and open-source
    // disclosures (FUG-96). Always available.
    this.menu.appendChild(
      this.menuItem("info", "About", () => this.router?.navigate("/about")),
    );
    // Acid mode (FUG-106): the hands-free "just talk to your lights" surface.
    this.menu.appendChild(
      this.menuItem("mic", "Acid mode", () => this.router?.navigate("/acid")),
    );
    // Below the divider: actions relevant to the current tab (Maps import/export,
    // Effects "send library to debug server"), registered by the mounted screen.
    if (this.tabItems.length > 0) {
      const divider = document.createElement("div");
      divider.className = "appbar-menu-divider";
      this.menu.appendChild(divider);
      for (const it of this.tabItems) {
        this.menu.appendChild(this.menuItem(it.icon, it.label, it.onClick));
      }
    }
    const hasItems = this.menu.childElementCount > 0;
    this.menuWrap.style.display = hasItems ? "" : "none";
    if (!hasItems) this.closeMenu();
  }

  /** Build a ⋯-menu row (icon + label) that closes the menu, then runs `onPick`. */
  private menuItem(iconName: IconName, label: string, onPick: () => void): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "appbar-menu-item";
    item.append(icon(iconName));
    const span = document.createElement("span");
    span.textContent = label;
    item.appendChild(span);
    item.addEventListener("click", () => {
      this.closeMenu();
      onPick();
    });
    return item;
  }

  private toggleMenu(): void {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu();
  }
  private openMenu(): void {
    this.menuOpen = true;
    this.menu.style.display = "";
    // Defer the outside-click listener so this same click doesn't close it.
    setTimeout(() => document.addEventListener("click", this.onDocClick), 0);
  }
  private closeMenu(): void {
    this.menuOpen = false;
    this.menu.style.display = "none";
    document.removeEventListener("click", this.onDocClick);
  }
  private onDocClick = (ev: MouseEvent): void => {
    const t = ev.target as Node;
    if (!this.menu.contains(t) && !this.kebab.contains(t)) this.closeMenu();
  };

  private buildTabBar(): void {
    this.tabBar = document.createElement("nav");
    this.tabBar.className = "tab-bar";
    for (const tab of TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab";
      btn.dataset["tab"] = tab.id;
      const wrap = document.createElement("span");
      wrap.className = "tab-icon";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", `#ic-${tab.icon}`);
      svg.appendChild(use);
      wrap.appendChild(svg);
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tab.label;
      btn.append(wrap, label);
      btn.addEventListener("click", () => {
        if (tab.id === "device") openDeviceSheet();
        else this.router?.navigate(tab.route);
      });
      this.tabBar.appendChild(btn);
    }
  }

  /** Configure the app bar for the mounted screen. */
  setChrome(opts: { title: string; back?: boolean; tabs?: boolean; overlay?: boolean }): void {
    this.titleEl.textContent = opts.title;
    this.backBtn.style.display = opts.back ? "" : "none";
    this.tabBar.style.display = opts.tabs === false ? "none" : "";
    this.root.classList.toggle("shell--overlay", opts.overlay === true);
    this.syncTabs();
  }

  private syncTabs(): void {
    const path = location.hash.replace(/^#/, "").split("?")[0] || "/";
    for (const btn of Array.from(this.tabBar.querySelectorAll<HTMLElement>(".tab"))) {
      const id = btn.dataset["tab"];
      const active =
        (id === "maps" && (path.startsWith("/maps") || path.startsWith("/map"))) ||
        (id === "effects" && path.startsWith("/effects"));
      btn.classList.toggle("tab--active", active);
    }
  }

  private syncPill(): void {
    const s = appState.status;
    this.pill.set(s.state, s.text);
  }
}
