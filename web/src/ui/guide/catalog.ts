/**
 * User-guide catalog (FUG-103) — the SINGLE SOURCE OF TRUTH for both the
 * in-app interactive tutorial and the generated static documentation site.
 *
 * Each {@link GuideTopic} describes one user-facing surface of the app: where
 * it lives (route + tab), a one-line summary, the prose/bullets that document
 * it, and — optionally — the ordered coach-mark {@link GuideStep}s the in-app
 * tour spotlights. Two consumers read this list and NOTHING ELSE:
 *
 *   1. `ui/guide/tour.ts`      — drives the interactive walkthrough overlay.
 *   2. `tests/tools/genUserGuide.ts` — emits `docs/user-guide.md` + the static
 *      `docs/user-guide/` site, gated fresh by CI (mirrors FUG-95's perf doc).
 *
 * So a new feature is documented in BOTH places by editing this one file — the
 * tutorial and the website can't drift from each other. This module is
 * deliberately DOM-free and side-effect-free (it only `import type`s the kit
 * `IconName`, which erases at compile) so the Node doc generator can import it
 * under the plain CJS test build with no browser globals.
 */

import type { IconName } from "../kit/icons";

/** Which tab / area of the app a topic belongs to. Drives grouping in both the
 * docs table-of-contents and the tour's section ordering. */
export type GuideTab = "start" | "maps" | "effects" | "device" | "settings";

/** One coach-mark in the interactive tour. */
export interface GuideStep {
  /** CSS selector for the element to spotlight on the *currently mounted*
   * screen. Omit for a centered modal step (intro / prose-only). Selectors must
   * point at stable, always-present chrome (e.g. `.tab[data-tab="maps"]`, the
   * `.fab`) — a missing target degrades gracefully to a centered step. */
  target?: string;
  title: string;
  body: string;
  /** Preferred bubble side relative to the target; the overlay flips it if it
   * would overflow the viewport. Ignored for centered (targetless) steps. */
  placement?: "top" | "bottom" | "left" | "right";
}

/** A block of documentation prose within a topic. */
export interface GuideSection {
  /** Optional sub-heading (rendered `###` in markdown / `<h3>` on the site). */
  heading?: string;
  /** Paragraphs of prose (each an independent `<p>`). */
  body?: string[];
  /** A bullet list rendered after the prose. */
  bullets?: string[];
}

/** One documented feature area. */
export interface GuideTopic {
  /** Stable slug — the markdown anchor, the site page id, and the tour key. */
  id: string;
  title: string;
  icon: IconName;
  tab: GuideTab;
  /** The hash route this topic lives at, so the docs can deep-link "open in the
   * app" and the tour can navigate to the screen before spotlighting it. */
  route: string;
  /** One sentence, shown in the docs index and the tour's section header. */
  summary: string;
  /** The documentation body. */
  sections: GuideSection[];
  /** Optional interactive coach-mark steps. Topics with no steps are
   * documentation-only (they appear on the site but the tour skips them). */
  steps?: GuideStep[];
  /** Optional hash route (e.g. `"#/maps"`) to capture a REAL app screenshot for
   * this topic. The Playwright capturer (`docs/capture_user_guide.py`) writes
   * `docs/user-guide/img/<id>.png`, which the site and the Markdown guide embed in
   * place of the schematic figure. Only set it for screens that render standalone
   * headless (no live device / camera / specific record id). */
  screenshot?: string;
  /** Optional CSS selector the capturer clicks after loading `screenshot`, for
   * screens reached by interaction rather than a direct route — e.g. the mapping
   * workspace and the effect editor open by tapping a library `.map-row`, and the
   * device sheet opens from the Device tab. */
  screenshotClick?: string;
  /** Optional extra settle time (ms) before the shot, for screens with a heavier
   * mount (3D solve, editor compile). */
  screenshotWaitMs?: number;
}

/** Human labels for each tab/area, used as section headers in both outputs. */
export const GUIDE_TAB_LABELS: Record<GuideTab, string> = {
  start: "Getting started",
  maps: "Maps",
  effects: "Effects",
  device: "Devices",
  settings: "Settings & help",
};

