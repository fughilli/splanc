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
  /** Optional workspace route; defaults to the topic's tour route. */
  route?: string;
  /** Editor pane to reveal before locating the spotlight target. */
  pane?: string;
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
  /** Explicit interactive workspace route, independent of the docs link. */
  tourRoute?: string;
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
  /** Optional demo/capture scenario (see src/demo/init.ts) to activate via
   * `?demo=` before the shot — mocks hardware so panes that need a device /
   * camera / Bluetooth render: "device", "camera", "bluetooth". */
  screenshotDemo?: string;
  /** Optional extra shots for a multi-state flow (e.g. the effect editor's
   * tabs). Each captures `<id>-<gallery.id>.png` by driving the same
   * route/`screenshotDemo` through its `clicks` sequence. A topic with a gallery
   * becomes a "flow" — it gets its own dedicated sub-page in the docs (with the
   * hero + every gallery shot, each captioned), linked from the top-level. */
  gallery?: GalleryShot[];
}

/** One captioned shot in a flow topic's dedicated sub-page. */
export interface GalleryShot {
  /** Suffix for the file/anchor: `docs/user-guide/img/<topic>-<id>.png`. */
  id: string;
  /** One-line caption shown under the shot on the sub-page. */
  caption: string;
  /** Playwright locator sequence to drive the app to this state (clicked in
   * order after loading the topic's `screenshot` route + `screenshotDemo`). */
  clicks?: string[];
  /** Extra settle time (ms) after the clicks. */
  waitMs?: number;
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
    screenshotDemo: "bluetooth",
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
      {
        heading: "The device's security certificate",
        bullets: [
          "Each device creates its **own** security certificate the first time it starts " +
            "(it takes well under a second), and keeps it for life. Your browser asks you " +
            "to trust it once per device.",
          "The app remembers each device's certificate. If a device you know shows up " +
            "with a **different** one, the device sheet warns you: that is expected only " +
            "after a factory reset (its flash erased). Tap **I reset it — trust the new " +
            "certificate** if you did; otherwise disconnect.",
          "Devices updated from older firmware get their own certificate on the first " +
            "start after the update; the app switches to it without a warning.",
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
      {
        heading: "The map on your connected device",
        body: [
          "While a device is connected, a card at the top of the tab shows the map stored " +
            "**on the device**: its LED count, how many LEDs were mapped versus interpolated, " +
            "and when it was mapped (when the device knows). A fresh install, or a second phone, " +
            "starts with an empty library, but the fixture still has its map. Use this card to " +
            "copy it here.",
        ],
        bullets: [
          "**Saved on this phone**: the library already has this map (it was captured or saved " +
            "here). **Open** goes to it.",
          "**Not on this phone**: **Save to this phone** copies the map into the library and " +
            "opens it. **Preview** loads it without saving, so you can look at it in 3D or " +
            "export it first.",
          "**Calibrate IMU** appears when the device's motion sensor is running. It copies the " +
            "map first if needed, then opens the calibration. It's also in the device's detail " +
            "sheet (Device tab ▸ ⋯).",
          "**No map on this device yet**: map the fixture with **+**, or open a map and **Push** it.",
          "Large maps show a short summary first. The whole map is only downloaded when you " +
            "save or preview it.",
          "Through **Live via bridge**, a fixture's stored map can't be copied yet. Connect to " +
            "the fixture directly to copy it.",
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
    id: "calibrate-imu",
    title: "Calibrating a fixture's motion sensor",
    icon: "camera",
    tab: "maps",
    route: "/maps",
    summary: "Tell a fixture with an IMU which way its LED map is up, so tilt effects follow it.",
    screenshot: "#/capture?calibrate=__demo__",
    screenshotDemo: "device,camera,imu",
    sections: [
      {
        body: [
          "A fixture with a motion sensor (an MPU-6050 on its I2C pins) learns its tilt " +
            "automatically when you map it. To also fix its heading, open the map and tap " +
            "Calibrate IMU: the LEDs play the mapping code, the camera locks onto the known " +
            "map, and you capture two or three still poses, tipping the fixture at least " +
            "45° between them. Save when the fit says good.",
          "The panel also holds the capture settings — diffuse on/off, the LED stride, " +
            "manual camera exposure and LED brightness — so you can make the LEDs readable " +
            "in your lighting. If the map has no saved capture settings (it was mapped " +
            "before they were recorded, or pulled from a device) the panel says what it is " +
            "using instead; what works is saved with the calibration for next time.",
        ],
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
    screenshot: "#/capture",
    screenshotDemo: "device,camera",
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
          "The final solve starts both from scratch and from the best live-preview solve, " +
            "and keeps whichever comes out better. If it still comes back degenerate (no " +
            "LEDs in front of the camera, a collapsed size, far fewer LEDs than the " +
            "preview had) while the preview looked right, the app keeps the preview's map " +
            "instead and says so in a warning on the map. With debug mode on, such runs " +
            "also save a reproduction bundle (see **Debug mode & capture bundles**).",
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
          "**Supplement** re-scans part of the fixture and merges the new scan into the map, to " +
            "fill gaps or improve weak LEDs. If the map kept its raw capture data, weak LEDs are " +
            "re-solved from both captures. A map without that data (copied from a device, " +
            "imported, or captured before it was kept) still works: the new scan is aligned to " +
            "the stored positions and averaged with them.",
          "**Calibrate IMU** (when the connected device's motion sensor is running) aligns the " +
            "sensor to this map. A map copied from the device works too.",
          "**Jump to Effects** to start animating this fixture.",
          "**Export** the LED map for other show software — a CSV for TouchDesigner or a " +
            "Chromatik (LX Studio) fixture file. See below.",
          "**Edit metadata** — name, tags, and folder.",
        ],
      },
      {
        heading: "Exporting a map to other software",
        body: [
          "**Export** opens a sheet with two formats. Both have one entry per LED in output " +
            "order, so entry N is the LED at output index N. The file is named after the map " +
            "plus today's date. On iPhone and iPad it opens the share sheet; choose **Save to Files**.",
        ],
        bullets: [
          "**CSV (TouchDesigner, spreadsheets)** — columns " +
            "`index,P(0),P(1),P(2),mapped,confidence,channel,channel_index,segment,arclength`. " +
            "Positions are in **metres**. " +
            "In TouchDesigner, point a Table DAT's File at the CSV and wire it into a DAT to SOP's " +
            "Points DAT. You get one point per LED, numbered by `index`, and the other columns " +
            "become point attributes.",
          "**Chromatik fixture (.lxf)** — copy it into the Fixtures folder under your Chromatik " +
            "home directory and add it from the Fixture Chooser. Its points follow output order " +
            "(one component per channel). A **Scale** parameter sets units per metre: the default " +
            "100 means centimetres; set 1 for metres or 39.37 for inches.",
          "**Unmapped LEDs** still get an entry so the indices line up. They have `mapped = 0`, " +
            "and their position is interpolated between their mapped neighbours (clamped at the " +
            "ends), the same place the device renders them.",
          "**Channels** — maps don't store a channel layout. If a connected device's per-channel " +
            "LED counts add up to this map's LED count, the export uses them. Otherwise every LED " +
            "is on channel 0. `segment` is the topology segment (-1 if none) and `arclength` is " +
            "the LED's distance along it in metres.",
          "**Axes** — Splanc maps are +Y up, right-handed, which matches TouchDesigner and " +
            "Chromatik, so nothing needs converting. For Z-up tools such as Blender, pick " +
            "**Z up** before exporting the CSV.",
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
    tourRoute: "/effects/edit/tutorial-maxa-acid",
    title: "The effect editor",
    icon: "edit",
    tab: "effects",
    route: "/effects",
    summary: "Write, preview, and push shader effects with the exact on-device VM.",
    screenshot: "#/effects",
    screenshotClick: ".map-row",
    screenshotDemo: "effect",
    screenshotWaitMs: 2800,
    steps: [
      {
        pane: "preview", target: ".fxedit-canvas", title: "Author effects on Resting Deer",
        body: "This is the real editor, running the captured Acid Mode scene on the Resting Deer. Yellow bands move through space; pink floods follow the connected edges. No hardware or AI key is needed.",
      },
      {
        pane: "code", target: ".fxedit-code", title: "Two ways to move light",
        body: "In shade(), dot(led.pos, dir) places bands in 3D space. In update(), flood_from(curNode) sets a graph source; led.dist carries its distance along the edges. Edit this tutorial copy to try your own combination. Edits autosave.",
      },
      {
        pane: "uniforms", target: ".uniform-panel", title: "Tune the live scene",
        body: "These are the captured control positions, including the yellow and pink colors. Change speed, scale or sharpness for the spatial bands, or floodSpeed and floodTail for the topology pulse. The preview and device use the same values.",
      },
      {
        pane: "chat", target: ".fxedit-chatbody", title: "Write it—or ask for a change",
        body: "The AI assistant can draft changes to this same shader when you bring an API key. You can also author directly in Code; compilation and preview work without AI.",
      },
      {
        pane: "diagnostics", target: ".fxedit-diagbody", title: "Take the effect to your fixture",
        body: "With a controller connected, Send uploads the compiled effect and its live uniforms. The preview runs the same firmware VM. Your tutorial copy stays in Effects, and the original Resting Deer demo is available to duplicate again.",
      },
    ],
    gallery: [
      {
        id: "disassembly",
        caption:
          "Disassembly — the compiled `.fxb` bytecode as a readable op listing, straight from " +
          "the Rust disassembler the device uses.",
        clicks: [".map-row", ".fxlayout-tablist >> text=Disassembly"],
        waitMs: 1200,
      },
      {
        id: "device",
        caption:
          "Device — with a controller connected, push the compiled effect and drive its live " +
          "uniforms straight onto the fixture.",
        clicks: [".map-row", ".fxlayout-tablist >> text=Device"],
        waitMs: 1000,
      },
    ],
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
          "**Keypoints** — save the live uniform values as a named look stored on the " +
            "controller, tap a pad to morph back to it, or slide the morph fader between " +
            "two looks. The same keypoints appear in Show Mode and to AI agents.",
          "**AI assistant** (optional, bring-your-own-key) — describe a change in words " +
            "and have it drafted for you. With a controller connected it can also measure " +
            "the effect's real frame time on the fixture, not just estimate it.",
        ],
      },
    ],
  },
  {
    id: "show-mode",
    title: "Show Mode & the mixing deck",
    icon: "midi",
    tab: "effects",
    route: "/show",
    summary: "Cue effects onto two decks, crossfade live, and browse with a MIDI encoder.",
    screenshot: "#/show",
    screenshotDemo: "device",
    sections: [
      {
        body: [
          "Show Mode (**Effects ▸ ⋯ ▸ Show mode**) is the live mixing deck: cue an effect onto Deck A " +
            "or Deck B and crossfade between them on the device, which runs both at once and " +
            "blends their output per LED. Each deck carries its effect's keypoint pads and " +
            "morph fader.",
          "The effects list is its own scroll area: it scrolls inside the panel (touch, " +
            "wheel or keys) without moving the rest of the page. Tap it, then use ↑/↓, " +
            "Page Up/Down and Home/End to move the highlight; **Enter** loads the highlighted " +
            "effect onto the deck that was browsing, **A**/**B** load it onto that deck.",
        ],
      },
      {
        heading: "MIDI: browse with a knob",
        bullets: [
          "**MIDI map** binds every Show Mode control: crossfader, play/pause, blend mode, " +
            "keypoints, and per deck a **browse** encoder and a **load** button (an encoder's " +
            "push switch).",
          "Turning a deck's browse encoder moves the highlight (tinted in that deck's " +
            "colour); a faster turn jumps further. Pushing its load button loads the " +
            "highlighted effect onto that deck.",
          "**Encoder push** picks what load does: **Cue** loads the effect onto the deck; " +
            "**Take** loads it and crossfades to that deck over **Take fade** seconds.",
        ],
      },
      {
        heading: "Relative (endless) encoders",
        body: [
          "A knob in absolute mode sends its position (0–127), so it stops at the ends of its " +
            "travel. An endless encoder in a relative mode sends how far it turned, so the list " +
            "scrolls as far as you like. Each mapping stores its mode; when you learn an " +
            "encoder, turn it slowly a few clicks both ways and Splanc detects the mode from " +
            "the values it sends. You can change it in the mapping row.",
        ],
        bullets: [
          "**Relative — binary offset (3F/41)**: 65 = one step right, 63 = one step left, " +
            "64±n for bigger steps. The Midi Fighter Twister's “ENC 3FH/41H”.",
          "**Relative — two's complement (7F/01)**: 1 = right, 127 = left (1..63 / 127..65).",
          "**Relative — signed bit (41/01)**: 1..63 = right, 65..127 = left.",
          "**Absolute** (the default): the change between positions moves the list, up to the " +
            "knob's end stop.",
        ],
      },
      {
        heading: "Set up a Midi Fighter Twister from Splanc",
        body: [
          "**MIDI map ▸ Set up Midi Fighter Twister** (also in Settings ▸ MIDI) configures the " +
            "Twister over SysEx: pick the encoders for Deck A and Deck B, choose whether a fast " +
            "turn accelerates, and whether pushing loads. Splanc reads the Twister's current " +
            "settings, shows exactly what will change, and after you confirm writes only those " +
            "fields (MIDI type → ENC 3FH/41H, sensitivity, push action, and CC/channel when an " +
            "existing mapping needs them). Everything else on the Twister is kept. It then reads " +
            "the encoders back and maps them in Show Mode.",
          "This needs Web MIDI with SysEx: Chrome or Edge on a computer or Android, which ask " +
            "you to let the site control MIDI devices. iOS/iPadOS Safari has no Web MIDI; use " +
            "DJ TechTools' Midi Fighter Utility there (set the encoder's MIDI type to " +
            "ENC 3FH/41H), then learn it in Show Mode. If an older Twister firmware doesn't " +
            "answer the settings read, Splanc can still write the chosen encoders after an " +
            "explicit overwrite confirmation; replug the Twister afterwards.",
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
    screenshotDemo: "device",
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
    screenshot: "#/maps",
    screenshotDemo: "flash",
    screenshotWaitMs: 1400,
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
          "After flashing, provision a fresh board onto Wi-Fi like any other device. Updating a board that was already on Wi-Fi keeps its network (from the firmware release after v1.8.2), so it rejoins by itself.",
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
      {
        heading: "Hardware limits",
        bullets: [
          "The ESP32-C6 player drives two LED channels (GPIO 20 and GPIO 14 by default), up " +
            "to **1024 LEDs on each**, 2048 in all. Set each channel's count on the Hardware " +
            "screen; the device refuses a channel past 1024.",
          "**The device sizes its LED memory for the counts you set**, once at boot, so a " +
            "small fixture keeps its memory for everything else. Raising the total past what " +
            "it booted with saves the counts and restarts the device (a few seconds; the app " +
            "reconnects). A total the board's memory can't hold is refused.",
          "**The wire caps the frame rate.** A WS2812 LED takes 28.8 µs to clock out and the " +
            "two channels go out in parallel, so the longest channel sets a ceiling: 80 fps up " +
            "to about 400 LEDs, 60 at 512, 40 at 768, 30 at 1024. The Hardware screen shows " +
            "the ceiling for your layout; splitting a long strip across both channels halves " +
            "its wire time.",
          "**The effect sets the rest.** Per-LED work grows with the LED count, so a heavy " +
            "effect on 2048 LEDs runs slower than on 300. The player picks the fastest steady " +
            "rate (in 5 fps steps) the effect can hold, and stops it only below a floor: 25 fps " +
            "up to 512 LEDs, lower on longer strips (10 fps at 1024, 5 fps at 2048).",
          "Effects with per-LED `buffer` state share a 24 KB arena, so on very long strips a " +
            "wide buffer may not fit; packed types (`: fixed8`) store it in a quarter of the " +
            "space.",
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
      {
        heading: "Endless encoders",
        body: [
          "Show Mode's MIDI map binds encoders to browse the effects list, in absolute or " +
            "relative mode (see Show Mode & the mixing deck). **Set up Midi Fighter Twister** " +
            "switches a Twister's encoders to relative mode from here.",
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
    id: "debug-bundles",
    title: "Debug mode & capture bundles",
    icon: "alert",
    tab: "settings",
    route: "/settings",
    summary: "Turn on debug mode to save and share everything needed to reproduce a failed mapping run.",
    sections: [
      {
        body: [
          "**Settings ▸ Behavior ▸ Developer ▸ Enable Debug Settings** is the app's debug " +
            "mode. It adds a **Debugging** tab, and while it's on, every mapping run that " +
            "fails, comes out degenerate, falls back to its live preview, or disagrees with " +
            "the preview saves a **capture bundle** on the phone.",
          "A bundle holds what a developer needs to replay the run's solves exactly: every " +
            "LED detection with its timestamp and camera intrinsics, the motion-sensor " +
            "stream, the capture settings (stride, diffuse mode, exposure, brightness, LED " +
            "count, the fixture and its firmware version), the live-preview solves, the " +
            "final solve's result and diagnostics, and the app, solver and phone versions.",
        ],
      },
      {
        heading: "Export or share a bundle",
        bullets: [
          "Open **Settings ▸ Debugging ▸ Mapping capture bundles**. Each run is listed " +
            "with its outcome (for example `fallback-degenerate`), LED count and size.",
          "**Export** saves the bundle as one `.splanc-capture.json` file (on iPhone the " +
            "share sheet opens, so you can **Save to Files**).",
          "**Share** opens the phone's share sheet (AirDrop, Mail, Messages…) with the " +
            "file attached. If it says **Ready — tap Share again**, tap once more.",
          "Attach the file to your bug report. **Delete** removes one bundle; **Delete " +
            "all** clears them. The phone keeps the newest 20 (up to 150 MB).",
        ],
      },
      {
        heading: "Options",
        bullets: [
          "**Keep successful runs too** saves a bundle for runs that ended fine, to " +
            "compare against a failed one.",
          "**Include camera frames** adds a small camera snapshot every 2 seconds (about " +
            "1–2 MB per minute). Not available with the native iPhone camera.",
        ],
      },
      {
        body: [
          "Bundles stay on your phone until you export or share them. They contain the " +
            "capture's measurements and your fixture's name, nothing from the camera " +
            "unless you turn on camera frames.",
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
