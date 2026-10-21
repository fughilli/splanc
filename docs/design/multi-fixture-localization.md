# Multi-fixture relative localization

> "For multi-fixture setups, it should be possible to manually localize the
> fixtures w.r.t. one another via a mapping run on a phone. When they all get
> captured in the same run, their pose offsets can be determined."

Each fixture (an ESP32-C6 player) already has its own LED map: 3D positions in
its own frame, +Y up, metric, from its own phone mapping run. This feature puts
several fixtures into one room frame. One phone capture films them together,
the solver recovers each fixture's pose relative to a reference fixture, and the
user can then fine-tune by hand. The result is stored where `set_fixture_pose`
stores it (on the device, plus the agent hub's config), so `led.room` effects and
the agent's room model use it.

Related: [agent-multi-fixture.md](agent-multi-fixture.md) §2 (the room frame and
the `FixturePose` / `led.room` contract; this is its "follow-up hook" 2),
[mapping-solve-paths.md](mapping-solve-paths.md) (capture bundles),
[live-vj-relay.md](live-vj-relay.md) (the bridge multiplexer).

## 1. What is stored, and who reads it

`FixturePose { room, translation (m), rotation (quat xyzw), scale }` gives

    p_room = translation + scale · R(rotation) · p_map

- **Firmware**: persisted by `set_fixture_pose` and echoed in `welcome.pose`.
  The FX VM's `led.room` builtin is precomputed from it.
- **Agent hub**: `config.poses[id]`. `Hub.pose(id)` now falls back to the pose
  the device reports in its welcome. So poses written by the app appear in
  `splanc://room/<room>`, `plot_fixture` (fixtures placed by pose) and
  `preview_effect`, with no hub-side write needed. Through a bridge, the app's
  `set_pose` also writes the hub config.
- **App**: reads `welcome.pose` (prior poses, "Adjust by hand") and writes
  through the same transport the capture used.

Scale is part of the pose. Maps come from the visual-inertial solver, so they
are metric, but only to a few percent (`OutputMapStats.scale_rel_std_err`; see
the "solver scale collapse" history). A 3 % scale error on a fixture 3 m from
the camera is a 9 cm depth error, so relative scale is **solved, not assumed**
(§3.4). The reference fixture's map defines the room's metre.

## 2. Choices and why

| Question | Choice | Why |
| --- | --- | --- |
| Distinguishing fixtures in one frame | **One shared code book, disjoint id ranges** (`code_offset`, `code_space`), all fixtures flashing simultaneously | Every frame then gives correspondences for every visible fixture *at the same instant*, so a handheld phone works: one camera pose per frame links them. Time-slicing (one fixture at a time) only works on a tripod, or needs VIO to bridge slots. The cost is about one extra code bit per doubling of the LED total (300 → 1500 LEDs: 9 → 10 frames per cycle). |
| Sync | **Shared epoch on the phone's clock**, converted per fixture with the existing TimeSync offset; firmware starts the pattern on `epoch_ms` | The decoder is unchanged: one `CvPipeline`, identity clock. Its self-clocking alignment absorbs the common offset and camera latency. Only the *inter-fixture* skew matters (§5). |
| Driving several fixtures (one TLS socket each; the app holds one at a time) | **Arm-then-film**: firmware keeps flashing after the socket closes. (a) **Bridge**: one live `group_capture` query arms all of them (the bridge holds every socket). (b) **Direct fallback**: connect → sync → start → disconnect, per fixture in turn | The capture itself needs no connection, so both paths are the same protocol and the same decode. The direct path costs about 2–3 s per fixture to arm (TLS ≈ 0.8 s on a C6 + sync + start) and the same again to stop. |
| Solver location | **TypeScript** (`web/src/geom/multiFixture.ts`), not the Rust/WASM mapping solver | The problem is small: 7·(F−1) fixture parameters after the Schur step. It reuses `geom/pnp.ts` (FUG-112). It runs in the app's live preview, in node tests and in the agent. Worst synthetic solve ≈ 0.5 s. |
| Capture parameters | The per-fixture **capture profile** (sensor stack `get_capture_profile`: diffuse, stride, timing, brightness), else the app's per-device stride + global diffuse toggle | One decoder reads every fixture, so **timing is shared**: the most conservative alphabet and the slowest bit period of the group (≥ 100 ms). Diffuse fixtures light ONE coverage phase of their stride schedule, which is plenty to register a known map. Brightness is per fixture. |
| Reference / world frame | User-chosen reference fixture = origin; **levelled by gravity** when its "up" is known (+Y of a `gravity_leveled` map, or an IMU-measured up in the map frame); otherwise its +Y is assumed up (and the result says so). If the reference already has a stored pose, the room keeps its frame and everything is re-anchored on it | Adding a fixture to an already set-up room must not move the others. |

## 3. Method

### 3.1 Observations

Dense decoded records (`CvPipeline` `denseRecords`, every 3rd frame) are grouped
by capture time into **views**. In each view, decoded id `g` maps to
(fixture k, LED i) through `groupCode.splitId`. A (view, fixture) group of
≥ 3 sightings is kept. Groups are capped at 64 sightings, a rotating subset so
every LED is used across the capture, and views at 150 (evenly spaced). Only
views showing ≥ 2 fixtures carry relative information.

### 3.2 Initialization through the co-visibility graph

1. Per (view, fixture) **PnP** against that fixture's map (gravity-up
   multi-start, warm-started frame to frame; `geom/pnp.ts`). Collinear maps are
   skipped (PnP is degenerate on a line).
