# LED-Mapper App — UI/UX Overhaul (Design Doc)

Status: **Draft — source of truth for implementation.** Owner edits this to steer the build.
Scope: the phone webapp (`web/`). Firmware, the effects bytecode runtime, and the effects
compiler/agent are covered by separate sections of `next_steps.md` and are **out of scope**
here except at the interface where the app previews and uploads effects.

This is a design doc — intent, structure, screens, flows, data model, and how it maps onto
the existing `web/src` tree. It is deliberately **not** code.

---

## 1. Goal

Turn the current single-screen, param-heavy capture tool into a **minimalist, guided phone
app** with a clear spine:

> **Onboard a device → map a fixture with a live camera preview → work in a mapping
> workspace** (browse/manage maps, edit topology, preview effects offline, upload/download to
> a device).

Concretely, the overhaul must deliver:

1. A **minimalist visual system** — remove incidental text/buttons, one crisp design language.
2. Distinct **screens/states** with a real navigation model, not one scrolling page.
3. A **camera mapping screen** whose 3D preview updates live as the PnP/VIO solve runs, and
   that ingests **every** observation the user records (only the existing outlier rejection
   prunes anything).
4. A **mapping workspace**: topology (skelgraph) edit + cleanup, upload/download,
   and an **offline** effect preview with **auto-generated uniform controls**.
5. A **map browser** with a real data model and CRUD (view/select/rename/describe/tag/delete/
   search), persisted locally.
6. A **consistent device-connection UI** — status, errors, device switching — everywhere.
7. **Offline animation preview** in the workspace, with no device attached.

### Non-goals (this doc)

- The effects language, its wasm compiler, the bytecode interpreter, and the AI script agent.
  We only reserve UI surface and a data seam for them (§4.4, §8).
- Multi-user / cloud sync of maps. Local-first only (§5.3). A future export/share hook is noted.
- Rewriting the CV / solver / topology algorithms. We **reuse** `cv/`, `solver/`, `geom/`,
  `topology/`, `effects/` as-is and change only the UI layer around them.

### Design tenets

- **Local-first, offline-capable.** The workspace (browse, edit topology, preview effects) must
  work with no device and no network. A device is an *optional peripheral*, not a prerequisite.
- **One primary action per screen.** Everything else is progressive disclosure.
- **The map is the document.** The app is a lightweight document editor over a library of
  captured maps; the device is where you publish.

---

## 2. Principles — the minimalist visual system

The current app exposes internal tuning as first-class UI (a dozen sliders, debug URL params,
verbose HUD lines). The redesign hides all of that behind an **Advanced** disclosure and
commits to a single visual language.

### 2.1 Layout & structure

- **Full-bleed, single-column, mobile-first.** Target 360–430px wide; scale gracefully to
  tablet/desktop by centering a max-width column (≈ 560px, matching today).
- **Screen model, not scroll-of-sections.** Each top-level state is a screen; transitions are
  animated (§2.6). A persistent **bottom tab bar** in the workspace; a **top app bar** with a
  contextual title + back affordance elsewhere.
- **8px spacing grid.** Spacing tokens: `4 / 8 / 12 / 16 / 24 / 32`. Section padding 16.
  Card radius 12; control radius 8.

### 2.2 Color

Dark-first (matches current `color-scheme: dark`), single accent. Define as CSS custom
properties in `:root` so a light theme can drop in later.

| Token            | Value      | Use                                             |
|------------------|------------|-------------------------------------------------|
| `--bg`           | `#0E0E12`  | app background                                   |
| `--surface`      | `#17171C`  | cards, sheets                                   |
| `--surface-2`    | `#1F1F26`  | inputs, raised rows                             |
| `--border`       | `#2A2A33`  | hairlines                                       |
| `--text`         | `#E8E8EA`  | primary text                                    |
| `--text-dim`     | `#9A9AA2`  | secondary text, captions                        |
| `--accent`       | `#5B7CFA`  | primary actions, selection, focus               |
| `--accent-quiet` | `#2B3566`  | accent fill at rest (chips, tracks)             |
| `--ok`           | `#37C871`  | connected / success                             |
| `--warn`         | `#E3B341`  | connecting / advisory                           |
| `--err`          | `#F2555A`  | disconnected / errors                           |