/** Tab order for grouping topics in the docs table-of-contents and the tour. */
export const GUIDE_TAB_ORDER: GuideTab[] = ["start", "maps", "effects", "device", "settings"];

/**
 * The catalog. Ordered as a first-time user meets the app: welcome → connect a
 * device → map a fixture → drive it with effects → tune devices → settings.
 */
export const GUIDE_TOPICS: GuideTopic[] = [
  {
    id: "welcome",
    title: "Welcome to Splanc",
    icon: "sparkles",
    tab: "start",
    route: "/onboard",
    summary: "Map, control, and animate addressable LED fixtures from your phone.",
    screenshot: "#/onboard",
    sections: [
      {
        body: [
          "Splanc turns a phone into the control surface for addressable LED art. " +
            "You point the camera at a running fixture, the app watches the LEDs blink " +
            "out their addresses, and it reconstructs where every LED sits in 3D space. " +
            "That map then drives real-time effects on the fixture — authored on the " +
            "phone and played back by the on-device firmware.",
          "Everything lives on the device in front of you: maps and effects are stored " +
            "locally in the browser, and the app works fully offline once loaded. It is " +
            "an installable PWA, so you can add it to your home screen and launch it like " +
            "a native app.",
        ],
      },
      {
        heading: "The three tabs",
        body: ["The bottom bar is the whole app in miniature:"],
        bullets: [
          "**Maps** — your library of captured fixtures and the 3D mapping workspace.",
          "**Effects** — the effect library and the in-app shader editor.",
          "**Device** — connect to, name, flash, and tune the physical controllers.",
        ],
      },
    ],
    steps: [
      {
        title: "Welcome to Splanc",
        body:
          "This quick tour points out the main surfaces of the app. You can leave " +
          "any time with Skip — it won't ask again — and restart it later from " +
          "Settings ▸ Help & tutorial.",
      },
      {
        target: ".tab-bar",
        placement: "top",
        title: "The three tabs",
        body:
          "Maps, Effects, and Device. Maps is your fixture library, Effects is where " +
          "you author animations, and Device connects to the hardware.",
      },
    ],
  },
  {
    id: "connect-device",
    title: "Connecting a device",
    icon: "link",
    tab: "device",
    route: "/onboard",
    summary: "Link a controller over Bluetooth or by address — or start offline.",
    screenshot: "#/onboard",
    sections: [
      {
        body: [
          "A Splanc device is an ESP32 controller running the player firmware. The app " +
            "talks to it over a secure WebSocket on your local network; to get there it " +
            "first has to learn the device's Wi-Fi and address.",
        ],
      },
      {
        heading: "Ways to add a device",
        bullets: [
          "**Bluetooth** — the app scans over Web Bluetooth and provisions the board " +
            "onto a Wi-Fi network you pick (Improv). Shown where the browser supports it.",
          "**Manual address** — type a device's LAN address directly if you already " +
            "know it.",
          "**Flash a blank board** — commission a brand-new board over USB (see " +
            "Flashing firmware), then provision it.",
          "**Skip / go offline** — explore maps and effects with no hardware; connect " +
            "later from the Device tab.",
        ],
      },
      {
        body: [
          "Once linked, the connection status shows in the app-bar pill at the top of " +
            "every screen. Tap it (or the Device tab) any time to reopen the device sheet.",
        ],
      },
    ],
    steps: [
      {
        title: "Connect a device",
        body:
          "Adding a controller is the first step to lighting real hardware. Bluetooth " +
          "provisioning is the easiest path — the app walks you through picking a Wi-Fi " +
          "network. No hardware yet? Skip and explore offline.",
      },
      {
        target: ".tab[data-tab='device']",
        placement: "top",
        title: "The Device tab",
        body:
          "Opens the device sheet from anywhere — add a new controller, or connect to " +
          "and manage the ones you already know.",
      },
    ],
  },
  {
    id: "maps-library",
    title: "The maps library",
    icon: "map",
    tab: "maps",
    route: "/maps",
    summary: "Browse, search, organize, import, and export your captured fixtures.",
    screenshot: "#/maps",
    sections: [
      {
        body: [
          "The Maps tab is your library of captured fixtures. Each row is one map — a " +
            "solved 3D reconstruction of a fixture's LEDs. Search by name, filter by tag, " +
            "and group maps into folders for larger installations.",
        ],
      },
      {
        heading: "Managing the library",
        bullets: [
          "Tap a map to open its **mapping workspace** (the 3D solve + topology tools).",
          "The **+ New** button starts a fresh camera capture.",
          "A row's ⋯ menu renames, tags, moves to a folder, duplicates, or deletes.",
          "The tab's ⋯ menu **imports and exports** the whole library as a bundle, so " +
            "you can move maps between phones or back them up.",
        ],
      },
    ],
    steps: [
      {
        title: "Your fixture library",
        body:
          "Every fixture you map lands here. It's searchable, taggable, and foldered, " +
          "and the whole library imports/exports as a bundle for backup or transfer.",
      },
      {
        target: ".fab",
        placement: "left",
        title: "Map a new fixture",
        body: "The + button starts a camera capture — the subject of the next section.",
      },
    ],
  },
  {
    id: "capture",
    title: "Mapping a fixture with the camera",
    icon: "camera",
    tab: "maps",
    route: "/capture",
    summary: "Point the camera at a running fixture to reconstruct its LEDs in 3D.",
    sections: [
      {
        body: [
          "Capture is where a physical fixture becomes a map. The connected device runs " +
            "a special addressing pattern — each LED blinks out its own index in a " +
            "gray-coded sequence — and the phone camera decodes those blinks frame by " +
            "frame, building up a per-LED position estimate as you move the phone around " +
            "the fixture.",
        ],
      },
      {
        heading: "How a capture goes",
        bullets: [
          "Grant camera access and frame the fixture so its LEDs fill a good part of view.",
          "Move slowly around the fixture — parallax from multiple angles is what lets " +
            "the solver triangulate depth.",
          "The live overlay shows detected LEDs and decode progress; keep going until " +
            "coverage looks complete.",
          "**Advanced ▸ Manual override** exposes a manual exposure slider for tricky " +
            "lighting (its ceiling is set in Settings ▸ Behavior).",
          "Stop when done — the app runs a final solve and drops you into the new map's " +
            "workspace.",
        ],
      },
      {
        body: [
          "The heavy solve can run on-device (WASM) or on a host server; the app picks " +
            "the better placement automatically.",
        ],
      },
    ],
  },
  {
    id: "map-workspace",
    title: "The mapping workspace",
    icon: "tree",
    tab: "maps",
    route: "/maps",
    summary: "Inspect the 3D solve, clean up topology, and push maps to a device.",
    screenshot: "#/maps",
    screenshotClick: ".map-row",
    screenshotWaitMs: 2000,
    sections: [
      {
        body: [
          "Opening a map lands you in its workspace — an orbitable 3D view of the solved " +
            "LEDs plus the tools to refine and use the map.",
        ],
      },
      {
        heading: "What you can do here",
        bullets: [
          "**Inspect the solve** in 3D: orbit, zoom, and auto-scale/recenter the view.",
          "**Edit topology** — the skeleton graph that says which LEDs are neighbors. A " +
            "single Cleanup knob handles most fixtures; a Fine-tune disclosure exposes " +
            "the full extraction options.",
          "**Send to / pull from a device** so the fixture and the app agree on the map.",
          "**Jump to Effects** to start animating this fixture.",
          "**Edit metadata** — name, tags, and folder.",
        ],
      },
      {
        body: [
          "The 3D view honors the render knobs in Settings ▸ Appearance (LED size, glow, " +
            "background, ground grid, and axes triad).",
        ],
      },
    ],
  },
  {
    id: "effects-library",
    title: "The effects library",
    icon: "sparkles",
    tab: "effects",
    route: "/effects",
    summary: "Browse, create, tag, and test the shader effects that drive your LEDs.",
    screenshot: "#/effects",
    sections: [
      {
        body: [
          "The Effects tab is a library of animations, mirroring the maps browser: a " +
            "search box, tag chips, folders, and a row per saved effect. Tap one to open " +
            "the editor; the + button creates a new effect from a starter template.",
        ],
      },
      {
        heading: "In the library",
        bullets: [
          "**Search and tag** effects, and group them into folders.",
          "**Animated previews** can be enabled in Settings ▸ Appearance ▸ Experimental " +
            "(off by default — they're heavy on mobile).",
          "**AI key** — a discoverable affordance to bring your own API key for the " +
            "editor's AI assistant (optional; see the effect editor).",
          "The tab's ⋯ menu can **send the whole library to a debug server**.",
        ],
      },
    ],
    steps: [
      {
        title: "The effects library",
        body:
          "Animations live here. Each effect is a small shader program that runs on the " +
          "device. Tap one to edit it, or use the + button to start a new one.",
      },
      {
        target: ".fab",
        placement: "left",
        title: "Create an effect",
        body: "Starts a new effect from a template and opens it in the editor.",
      },
    ],
  },
  {
    id: "effect-editor",
    title: "The effect editor",
    icon: "edit",
    tab: "effects",
    route: "/effects",
    summary: "Write, preview, and push shader effects with the exact on-device VM.",
    screenshotWaitMs: 2800,
    sections: [
      {
        body: [
          "The editor is a full-screen workspace for one effect. You write the effect's " +
            "source, and the app compiles it off-thread and previews it live over a map " +
            "using the EXACT same virtual machine the firmware runs — so what you see is " +
            "what the fixture will do. Edits autosave back to the library.",
        ],
      },
      {
        heading: "Editor features",
        bullets: [
          "**Live preview** on a real map with the firmware VM, plus a preview grid.",
          "**Uniforms pane** — expose tunable parameters (speed, color, …) and bind them " +
            "to MIDI controls or the on-screen sliders.",
          "**Compile feedback** — errors surface inline as you type.",
          "**Push to device** — when a controller is connected, send the compiled `.fxb` " +
            "and live uniform values so the fixture updates as you edit.",
          "**AI assistant** (optional, bring-your-own-key) — describe a change in words " +
            "and have it drafted for you.",
        ],
      },
    ],
  },
  {
    id: "device-management",
    title: "Managing devices",
    icon: "device",
    tab: "device",
    route: "/maps",
    summary: "Connect, rename, re-discover, and forget the controllers you know.",
    screenshot: "#/maps",
    screenshotClick: ".tab[data-tab='device']",
    screenshotWaitMs: 700,
    sections: [
      {
        body: [
          "The device sheet — reachable from the app-bar pill and the Device tab on every " +
            "screen — lists the controllers you've added, each with a live reachability " +
            "indicator probed over the same WebSocket the app uses.",
        ],
      },
      {
        heading: "Per-device actions",
        bullets: [
          "**Connect** to a reachable device to make it the active target for maps and " +
            "effects.",
          "**Re-discover over Bluetooth** when a device has moved networks or gone " +
            "unreachable.",
          "**Rename** — the display name is reflected to the device itself.",
          "A row's ⋮ menu shows the recorded LAN address, MAC, and Bluetooth name, and " +
            "can **forget** the device.",
        ],
      },
    ],
  },
  {
    id: "flashing",
    title: "Flashing firmware",
    icon: "chip",
    tab: "device",
    route: "/maps",
    summary: "Commission a blank board over USB, right from the browser.",
    sections: [
      {
        body: [
          "Splanc can flash the player firmware onto a USB-connected board directly from " +
            "the browser — no toolchain, no command line. The flash sheet (from the Device " +
            "tab) writes the firmware image this build bundles over Web Serial, with live " +
            "progress, a log, and a diagnostics panel.",
        ],
      },
      {
        heading: "Good to know",
        bullets: [
          "Works on desktop Chromium (native Web Serial) and Android Chrome (via a WebUSB " +
            "polyfill).",
          "iOS Safari has neither API, so flashing isn't available there — the sheet says " +
            "so rather than failing silently.",
          "After flashing, provision the fresh board onto Wi-Fi like any other device.",
        ],
      },
    ],
  },
  {
    id: "color-correction",
    title: "Color correction",
    icon: "gamma",
    tab: "device",
    route: "/settings/color-correction",
    summary: "Tune per-device gamma and white balance so colors read true.",
    screenshot: "#/settings/color-correction",
    sections: [
      {
        body: [
          "Different LED strips render color differently. Color correction is a per-device " +
            "surface for the strip's gamma and white-balance curves: pick a built-in " +
            "profile, tune per-channel gamma and white balance by value or by dragging the " +
            "transfer curve, and preview the effect on real colors before (and while) it's " +
            "on the strip.",
        ],
      },
      {
        body: [
          "The curve math mirrors the firmware exactly, so the on-screen simulator matches " +
            "what the fixture actually shows.",
        ],
      },
    ],
  },
  {
    id: "performance",
    title: "Performance & calibration",
    icon: "graph",
    tab: "device",
    route: "/perf",
    summary: "Watch the live frame budget and calibrate a device's cost model.",
    screenshot: "#/perf",
    sections: [
      {
        body: [
          "Effects have to fit inside the device's per-frame time budget. The Performance " +
            "panel (from the ⋯ menu) shows the running effect's frame budget live when a " +
            "device is connected: a frame-time-vs-budget graph, a per-phase breakdown " +
            "(update / shade / show), and a headroom gauge.",
        ],
      },
      {
        heading: "Calibration",
        bullets: [
          "**Calibrate this device** runs ~30 s of tiny benchmark effects on the connected " +
            "controller and least-squares-fits its per-opcode cost model, so the app's " +
            "predictions match your exact hardware.",
          "Offline, the panel shows the predicted cost model from the default table.",
          "**Performance profiles** manages saved per-device cost tables.",
        ],
      },
    ],
  },
  {
    id: "midi",
    title: "MIDI controllers",
    icon: "midi",
    tab: "settings",
    route: "/settings/midi",
    summary: "Name physical knobs and bind them to effect parameters.",
    screenshot: "#/settings/midi",
    sections: [
      {
        body: [
          "Splanc can drive effect parameters from a hardware MIDI controller. Under " +
            "Settings ▸ MIDI you enable Web MIDI, see connected devices, and give physical " +
            "controls semantic names: wiggle a knob, type \"speed\", assign.",
        ],
      },
      {
        body: [
          "Those names are global, so any effect with a matching uniform can bind to them. " +
            "The per-effect binding itself lives in the effect editor's Uniforms pane.",
        ],
      },
    ],
  },
  {
    id: "appearance",
    title: "Appearance & behavior",
    icon: "settings",
    tab: "settings",
    route: "/settings",
    summary: "Theme the app, pick fonts, and tune the 3D view and capture defaults.",
    screenshot: "#/settings",
    sections: [
      {
        body: [
          "Settings is split into Appearance and Behavior. Every control writes through " +
            "immediately and persists across reloads, with a live 3D preview so the render " +
            "knobs show their effect as you drag.",
        ],
      },
      {
        heading: "Appearance",
        bullets: [
          "**Theme** — light/dark and an accent color (presets or a custom picker).",
          "**Typography** — a workspace font, a monospace font for the editor, and a UI " +
            "scale.",
          "**3D view** — LED point size, glow, background, and default ground grid / axes.",
          "**Startup** — toggle the branded launch splash.",
          "**Experimental** — opt into animated effect previews in the library.",
        ],
      },
      {
        heading: "Behavior",
        bullets: [
          "**Manual exposure ceiling** — the top of the capture screen's manual exposure " +
            "slider, for lighting a frame under artificial light.",
        ],
      },
    ],
  },
  {
    id: "help",
    title: "Help, tutorial & about",
    icon: "help",
    tab: "settings",
    route: "/settings",
    summary: "Restart this tutorial any time, and find licensing and credits.",
    screenshot: "#/about",
    sections: [
      {
        body: [
          "The interactive tutorial you can launch in the app is dismissible — once you " +
            "skip or finish it, it won't nag you again. You can restart it any time from " +
            "**Settings ▸ Help & tutorial**, which also links back to this documentation.",
        ],
      },
      {
        body: [
          "The **About** page (⋯ menu) describes the project, states the license and " +
            "copyright, links to the source, and lists the open-source components the app " +
            "ships.",
        ],
      },
    ],
  },
];