2. **Anchor**: the best-observed *non-planar* fixture. A flat panel's PnP has a
   two-fold flip, and planar anchors poisoned the camera seeds in testing.
3. **Alternate until nothing changes:**
   - *Cameras* in views that show a placed fixture: PnP on the union of all
     placed fixtures' room-frame points. Seeds are each placed fixture's PnP and
     the temporally nearest placed camera, since a handheld path is smooth.
   - *The next fixture* (the one with the most sightings in placed cameras):
     - Candidates are room←k = room←cam ∘ cam←k from every view with both.
     - For PnP-less fixtures (strips), a multi-start instead: depth from apparent
       size, a yaw sweep about up, each start refined first.
     - Candidates are scored by **per-view agreement**: the number of views with
       ≥ 60 % inliers within 8 px. A few wrongly placed cameras can't veto a
       hypothesis the majority supports.
     - The winner is refined on its agreeing views. Cameras that contradict it
       outright are reset and re-placed from the union.

   This chains A–B–C–D–E when no frame sees them all.
4. Re-express everything in the **reference** frame.

### 3.3 Joint refinement (rigid poses only)

Unknowns:

- camera poses `(R_i, t_i)` for the multi-fixture views (rigid, left
  perturbation in the camera frame);
- fixture similarities `(R_k, t_k, s_k)` for every non-reference fixture.

The reference fixture and all maps are held fixed. The residual is the pixel
reprojection of each sighted LED:

    r = π(R_i (s_k R_k X_kl + t_k) + t_i) − (u, v)

The robust cost is Huber (δ = 2 px), minimized by Levenberg–Marquardt with
IRLS weights. Cameras are eliminated by a **Schur complement**: each camera's
6×6 block is inverted, and the reduced system is only 7·(F−1) wide (≤ 28 for
five fixtures). Then comes an **outlier gate**: per sighting at
max(6 px, 4·1.48·median), and per (view, fixture) group (< 50 % inliers drops
the group, i.e. a wrong camera branch for that fixture in that frame). Then a
re-solve, up to three passes.

Priors:

- **Scale**: `ln s_k ~ N(0, σ_k²)`, with σ_k the map's `scale_rel_std_err`,
  default 5 %. "fixed" (s = 1) and "free" are options.
- **Gravity tilt**: `‖R_k u_k − U‖ / σ_tilt` with σ_tilt = 5°, for fixtures
  whose map up `u_k` is known; `U` is the reference's up. It is weak against
  hundreds of pixel residuals, but it pins a horizontal strip's roll.
- Leveling at the end rotates `U` onto +Y.

### 3.4 Scale observability

From a single view, a fixture twice as large and twice as far looks the same.
Relative scale comes from **camera translation**: the camera centres expressed
in each fixture's frame must agree up to the similarity. With a tripod
(rotation only) the prior holds the scale and the result says so ("relative
scale not observable from this capture"). With 1–1.5 m of handheld travel at
2–3 m, a 6 % scale error was recovered to < 1 % in the synthetic tests.

### 3.5 Quality metrics

Per fixture:

- status: reference / localized / weak / unlocalized;
- frames used, frames shared with another placed fixture, inlier count and
  reprojection RMS;
- **1-σ uncertainties** of rotation, translation, scale, and the RMS over the
  fixture's LEDs of the predicted room-position σ (`sigma.ledM`, the number the
  UI shows);
- tilt from its map's level.

The covariance is **cluster-robust by LED**: a sandwich `S⁻¹ M S⁻¹`, with the
cameras profiled out, scores summed per (fixture, LED), and prior information
added.