Rules: **exactly one accent**; status colors (`ok/warn/err`) are reserved for connection and
result states and never used decoratively. LEDs in previews render as **emissive dots on
black**, independent of the UI palette.

### 2.3 Typography

- One family: `system-ui` (already in use). No web-font dependency.
- Scale (rem): `display 1.5 / title 1.15 / body 0.95 / caption 0.8`. Weights: 600 for titles &
  primary buttons, 400 elsewhere.
- **Tabular numerals** (`font-variant-numeric: tabular-nums`) for all live metrics/HUD so
  values don't jitter as digits change.

### 2.4 Iconography

- One line-icon set, single stroke width (1.5px), 24px grid. Ship as an inline SVG sprite
  (`web/src/ui/icons.ts` → `<svg><use href="#…">`), no icon-font.
- Core glyphs: `device`, `link`/`link-off`, `camera`, `map`, `graph` (topology), `play`,
  `upload`, `download`, `search`, `tag`, `trash`, `edit`, `back`, `more`, `settings`.
- Icons pair with a short label on primary actions; icon-only is allowed only in the tab bar
  and toolbar where meaning is unambiguous.

### 2.5 Components (shared)

A small kit reused across screens: `Button` (primary/quiet/danger), `IconButton`,
`Sheet` (bottom sheet / modal), `Field` (label + input), `Slider` (label + value + track),
`Chip` (tag), `Toast`, `StatusPill` (device), `Card`, `EmptyState`. These are plain DOM
factories, not a framework — see §7.

### 2.6 Motion

- Durations: `120ms` micro (press/toggle), `220ms` screen transitions, `320ms` sheets.
  Easing `cubic-bezier(.2,.8,.2,1)`.
- Screen transitions: forward = slide-in from right + fade; back = reverse. Sheets slide up.
- Respect `prefers-reduced-motion`: swap slides for cross-fades, disable the auto-orbit idle
  spin in `MapView`.
- Motion is **functional** (spatial continuity, state feedback), never ambient/looping in the
  chrome.

### 2.7 What gets removed / demoted

- The intro paragraph, the two raw download links (`map.json` / `map.csv`), and the wall of
  debug HUD move behind **Advanced** or into a share/export sheet.
- URL-param knobs (`?threshold`, `?symbols`, `?exposure`, `?trace`, …) remain as power-user
  overrides but are no longer the primary control surface. Manual exposure/brightness override
  stays, collapsed by default, one tap to reveal.
- Topology sliders (5 of them) collapse to a single **Cleanup** control with a "Fine-tune"
  disclosure (§4.2).

---

## 3. Information architecture & navigation

### 3.1 Top-level states

```
                         ┌────────────────────────────────────────┐
   first run / no device │             ONBOARDING                  │
   ─────────────────────▶│  provision device (BLE) · trust cert    │
                         │  · or "Skip — work offline"             │
                         └───────────────┬────────────────────────┘
                                         │  (device linked OR skipped)
                                         ▼
   ┌─────────────────────────────  WORKSPACE (tab shell)  ─────────────────────────┐
   │                                                                                │
   │   ┌──────────┐      ┌──────────┐      ┌──────────┐      ┌──────────┐          │
   │   │  MAPS    │      │  MAP     │      │ EFFECTS  │      │ DEVICE   │          │
   │   │ (browser)│◀────▶│ DETAIL   │◀────▶│ preview  │      │ (sheet)  │          │
   │   └────┬─────┘      └────┬─────┘      └──────────┘      └──────────┘          │
   │        │                 │  edit topology / upload / download                  │
   │        │ "＋ New map"     │                                                     │
   └────────┼─────────────────┼─────────────────────────────────────────────────────┘
            ▼                 │
   ┌──────────────────┐       │
   │  CAMERA MAPPING  │───────┘  (Stop & finish → solve → lands in MAP DETAIL,
   │  (full-screen)   │           new map saved to the library)
   └──────────────────┘
```

