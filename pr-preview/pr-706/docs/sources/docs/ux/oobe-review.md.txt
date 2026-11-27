# Out-of-box experience review (D-219)

A tester took a Splanc lamp home and set it up with the app. This review covers
what they ran into, the root causes, and what a crisp first run looks like, from
opening the app to the first effect playing on the lights. The fixes in this PR
cover the part from "connected" to "playing and tuning". The connect flow itself
belongs to two other PRs: #577 (one Connect button, the picker, saved Wi-Fi,
auto-discovery) and #564 (wrong Wi-Fi password). Requests for those PRs are
listed at the end.

## What the tester hit

1. **"Do I need to flash again when I get home, or should it just connect?"**
   The lamp was set up on one Wi-Fi network and then taken to another. It didn't
   show up as an available device, and nothing in the app explained why or what
   to do. The answer is "set it up again over Bluetooth, don't flash", but the
   app never says so.
2. **"I find the app pretty unintuitive."** What they wanted, in their own words:
   see my device → a menu of effects → apply an effect and tune it. "That flow
   needs to be super clear. And then getting into adjustments to the effect
   nested."
3. **"Where is the way to get to the effects menu from here?"** This was asked
   while looking at the device drawer, which had just connected to the lamp.
   The drawer has no way forward.
4. **"A lot of the parts of the app are bleeding off to the side / not polished."**
5. Their screenshot shows a **"Play with the Halloween lights"** button in the
   device drawer. That button was retired on 4 Nov (#437, app-v1.13.1). The
   tester was running a build more than two weeks old.
6. Not a complaint: "Pretty cool having it just buzzing away." Once an effect was
   running, the product worked.

## Root causes

| #    | Area        | Root cause                                                                                                                                                                                                                                                                                                                |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Error state | A known fixture that can't be reached shows only as offline. No copy separates "different Wi-Fi" from "unplugged", and none says a network move needs Bluetooth setup, not a reflash.                                                                                                                                     |
| 1, 2 | Flow        | **Every launch opened "Set up your device".** The installed app starts at a URL with no `#` route, and the router turned an empty route into `/onboard`. The "first run → setup, otherwise home" fallback was unreachable. A returning user with a known, working lamp saw the setup screen and a row of unlabeled icons. |
| 2    | Flow        | After setup, Continue landed on **Maps**, the mapping library. Mapping is an advanced step that most fixtures never need. The effects were one tab over, and nothing pointed there.                                                                                                                                       |
| 2    | Flow        | Tapping an effect opened the **full code editor**: code, a pane strip, disassembly, MIDI, AI chat. "Apply and tune" was buried inside an authoring tool.                                                                                                                                                                  |
| 2    | Copy        | The effects list led with seeded developer tags (`#demo #spatial #starter #test #topology #volumetric`). Every row showed the same sparkle icon and a seed date ("Nov 20") instead of what the effect looks like. Starters, map showcases and the user's own drafts were mixed in one list.                               |
| 2    | Copy        | Tuning controls showed raw shader names (`drift`, `base`).                                                                                                                                                                                                                                                                |
| 3    | Flow        | The device drawer is a dead end: connecting there doesn't lead anywhere. (Owned by #577.)                                                                                                                                                                                                                                 |
| 4    | Layout      | On a phone the code editor's pane strip overflows. Tabs run under the move/hide controls and off the right edge, and the toolbar buttons sit 0–5 px apart. A first-time user only saw this because a tap on an effect opened the editor.                                                                                  |
| 5    | Updates     | Testers can sit on old builds. Nothing tells them a newer build exists. #506 ("What's new?") only speaks up after an update has happened.                                                                                                                                                                                 |

## What crisp looks like

One straight line, one primary action per screen:

1. **Welcome**: "Set up your device". Fixtures already on the network are listed,
   one tap to connect; otherwise **Connect a fixture**. (#577)
2. **Connected**: **Continue** goes to **Effects**, the app's home.
3. **Effects (home)**: a card on top says what's connected ("Living Room — Tap an
   effect to play it on the lights"). Below it are **Starters** in a curated
   order, each with a one-line description, then **Your effects**, then the
   sample-map **Examples**. No developer tags.
4. **Tap an effect**: it plays on the fixture right away and a sheet opens:
   "Playing on Living Room", then **Adjust**, with the effect's sliders and
   colours under readable names. The editor is one quiet step further in:
   **Open in editor** (change the code, preview on a map, ask AI to remix).
5. **Something's wrong**: the same top card turns red and says what to do:
   "Can't reach Tegani. Check it's plugged in and your phone is on the same
   Wi-Fi. Moved it to a different Wi-Fi? Set it up again over Bluetooth. No
   need to flash it again." The card's one button is **Open devices**.

The tab bar is now Effects · Maps · Device, so the home tab comes first.

## Fixed in this PR

- **Opening the app goes home, not to setup.** An empty route now reaches the
  router's fallback: setup on a first run (no known fixture), otherwise
  Effects. (`app/router.ts`, with a router test.)
- **Home is Effects.** A returning user and setup's Continue both land there,
  and Effects is the first tab. (`app/main.ts` fallback, `shell.ts`, one line
  in `onboarding.ts`.)
- **Fixture card** at the top of Effects (`effects/quickPlay.ts`
  `fixtureCard`). It covers four states: none known (Connect a fixture),
  connecting, unreachable (with the Wi-Fi-move copy), and connected (what's
  playing). It asks the device what it's running when the tab opens.
- **Tap = play + tune** (`screens/effectTune.ts`). The effect compiles and
  uploads with the editor's own seams (`withDeviceLock`, `submitEffect`,
  `deviceEffects.markSent`). Controls use the editor's `UniformPanel` with
  readable labels and live sends through `client.live`. With nothing connected,
  the sheet says so and offers Connect, and it starts the effect once a fixture
  connects. The row ⋯ menu still has Edit / Open in editor, Rename, Tags, Move,
  Duplicate and Delete.
- **Library sections**: Starters (curated order, the colour test last),
  Examples for the sample maps, and Your effects (which come first once you
  have some). Built-ins show a description instead of a date. Tag chips show
  only the user's own tags. The playing effect gets a green "Playing" mark.
  Names wrap to two lines instead of clipping to "Agentic c…" on desktop. The
  FUG-110 "On <device>" list is gone from this view, because the card and the
  Playing mark already show what's on the lights. The last row no longer sits
  under the floating + button.
- **User guide** copy and capture steps updated for the new tap behaviour
  (regenerated `docs/user-guide*`).
- **Layout guard** scenarios for the whole path (`tools/ui_layout/oobe_scenarios.py`)
  at phone and desktop, light and dark, plus a `fxstub` demo seam so the tune
  sheet renders without the compiler wasm.

## Not in this PR

- **The code editor's phone layout.** The pane strip overflows and the toolbar
  is crammed (the layout guard reports 30+ issues at 390 px). New users no
  longer land there, but it needs its own pass. #586 is editing
  `effectEditor.ts` right now, so the pass should come after #586 merges.
- **Effect thumbnails.** Live previews are behind an experimental flag (slow on
  phones). Pre-rendered stills for the built-ins would replace the sparkle icon.
- **Saving tuned values.** The tune sheet adjusts the effect live, the same way
  the editor's sliders do. A "keep these settings" step (keypoints) would be a
  follow-up.

## Requests for other open PRs

**#577 (connect flow)** owns the welcome screen, the device drawer and the
connect picker:

1. **Drawer: a way forward.** When the active fixture is connected, put one
   primary button under its row: **Choose an effect**. It closes the drawer and
   opens `#/effects`. "Connect a fixture" and "Flash a new device" stay quiet,
   so the drawer has one primary action.
2. **Drawer: an unreachable known fixture says what to do.** In place of a bare
   offline dot, the row reads "Can't reach it. Moved to a different Wi-Fi? Set
   it up again over Bluetooth. No need to flash it again." It gets a **Set up
   Wi-Fi again** action that opens the picker on "Set up over Bluetooth". The
   copy matches the Effects tab's card (`fixtureCard` in
   `web/src/effects/quickPlay.ts`).