The dominant error is each map's own per-LED error. It is the *same* in every
frame, so treating sightings as independent was 4–15× over-confident (and
inflating by views-per-LED was 10× under-confident). Clustering charges each
LED's frames as one correlated unit. On the synthetic sweep, error/σ has median
1.1 and 95th percentile 1.8.

Warnings (all surfaced in the UI and the bundle):

- never decoded;
- never co-visible with a placed fixture (→ unlocalized);
- fewer than 3 shared frames;
- position σ > 5 cm, or orientation σ > 5°;
- map scale differs from the reference's by > max(3 %, 3σ): "consider
  re-mapping";
- scale not observable;
- tilted > 10° from its map's level: "moved since mapping?";
- a **straight strip filmed only from within its own plane** (camera centres
  and the line span ≤ 20° of planes: its depth is barely constrained; "move the
  phone up and down");
- high reprojection error (stale map);
- reference without gravity.

## 4. Protocol + firmware (`group_capture`)

Proto fields were chosen clear of every open branch: the sensor stack uses
client 55/56 → server 30 and the ramps use client 60–62 / server 40. These are
additions to existing messages, not new arms.

```
StartMappingOptions {
  ...
  optional int32  code_offset = 8;   // LED i transmits id i + code_offset
  optional int32  code_space  = 9;   // shared code-book size (>= offset + led_count)
  optional double epoch_ms    = 10;  // pattern epoch in THIS player's clock
}
CodeParams { ...; optional int32 code_offset = 13; }  // echo; led_count = code space
```

Firmware (`firmware/player/src/lib.rs`, feature `"group_capture"`):

- `ActiveCapture` separates the physical `led_count` (what the frame loop
  drives) from the code-book `spec` (derived from `code_space`). `pattern_color`
  shows `color_for_frame(led + code_offset)`, and stride masking stays on the
  physical index.
- `epoch_ms` must be within ±10 min of the player clock (it catches a client
  clock bug). A past epoch simply phase-aligns the running pattern; the frame
  loop already clamps a future one.
- `configure` keeps the group layout. `code_space` ≤ 4096 (13 data bits +
  SEC-DED).
- The pattern keeps running after the client disconnects. That was already
  true; now it's documented and relied on. `stop_mapping` ends it.
- Unset fields leave single-fixture capture unchanged (tested).

Bridge (`agent/src/bridge/live.ts`): live query `group_capture`:

- `prepare` (map, features, LED count, pose, capture profile per player);
- `start` (`members: [{to, options}]`): it picks `hub_epoch = now − lead`,
  converts it per player with a fresh 8-round LAN clock sync, and returns
  `hub_epoch_ms` + `hub_now_ms` plus per-player code params and skew bound;
- `stop`;
- `set_pose` (stores in the hub config and on the device when it supports it).

The bridge normally refuses every mapping arm at the wire (`FORBIDDEN_TYPES`:
agents must never start a capture). `group_capture` is the one scoped
exemption. `start_mapping` / `stop_mapping` may go out inside
`DeviceSession.groupCaptureScope`, which only this live query (a paired,
human-operated app) enters. No MCP tool or CLI command can.

The app maps the hub epoch to its own clock from `hub_now_ms` (error ≤ half
the app↔bridge round trip, common to every fixture, absorbed by the decoder).

## 5. Numbers

Synthetic tests are in `web/tests/multiFixture.test.ts` and
`web/tests/groupCapture.test.ts`. The scenes:

- rooms of 2–5 fixtures (helix lamps, 10×6 panels, cone "trees", rings,
  straight strips) at random positions over 1.6–5 m and random yaw;
- a handheld walk at 1.8–3 m with serpentine pans, hand jitter and roll;
- per frame: 1 px pixel noise, 15 % decode dropouts, 1 % gross outliers;
- each map given to the solver with **3 mm per-LED error** and up to **±3 %
  scale error**.

| Scenario | Result |
| --- | --- |
| 20 random rooms, 2–5 fixtures, 50 relative poses | rotation **median 0.42°, p95 1.85°**; LED position **median 13 mm, p95 33 mm**; relative scale median 0.2 %; error/σ median 1.1, p95 1.8; worst solve 0.54 s (node, one core) |
| 2 fixtures, full view | 0.2°, ~4–12 mm |
| 5 fixtures in a 6 m row, seen only pairwise (chain) | all placed; error grows with chain length (~2–5 cm at the far end); σ grows accordingly |
| Linear strip + vertical phone motion | placed, < 3 cm; without vertical motion it is flagged weak with the move-up-and-down hint |
| 6 % map scale error | recovered to < 1 %, flagged "consider re-mapping" |
| Tripod (no translation) | rotation < 1°, LEDs < 6 cm, flagged "scale not observable" |
| Never co-visible fixture / no multi-fixture frame | unlocalized with the reason; no bogus pose |
| 5 % gross outliers | gated; < 2 cm |
| End to end through `CvPipeline` (3 fixtures, 30 fps, shared code book, ±6–9 ms skew) | > 90 % of sightings correctly labelled (track swaps where helix LEDs cross), all fixtures < 3 cm |
| Inter-fixture epoch skew, 100 ms bits | decode intact to **±30 ms**, breaks by ±45 ms; LAN TimeSync error is typically < 5 ms |

What limits accuracy is **map error, not pixels**. A fixture's 3 mm per-LED
error acts like a fixed rigid-body perturbation of that fixture, seen through a
narrow range of viewing angles. It costs ~0.1–0.4° per link, times the lever arm
to the next fixture. More frames barely help; viewing-angle diversity does, and
so does putting the reference in the middle of the group.

## 6. App flow (`#/room`, Maps ▸ ⋯ ▸ Localize room…)

1. **Pick**: fixtures (through the paired bridge when it answers, else the
   known-devices list), the origin fixture, and the room name. Alternatively
   "Adjust by hand", which skips straight to 4 with the stored poses.
2. **Read**: each fixture's stored map, features, pose and capture profile.
   It blocks with the reason on: unreachable, no map, or firmware without
   `group_capture`.
3. **Capture**:
   - it arms everyone on one epoch and opens the camera;
   - per-fixture chips count frames shared with a neighbour (goal 25);
   - a guide line names who still needs filming;
   - a live 3D inset re-solves every 2.5 s, warm-started.
4. **Review**:
   - joint solve, re-anchored on the reference's stored pose if it has one;
   - per-fixture status / ±σ / px / warnings;
   - a 3D room view (orbit, pinch), and a selectable fixture with a
     nudge/rotate pad (1 cm / 5 cm / 20 cm steps, yaw ± / pitch / roll, about
     the fixture's centroid);
   - **Save poses** writes `set_fixture_pose` (commit) through the same
     transport.

## 7. Agent side

- `Hub.pose` reads device-reported poses (§1).
- `plot_fixture` with several players or a room renders them placed: that's the
  agent's view of the result.
- The skill suggests the app's room localization when two or more mapped
  fixtures need placing.
- The bridge's `group_capture` query (§4) is the app's path through a bridge.

## 8. Debug bundles (`splanc-localize-bundle`)

Debug mode only. A run that isn't fully "localized" saves a bundle
automatically; the review screen also has "Save debug bundle".

- **Envelope**: the same as the #318 mapping capture bundles (`format`,
  `version`, `id`, `createdAt`, `outcome`, `summary`, `app`, `device`,
  `capture.ledCount`, `frames`). They share the IndexedDB store and the
  Settings ▸ Debugging list with Export / Share, and the file name says
  `splanc-localize-…`.
- **Payload**: the group capture (transport, code layout, shared code params,
  per-member knobs, arm results with skew bounds, epoch); each fixture's map as
  the solver saw it, with up / scale prior / prior pose; the per-frame sightings
  (0.01 px); the options; and the result or error.
- **Replay**: `replayLocalizeBundle(bundle)` (`web/src/solver/localizeBundle.ts`).

## 9. Not verified / follow-ups

- **No hardware run.** No HITL rig camera sees two mapped DUTs at once. The
  user's PixieLamp + FugWidget are the real test, and I didn't drive them.
  Unverified on hardware:
  - the `group_capture` firmware path (host tests only);
  - real inter-fixture skew;
  - merged blobs where fixtures overlap in the image;
  - the direct path's arm time;
  - the camera screen on iOS (native source) and Android.
- Bridge path: tested against the fake player through the real relay + bridge.
  Not tested with real players.
- Capture profile: read duck-typed (`getCaptureProfile` + feature
  `capture_profile`), so it lights up when the sensor stack merges. Until then,
  the per-device stride + global diffuse toggle are used.
- The IMU "up" input is plumbed (`fixtureModel(…, imuUp)`) but nothing fills it
  yet. It needs the sensor stack's calibrated mount (gravity in the map frame).
- There is no auto-stop on the device. If the phone dies mid-capture, the
  fixtures keep flashing until something sends `stop_mapping` (or a reboot). A
  firmware `stop_after_ms` would be a small follow-up.
- A device-side automatic stride-phase rotation would let diffuse fixtures
  cover all their LEDs in one group capture. One phase is enough to localize.
