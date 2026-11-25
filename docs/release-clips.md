# Feature-preview clips

Every app release can show short videos of its new features. Each one is a
5–15 second muted loop that plays inline in the app's **What's new** card. On
the GitHub release page, the same clip shows as an animated GIF that links to
its MP4. The clips are recorded automatically at release time from the release
build. The owner reviews them before anything ships.

This page covers:

- [How it works](#how-it-works)
- [Adding a clip for your feature](#adding-a-clip-for-your-feature)
- [The clip script format](#the-clip-script-format)
- [Recording locally](#recording-locally)
- [The review gate](#the-review-gate)

## How it works

```text
app-vX.Y.Z tag
  └─ Release workflow, job app_previews
       1. create the draft GitHub release (generated notes)
       2. bazel build //web:dist                      (the release build)
       3. release_clips record                        (plan + record)
            plan: PRs since the previous app-v tag; a clip is in the release
                  when its script changed in that range or lists one of the PRs
            record: headless Chromium plays each script, DevTools screencast
                  frames → ffmpeg → MP4 (H.264) + WebM (VP9) + GIF + poster
            PRs that changed the app but have no clip are "uncovered"; with the
            ANTHROPIC_API_KEY secret, Claude drafts a script for each of them
       4. release_clips publish → the clips + preview-clips.json go on the
          draft release, and a "Feature previews" section (GIFs) is added to
          its notes
       5. upload the `preview-clips` artifact (with a review page)
  └─ job app_review   environment: release-review   ← waits for the owner
  └─ job webapp       mirror the notes (+ clips) → stage → deploy → publish
```

- **In the app:** `tools/whatsnew/whatsnew_mirror.py` reads
  `preview-clips.json` and downloads each clip's MP4, WebM and poster into
  `whatsnew/media/`. The card shows the clips above the release's notes. A clip
  plays only while it is on screen, and never with reduced motion: the poster
  then shows with a play mark. Tapping a clip opens it full size with controls.
  A wide card shows the desktop recording when there is one; a phone shows the
  phone one.
- **On GitHub:** the API cannot attach a video the way dragging one into the
  release editor does (those uploads need a browser session), and release
  bodies strip `<video>`. So the notes show the GIF, linked to the MP4. For a
  real inline player on the GitHub page, drag the MP4 into the release editor
  by hand after publishing; the app keeps using the clip from the manifest.

## Adding a clip for your feature

1. Put a clip script next to the feature's code:
   `web/src/<area>/<id>.clip.json`. The file name must be the clip's `id`.
2. Write the steps a person would take to show the feature, using the app's
   demo seams (below). End on the result.
3. Record it locally ([below](#recording-locally)), watch it, and adjust waits
   and selectors.
4. Commit it **in the PR that ships the feature**. The next app release picks
   it up, because the script changed since the last tag. To show an older
   feature again, list the new PR in `prs`.
5. `bazel test //tools/release_clips:release_clips_test` checks every clip
   script.

A user-visible PR that should have no clip (a fix, an internal change) can
carry the `no-clip` label. It is then not listed as uncovered.

### Demo data only

Clips are published, so they must never show real data:

- Use the app's built-in sample maps and effects (seeded on first launch) and
  the `?demo=` scenarios in `web/src/demo/init.ts`. These are `device` (a
  connected "Living Room" controller), `bluetooth`, `camera`, `devmap-*`,
  `imu`, `effect`, `flash` and `play-*`. Add a scenario there when a feature
  needs hardware the browser doesn't have.
- Data the screen loads from the site (release notes, for example) comes from
  checked-in demo files mapped with `fixtures`. See
  `web/src/ui/whatsnew/clipdata/`.
- Never type names, keys, e-mail addresses or URLs that belong to anyone.
  Every recording starts from a fresh browser profile.

## The clip script format

```json
{
  "schema": 1,
  "id": "ai-settings-tab",
  "title": "AI settings have their own tab",
  "summary": "Pick where effect generation runs from Settings → AI.",
  "prs": [558],
  "route": "#/maps",
  "demo": "",
  "framing": ["phone"],
  "theme": "dark",
  "storage": {},
  "fixtures": {},
  "setup": [],
  "steps": [
    { "click": ".appbar-menu-wrap button[title='More']", "wait": 650 },
    { "click": ".appbar-menu-item:has-text('Settings')", "wait": 900 },
    { "click": ".settings-tab:has-text('AI')", "wait": 1100 }
  ]
}
```

| Field                | Meaning                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                 | `[a-z0-9-]`, 2–48 characters; also the file name and the asset names                                           |
| `title`              | Up to 60 characters. Shown on the clip in the card and as its heading on GitHub                                |
| `summary`            | Up to 240 characters. One or two plain sentences under the clip                                                |
| `prs`                | PRs this clip shows. It is included when any of them is in the release (or the script changed)                 |
| `route`              | Hash route the recording starts on, e.g. `#/settings/ai`                                                       |
| `demo`               | `?demo=` scenarios, comma-joined                                                                               |
| `framing`            | `phone` (390×844 at 2×). Add `desktop` (1280×800) only for a desktop-only feature, with `why_not_phone_dark`   |
| `theme`              | `dark`. Use `light` only for a light-theme feature, with `why_not_phone_dark`                                  |
| `why_not_phone_dark` | Required with desktop framing or the light theme: why this feature needs it                                    |
| `storage`            | `localStorage` seeds (string values), applied before the app boots                                             |
| `fixtures`           | Served path → repo file, layered over the built app (`"/whatsnew/index.json": "web/src/…/index.json"`)         |
| `setup`              | Steps run before recording starts (not in the clip)                                                            |
| `steps`              | The recorded steps                                                                                             |
| `poster_at`          | Seconds into the clip for the poster frame (default: the last frame)                                           |
| `tail_ms`            | Hold on the final frame (default 900)                                                                          |
| `app_version`        | Make a local (non-release) build report this version. Use it for update-only UI such as the What's new sparkle |

Steps (selectors are Playwright selectors: CSS, `:has-text('…')`, `>>`):

| Step                                        | Does                                                |
| ------------------------------------------- | --------------------------------------------------- |
| `{"click": SEL, "wait": ms}`                | A finger moves to the element, presses, and taps it |
| `{"type": SEL, "text": "…", "delay": ms}`   | Taps a field and types at a human pace              |
| `{"select": SEL, "label": "…"}`             | Picks a `<select>` option by its text               |
| `{"scroll": SEL, "by": px, "duration": ms}` | Smooth-scrolls an element (or `"page"`)             |
| `{"press": "Escape"}`                       | A key press                                         |
| `{"hover": SEL}`                            | Hovers (desktop)                                    |
| `{"wait_for": SEL, "timeout": ms}`          | Waits until visible (nothing on screen)             |
| `{"caption": "…", "ms": 1600}`              | A caption pill over the top of the frame            |
| `{"wait": ms}`                              | Pause                                               |

A script that runs past 15 s is trimmed, and one estimated at over 18 s is
rejected. Keep each clip to one feature.

Tips:

- Prefer stable class names and visible text over positions. Check the
  feature's own DOM in the diff.
- Clicking scrolls the target into view first. In a scrolled sheet, don't
  click the sheet's header after scrolling down; end on the result instead.
- A `wait` after each action lets the transition finish in the recording.

## Recording locally

```bash
bazel build //web:dist
bazel run //tools/release_clips:install_browser          # once
bazel run //tools/release_clips -- record \
    --spec web/src/ui/screens/ai-settings-tab.clip.json --out /tmp/clips
bazel run //tools/release_clips -- page --clips /tmp/clips --out /tmp/clips
# open /tmp/clips/index.html (or the MP4s)
```

Other commands:

- `bazel run //tools/release_clips -- plan --tag app-v1.16.0` lists the clips a
  release would get and its uncovered PRs. Without `--tag` it plans from the
  last app tag up to `HEAD`.
- `... record --tag app-v1.16.0 --out DIR [--draft-uncovered]` records exactly
  what the release would.
- `... draft --pr 558 --out DIR` asks Claude to draft a script for one PR.
  Review it, record it, and move it next to the feature.

Headless Chromium needs its system libraries. On a fresh machine run
`install_browser -- --with-deps` (uses sudo apt).

## The review gate

Nothing ships before the owner approves. The `app_review` job targets the
`release-review` GitHub environment, which has the owner as a required
reviewer, so GitHub holds the job until someone approves its deployment. The
`webapp` job (deploy to Pages and Cloudflare, publish the release) needs
`app_review`. If nobody approved (for example, the environment lost its
reviewer), `app_review` fails and nothing ships.

There are two ways to answer:

- **Review Desk (recommended).** The agent that cut the release runs
  `bazel run //tools/release_clips:desk_review -- --tag app-vX.Y.Z --wait`.
  It downloads the run's `preview-clips` artifact and posts one desk item with
  the GIFs (they play on the desk), the MP4s and the review page. The item has
  two options, **Approve release notes + clips** and **Changes needed**. The
  answer goes back to GitHub as the environment approval or rejection, using
  the owner's token.
- **GitHub.** Open the run and choose **Review deployments**, then approve or
  reject. If a desk item is open for that run, `desk_review` notes the decision
  on it and closes it.

After **Changes needed**, the run stops. To fix the release:

- **The notes:** edit the draft release.
- **A clip:** fix its script on `main`, then record and publish it again for
  the same tag (`record --tag … --ref <fixed commit>` then
  `publish --tag …`, or re-tag).

Then **Re-run failed jobs**. The review is asked again with a new desk item.

**Clip links in the draft.** A draft's files are served only under the draft's
placeholder tag (`/releases/download/untagged-<id>/`), so the draft's "Feature
previews" link those URLs, which play for anyone who can see the draft. The
final `/releases/download/<tag>/` URLs exist only once the release is
published, so the publish step runs `release_clips relink --tag <tag>`, which
points the notes at them. If that step fails (it doesn't block the deploy), run
`GH_TOKEN=… python3 tools/release_clips/release_clips.py relink --tag <tag>`.

TestFlight builds (`macos.yaml`) are not behind this gate.

One-time setup: create the `release-review` environment (Settings →
Environments) with the owner as a required reviewer. Add the
`ANTHROPIC_API_KEY` repository secret to have uncovered PRs drafted.
