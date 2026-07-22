/**
 * App shell (design doc §3.2 / §7.3) — the persistent chrome around screens:
 * a top app bar (contextual title + back affordance + device status pill) and
 * a bottom tab bar (Maps / Effects / Device). The router mounts screens into
 * the shell's outlet.
 *
 * Per the owner's DECISION (§9 Q1): the device surface is BOTH an app-bar pill
 * AND a tab — tapping either opens the device sheet.
 */

import { IconButton, StatusPill, type IconName, type PillHandle } from "../kit";
import { openDeviceSheet } from "../screens/deviceSheet";
import { appState } from "./state";
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
    this.titleEl.textContent = "LED Mapper";
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    this.pill = StatusPill(() => openDeviceSheet());
    this.appBar.append(this.backBtn, this.titleEl, spacer, this.pill.el);
  }

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