The **Device** connection surface (§6) is global chrome — a persistent status pill in the app
bar that opens a device sheet — not a tab you navigate "into". It is reachable from every
screen, including full-screen camera mapping.

### 3.2 The tab shell (workspace)

Bottom tab bar, three tabs:

- **Maps** — the map browser (§5). Default landing after onboarding.
- **Effects** — offline effect preview against the selected map (§4.4, §7-offline).
- **Device** — opens the device sheet (§6). (Could be an app-bar pill instead of a tab; see
  Open Questions.)

The app bar hosts the title, a **back** affordance when drilled into Map Detail / Camera, and
the **device status pill** on the right.

### 3.3 Routing

Hash-based routes (static Cloudflare host, no server routing): `#/onboard`, `#/maps`,
`#/map/:id`, `#/map/:id/topology`, `#/effects`, `#/capture`. Deep-linkable; `?url=<wss>`
still selects/links a device on load (back-compat with today's flow). A single lightweight
router owns the active screen and mount/unmount of heavy views (`MapView`, camera).

---

## 4. Screens & flows

### 4.1 Onboarding

Purpose: get from "fresh install" to a linked device (or an explicit offline start) with the
**minimum** taps, wrapping the two gnarly realities — BLE Improv provisioning and self-signed
`wss://` cert trust — that already live in `main.ts` / `net/improv.ts`.

Shown only when there is no known device and no maps, or via **Device → Add device**.

```
┌─────────────────────────────┐   ┌─────────────────────────────┐   ┌─────────────────────────────┐
│  ◐  Set up your player       │   │  Provisioning…               │   │  ⚠ Trust this device         │
│                              │   │                              │   │                              │
│  [ Wi-Fi SSID            ]   │   │   (•)  joining "HomeNet"      │   │  It uses a self-signed cert. │
│  [ Wi-Fi password        ]   │   │        …                     │   │  Trust it once to connect.   │
│                              │   │                              │   │                              │
│  [   Connect via Bluetooth ] │   │   this can take ~20s         │   │  [ Trust & connect ]         │
│                              │   │                              │   │   or open <link> manually    │
│  ── or ──                    │   │                              │   │                              │
│  [ Enter address manually ]  │   │                              │   │  status: connecting…         │
│  [ Skip — work offline    ]  │   │                              │   │                              │
└─────────────────────────────┘   └─────────────────────────────┘   └─────────────────────────────┘
   Step 1: credentials              Step 2: BLE provision            Step 3: cert trust (auto-detect
   (SSID pre-filled from cache)     (Improv Wi-Fi)                    returns to workspace on success)
```

Flow notes (preserve existing behavior, restyle the surface):

- **BLE only where supported** (`bleAvailable()`), Chrome/Android. On iOS/unsupported, hide the
  Bluetooth path and offer **Enter address manually** + **Skip**.
- SSID/password **pre-filled from `WIFI_CACHE_KEY`** cache; the WiFi prompt becomes a proper
  two-field form (replacing the current `prompt()` calls) so re-provisioning a second player
  is one screen.
- **Cert-trust popup flow is unchanged** (`showCertApprovalPrompt`): stop the reconnect loop,
  open the device https popup, listen for `postMessage("ledmapper-cert-ok")` and the
  visibility-return fallback, then reconnect. Only the presentation moves into this step's card.
- **Skip → offline** lands directly in **Maps**. Onboarding is never mandatory: you can browse,
  edit, and preview without a device and add one later from the Device sheet.

### 4.2 Camera mapping (full-screen)

Purpose: capture a fixture by walking an arc, with a **live-updating 3D preview** of the solve
and a **"record as long as you like"** model. This is the current in-capture overlay,
restructured around the live preview and stripped of clutter.

```
┌───────────────────────────────────────────────┐
│  ‹        Map — 64 LEDs             ◉ 01:12   │  ← app bar over camera: back, LED count, timer
│                                               │
│              [ live camera feed ]             │
│         · detection/label overlay ·           │  ← labels.ts draws blob ids over the video
│                                               │
│                                    ┌────────┐ │
│                                    │ 3D     │ │  ← live solve inset (MapView): grows/updates
│                                    │ solve  │ │     every poll; tap to expand full-screen
│                                    │  ●●● ● │ │
│                                    └────────┘ │
│                                               │
│   ▸ Advanced (exposure / brightness)          │  ← collapsed manual override (was cap-controls)
│                                               │
│   38 / 64 LEDs solved · keep circling ▸       │  ← single guidance line (server status poll)
│                                               │
│                 (  ◼  Stop & finish  )        │  ← one primary action
└───────────────────────────────────────────────┘
```

**Live preview UX (the core requirement):**

- The 3D inset (`MapView` fed by `getLiveMap()` at the existing ~400ms cadence, or the
  local `SolverAgent` streaming `SolveSnapshot`s) **animates in place** as points appear and
  positions refine. `MapView.update()` already swaps maps without resetting the camera — keep
  that; add a subtle "settling" cue (new points fade/scale in; RMS drop nudges a small quality
  chip green→ good).
- **Tap the inset to promote it** to a full-screen split with the camera as a thumbnail, for a
  proper look at convergence mid-capture, then tap back.
- The **2D detection/label overlay** (`labels.ts`) stays over the video — it's the immediate
  "am I seeing LEDs" feedback. Keep it; restyle to the new palette.
- Guidance is **one line** driven by the server coverage poll ("keep circling — N LEDs seen
  from one spot" / "N/M triangulable"). The dense multi-line debug HUD moves behind Advanced.

**Record-as-long-as-you-want model (explicit requirement):**

- Capture runs until the user taps **Stop & finish** (or the OS ends the media session). There
  is **no cap** on duration or observation count and **no automatic pruning/discarding** of
  observations in the app. Every decoded `DetectionRecord` is streamed to the device and
  **retained locally** (`localDetections`, `localImu`) exactly as today.
- The **only** filtering is the existing **outlier rejection inside the solver** (`solver/`,
  RMS-reprojection gating). The app must not add its own downsampling, dedup, or "enough
  observations" early-stop. Longer captures → more observations → strictly better/denser solve.
- Copy reflects this: the live chip reads e.g. "1,240 observations · 38/64 solved" so the user
  understands more recording only helps. A soft, dismissible note may appear at very long
  captures ("memory ~X MB") but never truncates.
- **Stop** runs the final solve (phone wasm `SolverAgent` vs host, via `chooseSolvePlacement`),
  shows the solve progress, then **saves the result as a new map** in the library and navigates
  to **Map Detail** (§4.3). No separate "Result" screen — the workspace *is* the result.

### 4.3 Map Detail / mapping workspace

Purpose: the working surface for a single captured map — inspect the 3D solve, edit the
skelgraph topology, upload/download to a device, jump to effects preview, and manage the map's
metadata.

```
┌───────────────────────────────────────────────┐
│  ‹  Living-room ceiling            ⋯   ● conn │  ← name (rename inline) · overflow · device pill
├───────────────────────────────────────────────┤
│                                               │
│            [ 3D map  ·  MapView ]             │  ← orbit/pan/zoom; topology overlay when on
│                                               │
├───────────────────────────────────────────────┤
│  64 LEDs · 2.4 m · rms 0.7 px · 12 Jul        │  ← quiet metadata strip (from OutputMap.stats)
├───────────────────────────────────────────────┤
│  [ Topology ]  [ Effects ]  [ Send to device ]│  ← three primary paths
│                                               │
│  ▾ Topology                                   │  ← expands the cleanup panel (below)
│     Cleanup  ─────●──────   ( auto )          │  ← single knob; "Fine-tune ▸" reveals the 5
│     8 junc · 5 seg · 2.4 m · 64/64 LEDs       │     ExtractOptions sliders
│     [ Apply to device ]                       │
└───────────────────────────────────────────────┘
```

**Topology (skelgraph) edit + cleanup (§4 requirement):**

- Reuse `topology/extract.ts` (`extractTopology`, `ExtractOptions`) unchanged, incl. its
  cooperative scheduling (`AbortSignal` + `onProgress`) — the extractor is O(n²) and already
  yields; keep the progress row + Abort.
- Collapse today's five raw sliders (`radiusFactor`, `pruneFactor`, `loopFactor`, `simplifyFrac`,
  `maxPolyline`) into **one "Cleanup" slider** mapped to a sensible curve over the two knobs
  that matter perceptually (radius + prune), with **auto** as the default. **Fine-tune ▸**
  discloses the full five for power users.
- Live overlay on `MapView.setTopology()` on every change (as today), with the segment/junction
  summary. Extraction is previewed continuously; **upload is an explicit step** (`submitTopology`).
- Downloaded/pulled maps that already carry a topology skip re-extraction unless the user opts to
  re-clean.

**Upload / download (§4 requirement):**

- **Send to device** (upload): pushes map + current topology to the connected player
  (`submitTopology`, and map submission where the device supports it). Disabled with a clear
  reason when no device is connected (links to the Device sheet).
- **Pull from device** (download): `client.pullStoredMap()` with its chunk-progress callback,
  imported as a **new library entry** (dedup by device-provided `mapId`).
- **Export / Import**: `.binpb` MappingBundle (`encodeMappingBundle`/`decodeMappingBundle`) via a
  share sheet, so a map can be moved to the effects-simulator workspace or another phone. The old
  raw `map.json` / `map.csv` links live here under **Export ▸**.

**Overflow (⋯):** Rename, Edit description, Tags, Duplicate, Delete, Export. (These are the CRUD
verbs from §5.)

### 4.4 Effects preview (offline, in the workspace)

Purpose: preview animations on the **selected map with no device** (§7-offline requirement), and
host the **auto-generated uniform controls** for the coming effects runtime.

- **Today's baseline (reuse):** the effects-simulator (`effects/main.ts`, `effects/sim.ts`) runs
  the **exact firmware Sim compiled to WASM** and renders glowing LEDs via `MapView` per-LED
  colors (`setLedColors`). Bring that engine into the workspace as the **Effects** tab, driven
  by the *selected library map* instead of a synthetic/imported fixture.
- **Auto-generated uniform controls (forthcoming runtime seam):** when the effects runtime lands,
  an effect **publishes a uniform schema** (name, type, default, range/step, label). The app
  renders that schema to controls automatically via the shared kit:

  | Uniform type        | Control        |
  |---------------------|----------------|
  | `float` (with range)| `Slider`       |
  | `int` (with range)  | stepped `Slider`|
  | `bool`              | toggle         |
  | `color`             | color swatch   |
  | `enum`              | dropdown       |
  | `trigger`           | button (one-shot)|

  This replaces today's hard-coded pulse/flood sliders (`fx-speed`, `fx-glow`, …) with a
  data-driven panel. Changing a uniform re-runs the preview immediately (**hot-reload**), and —
  when a device is connected — the same uniforms drive live retune (`setPlayback`), so **one
  control surface** works offline and online. The AI-generated-script hot-reload path (out of
  scope) plugs into this same "schema → controls → re-run" seam.
- **Fully offline:** requires no device and no network — the WASM sim + local map are enough. A
  play/pause + scrub timeline sits under the preview.

---

## 5. Data model — the map library

### 5.1 Requirement

A **map browser**: every captured map viewable, selectable, modifiable, deletable; rename, add
descriptions, tag for search. Persisted locally.

### 5.2 Stored record

A library record **wraps** the protocol `OutputMap`/`Topology` (unchanged wire types) with app
metadata. TypeScript-ish shape:

```ts
interface StoredMap {
  id: string;              // uuid (app-owned; distinct from OutputMap.mapId)
  name: string;            // user-editable; default e.g. "Ceiling · 12 Jul 14:03"
  description: string;     // free text (markdown-lite, optional)
  tags: string[];          // normalized lowercase; drives search/filter

  createdAt: string;       // ISO — from OutputMap.createdAt at capture
  updatedAt: string;       // ISO — bumped on any edit
  source: "capture" | "pull" | "import"; // provenance

  // --- denormalized summary (for the browser list; avoids loading full map) ---
  ledCount: number;        // OutputMap.ledCount
  units: "meters";         // OutputMap.units
  frame: OutputMap["frame"]; // "webxr_session_ref" | "gravity_leveled"
  rmsReprojPx: number;     // OutputMap.stats.rmsReprojPxGlobal (quality signal)
  hasTopology: boolean;
  deviceMapId?: string;    // OutputMap.mapId, for dedup on pull
  thumbnail: string;       // dataURL — small MapView snapshot (see §5.4)

  // --- payload (may be lazy-loaded from a separate store on open) ---
  map: OutputMap;
  topology?: Topology;
}
```

The **summary fields are duplicated out of the payload** so the browser list renders from a
lightweight index without deserializing every full `OutputMap`.

### 5.3 Storage — recommendation: **IndexedDB**

Recommend **IndexedDB** over localStorage:

- Maps are large (hundreds–thousands of LEDs + polylines + trajectory + a thumbnail dataURL);
  localStorage's ~5MB string quota and synchronous, main-thread API are the wrong fit.
- IndexedDB gives structured records, async access, and room to grow.

Layout: one DB `ledmapper`, two stores:

- `maps_index` — `StoredMap` **without** the `map`/`topology` payload (the summary + thumbnail).
  Fast to scan for the browser; indexed by `updatedAt`, `tags` (multiEntry), `name`.
- `maps_payload` — keyed by `id` → `{ map, topology }`. Loaded lazily on open.

Keep small prefs (last device `wss` URL, WiFi cache, calibrated-K, UI theme) in localStorage as
today. Wrap all of this behind a `MapStore` module (§7) so the storage engine can change later
(e.g. OPFS/export sync) without touching screens. A one-time migration imports any existing
`.binpb` the user has and seeds the store.

### 5.4 Thumbnails

On save, render the solved `MapView` once off-screen to a small canvas → `toDataURL()` (a fixed
orbit, LEDs on black). Stored inline in the index record; cheap to list.

### 5.5 Map browser screen

```
┌───────────────────────────────────────────────┐
│  Maps                              ● connected │
│  [ 🔍 search name / #tag …            ]        │
│  [ #ceiling ] [ #tree ] [ #ring ]  ← tag chips │
├───────────────────────────────────────────────┤
│  ┌───────┐ Living-room ceiling                 │
│  │ thumb │ 64 LEDs · rms 0.7px · 12 Jul   ⋯    │
│  └───────┘ #ceiling #home                      │
├───────────────────────────────────────────────┤
│  ┌───────┐ Xmas tree                           │
│  │ thumb │ 200 LEDs · rms 1.1px · 3 Jul   ⋯    │
│  └───────┘ #tree                               │
├───────────────────────────────────────────────┤
│                                                │
│           (empty state when no maps:           │
│            "No maps yet — map a fixture")       │
│                                                │
│                              ( ＋  New map )    │  ← FAB → Camera mapping (§4.2)
└───────────────────────────────────────────────┘
```

- **Search** matches name, description, and tags; tag **chips** filter. Sort by `updatedAt`
  (default), name, or LED count.
- **Row tap → Map Detail** (§4.3). **⋯** or long-press → context sheet: Rename, Edit
  description, Tags, Duplicate, Export, **Delete** (confirm).
- Inline edits (rename/description/tags) are bottom sheets; each bumps `updatedAt`.
- **＋ New map** → Camera mapping.

**CRUD → `MapStore` API surface** (the browser and detail screens call only this):
`list(query?) · get(id) · create(fromSolve) · rename(id,name) · setDescription(id,text) ·
setTags(id,tags) · duplicate(id) · delete(id) · importBundle(bytes) · exportBundle(id)`.

---

## 6. Device connection UI

Requirement: consistent across the app, clear status + errors, switch between / manage devices.

### 6.1 Global status pill

A **StatusPill** lives in the app bar on **every** screen (and over the camera). It shows the
connection state via color + icon + short text:

```
 ● connected        (--ok,   link icon)      — wss up, clock synced
 ◐ connecting…      (--warn, spinner)        — connecting / cert-trust pending / provisioning
 ○ offline          (--text-dim, link-off)   — no device linked (explicit offline)
 ⚠ error            (--err,  alert)          — connect failed / server error (tap for detail)
```

The pill reflects the existing client lifecycle (`onConnecting / onConnected / onDisconnected /
onServerError`) plus clock-sync completion. Tapping it opens the **Device sheet**.

### 6.2 Device sheet

A bottom sheet, reachable everywhere:

```
┌───────────────────────────────────────────────┐
│  Devices                                    ✕  │
├───────────────────────────────────────────────┤
│  ● Player-A2F1   wss://192.168.1.42   ✓ active │
│      offset 1.2ms · rtt 8ms · 64 LEDs          │
│  ○ Studio player wss://192.168.1.51            │
│      [ connect ]                    [ forget ]  │
├───────────────────────────────────────────────┤
│  [ ＋ Add device (Bluetooth) ]                  │
│  [ Enter address manually ]                     │
├───────────────────────────────────────────────┤
│  ⚠ Self-signed cert — [ Trust & connect ]      │  ← inline cert-trust when relevant
└───────────────────────────────────────────────┘
```

- **Known devices** persist (localStorage): `{ id, label, wssUrl, lastSeen }[]`. **Switch** by
  tapping connect (tears down the current client, connects the new URL, re-syncs clock). This
  generalizes today's single `?url=` binding into a managed list; `?url=` on load still
  auto-adds/selects a device.
- **Errors are surfaced in-context**: connection failure, server errors, and the self-signed
  cert flow render **inside this sheet** (and mirrored in the pill), instead of today's ad-hoc
  `#err` block. The cert-trust popup logic (§4.1) is invoked from here for cross-origin `wss`.
- **Add device** re-enters the onboarding provisioning/cert steps (§4.1) as a sheet.
- Consistency: every "needs a device" action (Send to device, Pull, live retune) routes its
  disabled/error state through this same pill + sheet, so the connection story is identical
  everywhere.

---

## 7. Component breakdown — mapping onto `web/src`

The overhaul is a **UI-layer** change. Algorithms (`cv/`, `solver/`, `geom/`, `topology/`,
`effects/sim`, `net/`) are reused; `ui/main.ts` is decomposed into screens + a shared kit +
stores.

### 7.1 Keep as-is (reuse)

| Area                | Modules                                                        |
|---------------------|---------------------------------------------------------------|
| CV pipeline         | `cv/*` (`pipeline`, `detect`, `decoder`, `tracker`, `exposure`)|
| Solver              | `solver/agent`, `solver/placement`                            |
| Geometry / fit      | `geom/*`                                                       |
| Topology            | `topology/extract` (+ `ExtractOptions`, cooperative hooks)    |
| Effects engine      | `effects/sim`, `effects/fixtures` (offline WASM sim)          |
| Net / device        | `net/client`, `net/proto`, `net/improv`, `net/clocksync`, `frameCapture`, `trace` |
| Capture sources     | `xr/*` (`mediaStreamCapture`, `imu`, `intrinsics`, `exposureControl`) |
| 3D preview          | `ui/mapview` (+ `ui/labels`, `ui/markers`)                    |

`MapView` already supports the three modes we lean on (live update without camera reset,
topology overlay, per-LED effect colors) — no changes needed beyond the reduced-motion idle-orbit
tweak (§2.6).

### 7.2 New: shared UI kit — `web/src/ui/kit/`

`tokens.css` (the §2 custom properties), `Button.ts`, `IconButton.ts`, `Sheet.ts`, `Field.ts`,
`Slider.ts`, `Chip.ts`, `Toast.ts`, `StatusPill.ts`, `Card.ts`, `EmptyState.ts`, `icons.ts`
(SVG sprite). Plain DOM factories; no framework dependency (keeps the static-bundle story).

### 7.3 New: app shell & router — `web/src/ui/app/`

`router.ts` (hash routes, mounts/unmounts screens), `shell.ts` (app bar + tab bar + pill),
`state.ts` (tiny observable store: selected map id, device list/status, theme).

### 7.4 New: screens — `web/src/ui/screens/`

| File                     | Replaces / built from                                              |
|--------------------------|-------------------------------------------------------------------|
| `onboarding.ts`          | the BLE + cert-trust code in `main.ts` (`showCertApprovalPrompt`, `blesetup` handler) |
| `capture.ts`             | the entire capture loop in `main.ts` (probe → `startMapping` → per-frame → live poll → stop/solve) |
| `mapDetail.ts`           | the `#result` section + topology controls + upload/download handlers |
| `mapBrowser.ts`          | **new** (no equivalent today)                                     |
| `effects.ts`             | `effects/main.ts` (bring the simulator in-app, driven by `MapStore`) |
| `deviceSheet.ts`         | the `#conn`/`#err` UI + `?url` binding, generalized to a device list |

`capture.ts` is the biggest lift: extract the ~700-line capture loop out of `main.ts`
verbatim (probe, negotiate, per-frame detect/decode, IMU batching, live-map/status polls,
manual override, final solve/placement) and re-parent its DOM into the new full-screen layout.
Behavior is unchanged; only presentation and the "save result to `MapStore`" tail are new.

### 7.5 New: stores — `web/src/store/`

`mapStore.ts` (IndexedDB-backed `MapStore`, §5), `deviceStore.ts` (known devices + active,
localStorage), `prefs.ts` (theme, WiFi cache, calibrated-K — existing keys). Screens depend on
these interfaces, never on storage APIs directly.

### 7.6 New: effects uniform layer — `web/src/effects/uniforms.ts`

Maps a published **uniform schema → kit controls** (§4.4). Feeds both the offline sim and (when
connected) live `setPlayback` retune. This is the reserved seam for the forthcoming runtime; the
current pulse/flood params are expressible as a hard-coded schema until the runtime publishes real
ones.

### 7.7 `index.html`

Shrinks to an app-shell mount point (`<div id="app">`) + the token stylesheet + the module
entry (`ui/app/main.ts`). The current inline `<style>` and static section markup move into the
kit/screens. `wall.html` and `effects.html` can remain as standalone dev tools or fold into the
app; recommend keeping `wall.html` (virtual LED wall for testing) as-is.

---

## 8. Future seams (reserved, not built here)

- **Effects editor + AI agent:** the Effects tab's uniform panel and hot-reload seam (§4.4/§7.6)
  are where the code editor, wasm compiler output, and Claude-generated scripts will attach. The
  data-driven control model means a new effect needs zero new UI.
- **Performance metrics HUD:** reserve a slot in Map Detail / Effects for device-reported perf
  (exec time, memory) and the offline device-model estimate.
- **Sharing / cloud:** `MapStore.exportBundle` is the hook for a future share/sync backend.

---

## 9. Open questions

1. **Device: tab vs. app-bar pill only?** §3.2 lists Device as a tab, but it's really global
   chrome. Leaning toward **pill-only** (opens the sheet) and making the third tab **Effects** +
   a **Settings**/overflow. Decide the final tab set.
2. **Live preview source of truth during capture:** server `getLiveMap` poll (works today) vs.
   local `SolverAgent` streaming snapshots (lower latency, offline-capable). Ship server-poll
   first, add local streaming as an enhancement?
3. **Map upload support:** the device path today reliably supports topology upload and *pull*;
   confirm the firmware accepts a full **map** submission (`SubmitMapMessage`) so "Send map to
   device" is real vs. topology-only.
4. **Cleanup single-knob curve:** which two of the five `ExtractOptions` the one slider drives,
   and the mapping curve. Proposal: radius + prune; validate on real captures.
5. **iOS constraints:** no Web Bluetooth (BLE onboarding hidden) and stricter media/motion
   permissions — confirm the "Enter address manually / offline" paths fully cover iOS.
6. **Storage quota / eviction:** IndexedDB can be evicted under pressure. Do we request
   persistent storage (`navigator.storage.persist()`) and/or nudge users to export important maps?
7. **Thumbnail cost:** off-screen `MapView` render on every save — acceptable, or generate lazily
   on first browser view?