3. **Welcome: Continue says where it goes.** Once connected, the CTA reads
   **Choose an effect**. It lands on `#/effects` (this PR changes the `done`
   route; keep that line when rebasing). Update the onboarding doc comment,
   which still says "lands on the Maps tab".
4. **Drawer layout.** On main, the layout guard fails the device drawer at both
   widths: the connected row's ⋯ overlaps the sheet's ✕, Disconnect and
   Options, and Disconnect sits 4 px from Options. Run
   `bazel run //tools/ui_layout:ui_layout_check` with a drawer scenario
   against #577's drawer (`?demo=device,discovered`, click
   `.tab[data-tab=device]`, root `.k-sheet`) before merging.
5. **Drawer rows on a phone:** the subtitle "on this network · 192.168.1.…"
   truncates next to Connect + ⋯. Drop the IP from the subtitle (it's in the
   ⋯ details) so the row never clips.

**#583 / #587 / #579 (sign-in, Apple IAP, privacy notice):** none of them
should prompt on the first run. Sign-in and the privacy notice appear inside
the credits flow and Settings, never before the first effect plays.

**#506 ("What's new?")** and the **release preview-clips** workstream: the
"tap an effect, it plays, tune it" path is the strongest first clip. #506 only
appears after an update. Testers on old builds need an update prompt (owner
decision below).

**#586 (device metrics):** it edits `effectEditor.ts`, so the editor's
phone-layout pass waits for it to merge.
