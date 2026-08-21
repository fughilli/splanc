# WORKLOG — algorithmic PnR (branch `pnr-system`)

Handoff notes and build log, newest first — read the top entry to orient, then
scan back. Full design + rationale lives in
[`docs/hardware/pnr-system.md`](../../docs/hardware/pnr-system.md); this file is
the running state so a fresh-context agent can pick up cleanly. Update it at the
end of every session.

## 2026-08-21 (night) — routability diagnosed; own detailed router kicked off (START HERE)

**Decision (Kevin):** build our **own detailed router**, SOTA-grounded and phased
like the placer — FreeRouting + naive planes can't get a dense fine-pitch board
DRC-clean. Phased plan **R1–R5** now in `docs/hardware/pnr-system.md` (§ Detailed
router). `splanc_dev.fab` correctly **fails** the `require_routed` gate until it
lands.

**Diagnosis (rigorous — union-find matched pcbnew's ratsnest exactly at 81):** of
81 unrouted, **55 (68%) are high-fanout ground/power** — `lv` ground = 75 pads /
32 unrouted — that must be **planes**. The rest is signal congestion at the dense
parts (ESP32 module, QFN, 20-pin header).

**What's built toward it (this session, validated but NOT yet DRC-clean):**

- **Planes**: `net_class.plane_layer` schema; `writeback.apply_planes` pours
  **split-plane** zones (multiple rails share an inner layer, each = bbox of its
  own pads, priority-carved) + via-stitches pads to the plane; plane layers typed
  `LT_POWER` so the router keeps signals on F/B. **Proven**: planes connect the
  high-fanout nets (`lv`/`p3v3` → 0 unrouted).
- **THE OPEN BUG (→ R1):** via-**in-pad** stitching shorts on 0.5 mm-pitch parts —
  **612 DRC violations**. Fix is **dog-bone fanout** (offset via + short trace,
  standard ≥0.5 mm) + proper plane antipads. That's phase **R1**.
- Constraints: `splanc_dev` planes = In1 solid `lv` ground, In2 split
  {p3v3,p5v,vsys,vbat,hv}. Connector grounds stay traces.

**Config note:** typing In1/In2 as power (clean planes) forces signals onto F/B
(2 layers) → 81→71 (planes fixed ~34, but 2-layer signal squeeze added back ~24).
The real answer is R1–R5 (fanout + own signal router), not more FreeRouting knobs.
`route_max_passes=0` + `require_routed` stays.

**Fast iteration:** engine tests `bazelisk … test //hardware/pnr/...` (no
atopile/FreeRouting). The `.fab` build is the slow (~10 min) integration path;
each plane experiment above cost one. Diagnosis scripts: union-find over
tracks+pads per net = pcbnew ratsnest (use it to see which nets/regions fail).

**R1 attempt + finding (next actor start here):** implemented dog-bone fanout in
`writeback._dogbone_fanout_net` (offset via + short trace, outward from footprint
centre, clearance-checked vs other-net pads/tracks via `_collect_obstacles` /
`_clear_of_obstacles`; via-in-pad only for big pads). **Result: still not
DRC-clean** — a naive outward offset leaves ~28 shorts / ~553 DRC on the dense
row fixture, because (a) the fanout **trace** itself isn't collision-routed (only
the via position is checked) and (b) via geometry (`PCB_VIA` width: `GetWidth
called without a layer argument` under DRC) needs the proper setup. **Conclusion:
R1 needs R2 first** — clean fanout requires the geometry/obstacle model + a real
(even 1-segment) router for the dog-bone trace. So the build order is
**R2 (geometry + pin access) → R1/R3 (fanout/escape on it) → R4 → R5**, not
R1 standalone. The dog-bone scaffold + obstacle framework is committed and is the
foundation; the missing piece is a collision-aware trace router (R2/R4).

**Env hazard:** `BOARD.GetTracks()` / `GetDrawings()` / `Zones()` have a **flaky
SWIG iterator** in this KiCad-9 python (`'SwigPyObject' object is not iterable`) —
usually works, sometimes not. `_collect_obstacles` wraps `GetTracks()` in
try/except (falls back to pads-only). Prefer `GetFootprints()` (reliable). Any new
pcbnew iteration should be guarded.

## 2026-08-21 (late) — correctness fixes from EE review; routability still open

An EE review of the first routed board (`splanc_dev.fab`) surfaced real defects.
Fixed three; a fourth (full routability) is now **honestly gated** but not yet met.

**Fixed:**

1. **Outline clipped parts (U5/ESP32 pads outside Edge.Cuts).** Root cause: the
   outline was framed from footprint _origins_ (atopile `board_outline.py`),
   discarding the placement's containment guarantee. Now `writeback.frame_region`
   stamps Edge.Cuts at the **placement region** `[0,W]×[0,H]` (which the placer
   keeps every courtyard inside) as text — so all pads are inside by construction.
   Dropped board_outline.py from the flow.
2. **2-vs-4 layer mismatch.** `constraints.layers` (4) now actually sets the board
   copper-layer count (`SetCopperLayerCount`) via `rules.json`; gerbers export
   In1/In2 and FreeRouting routes on all four layers (verified: F/In1/In2/B all
   used).
3. **Connector edge overhang.** New `overhang_mm` on `fixed`/`edge_align`
   (`geometry._edge_pose`) so an edge connector protrudes a set distance past the
   board edge for cable mating; `USB1` = 1.5 mm overhang. Fixed parts are excluded
   from the outside-outline check (`metrics.outside_outline(exclude=…)`) since the
   overhang is intentional. Gated by `geometry_test`.

**Routing-completeness gate (the important behavior change):** `pnr.quality`
counts unrouted ratsnest (`GetUnconnectedCount`) and the rule **fails the build**
if any net is unrouted (`require_routed`, default True); `route_max_passes=0` lets
FreeRouting run to completion. No more green build on a partial route.

**STILL OPEN — the board does not fully route.** On 4 layers, uncapped,
FreeRouting leaves **~81 connections unrouted** (44/71 nets with copper), so
`splanc_dev.fab` **correctly fails**. The place↔route loop's global-route
lookahead reports `overflow 0` (says "routable") while the detailed router can't —
i.e. the coarse 2.5 mm-gcell lookahead is too optimistic to catch the real
(pin-access / local) congestion around the dense parts (ESP32 module, QFN sensor,
20-pin header). Levers to pursue (open PnR-quality work): a bigger / less-dense
board; a **realistic** lookahead capacity so the feedback loop actually spreads
congested regions (its designed purpose — today it converges in 1 round because
overflow reads 0); channel-aware legalization; running the _detailed_ router
inside the loop; or accepting FreeRouting's limits and hand-routing the fine-pitch
parts. `route_feedback_test`'s "overflow→0" acceptance will need to soften to
"overflow decreases + terminates" if the lookahead is made pessimistic.

## 2026-08-21 (late) — Phases 4 + 5 + 6 landed: end-to-end `.fab` target

**Phase 6 — routing rules + post-route quality pass (added same session):**

- **Schema** (`constraints.py`): `net_class` (per-class trace width/clearance over
  net-name globs), `diff_pair` (p/n + skew tol), `length_match` (net group +
  tolerance). `compile_routing_rules(compiled, net_names)` expands net globs →
  a stdlib `rules.json` (the seam the pcbnew steps consume without pyyaml/torch).
- **Widths reach the router** (`writeback.apply_net_classes`): applies net classes
  to the board's `m_NetSettings` (default class + named classes via
  `SetNetclassPatternAssignment`) so FreeRouting's DSN carries per-class widths —
  power rails route wider. **Order matters:** classes must be applied _before_
  `apply_placement` (its `BuildConnectivity()` must run with the classes present,
  else they don't persist through the KiCad-9 save — verified).
- **Quality pass** (`pnr/quality.py`): reads the routed board via pcbnew
  (`GetTracks().GetLength()` + `PCB_VIA` count), and a pure `analyze()` scores
  per-net routed length, via count, **diff-pair skew**, **length-match spread** vs
  tolerance, and per-net-class length roll-up → `quality.txt` in the fab bundle.
  Advisory by default; `quality_gate = True` fails the build on a diff-pair/
  length-match miss. Gated by `quality_test` (pure).
- `pnr.bzl`: pnr_fab `--dump-rules`, writeback `--rules`, a quality step, and a
  `PnrReportsInfo` provider so the bundle collects `drc.rpt` + `quality.txt`.
- splanc_dev `constraints.yaml`: a `power` net class (rails → 0.4 mm). This board
  has no genuine diff-pair / length-match need (USB is inside the WROOM), so those
  are documented/tested/fixture-only, not forced onto the shipped board.

**Watch-out:** the optional **learned routability predictor** (design §9.6) is
deliberately _not_ built — the analytical net-crossing + PathFinder signal already
converges the loop, so it isn't limiting. Revisit only if a future board needs it.

## 2026-08-21 (late) — Phases 4 + 5 landed: end-to-end `.fab` target

**State:** the design's remaining phases are integrated and the end-to-end target
is **verified building a real board**. One target runs the whole multi-turn
optimize→route→export flow:

    bazel build //hardware/splanc_dev:splanc_dev.fab        # routed board + Gerber/drill/BOM/pick-place
    bazel build //hardware/splanc_dev:splanc_dev.fab.board  # just the routed .kicad_pcb + DRC report

**Verified end-to-end (2026-08-21):** `splanc_dev.fab` **built clean**. The loop
reported `place<->route 1 round: overflow 0, converged; placement 60x50 mm, HPWL
15832 -> 1849 mm (88% shorter), 61 parts rotated, legal`; FreeRouting then laid
**1004 tracks + 80 vias** over the 79-footprint board, and the bundle came out
with the full Gerber set (F_Cu/B_Cu/mask/paste/silk/Edge.Cuts), drill (.drl),
`pick-place.csv`, and `bom.csv`. Engine suite (`//hardware/pnr/...`) is 9/9
green.

**Phase 4 — routing + place↔route feedback (`pnr/route/`):**

- `steiner.py` — RMST net decomposition (a light FLUTE stand-in).
- `global_route.py` — coarse **gcell** global router with **PathFinder** negotiated
  congestion: per-edge capacity = signal-layers × tracks/gcell; each 2-pin segment
  routed as the cheaper monotone **L**; cost `c=(1+h)·p` with present-sharing `p`
  and accumulated history `h`. Objective = total **overflow**; returns per-gcell
  overflow + history maps.
- `feedback.py` — the loop (design §6): place → global route → if overflow>0,
  accumulate congestion into a persistent history map, turn it into per-part
  **RePlAce inflation** (grow congested parts' spreading footprint), re-place;
  converge when overflow→0. Round cap + no-improvement guard.
- Threaded an `inflation` dict through `place()` / `global_place()` / `legalize()`.
- Tests: `route_test` (primitives — Steiner tree, capacity/overflow, PathFinder
  history, inflation derivation) + `route_feedback_test` (acceptance §9.4: on
  `splanc_dev` overflow reaches **0**, loop **terminates**, overflow
  **non-increasing**, placement stays legal, deterministic). Both green.

**Phase 5 — writeback + detailed route + DRC + fab (`pnr/writeback.py`, `pnr.bzl`):**

- `writeback.py` — inverse of ingest: place each footprint (pose/orientation/side)
  via pcbnew, **clear stale preview tracks**, save. Outline framing is delegated to
  the proven text-based `board_outline.py` (tight Edge.Cuts + page around the new
  placement) because `BOARD.GetDrawings()` has a broken SWIG iterator in this KiCad
  9 python under Bazel (`GetTracks`/`GetFootprints` are fine). Since pcbnew's
  `SaveBoard` reformats gr_lines into nested `(stroke …)` that `board_outline.py`'s
  single-level regex can't strip, `writeback.strip_edge_cuts` (a paren-matched text
  pass) removes all Edge.Cuts first so the framer adds exactly one outline. Pure
  `to_pcb_nm` + `strip_edge_cuts` are unit-tested; a pcbnew-gated live test checks
  the round-trip. `writeback_test` green.
- `pnr.bzl` — `atopile_pnr` macro → a `_pnr_board` rule that orchestrates the two
  interpreters in one action (ingest+writeback+FreeRouting under `@kicad_python`
  with a _scoped_ PYTHONPATH; place+route under the hermetic torch `pnr_fab`
  py_binary via `files_to_run`), runs DRC (report by default, `drc_gate=True` to
  fail on violations), and re-provides `AtopileLayoutInfo`; a `_pnr_fab` rule then
  runs the existing `kicad-cli` exporters into one vendor bundle dir.
- Wired `//hardware/splanc_dev:splanc_dev.fab` with `constraints.yaml`.

**Guidance-input docs (Kevin's ask):** new `docs/hardware/pnr-inputs.md` — the full
`constraints.yaml` reference (board size/layers/clearance, fixed/edge_align/
keepout/side_pref/group, hard-vs-soft, frame/units, how each steers placement, a
worked splanc_dev example). `hardware/README.md` updated with the two layout paths;
design doc §9 marks Phases 4–5 done.

**Watch-outs for the next actor:**

- The `.fab` build is **non-hermetic + slow**: it rebuilds atopile (nix, venvHash
  can drift — see `hardware/README.md`) and runs FreeRouting (minutes; capped at
  `route_max_passes=6`). The unit/acceptance tests (`bazel test //hardware/pnr/…`)
  cover the engine without any of that and are the fast feedback loop.
- **Frame/orientation fidelity:** ingest records pad offsets in the footprint's
  y-down local frame while the engine works y-up, so the placer's _estimate_ of a
  rotated pin's landing is mirror-approximate; courtyard legality (w/h swap) is
  exact, so this affects HPWL fidelity only, not DRC. A true y-consistent pad
  frame is a clean follow-up.
- **DRC gate is off by default** (report-only) so the target reliably produces
  outputs; flip `drc_gate=True` once FreeRouting reliably clears the real board.
- **Cosmetic:** `board_outline.py` draws the Edge.Cuts as 4 separate `gr_line`
  segments, so kicad-cli prints "non-closed outline" warnings during export
  (harmless — the Edge.Cuts gerber is still produced). Drawing a single closed
  `gr_rect`/`gr_poly` would silence them; a small follow-up.
- Phase 6 (diff-pair/length-match, learned routability predictor) is untouched.

## 2026-08-21 (night) — Phase 3 orientation landed

**State:** Phase 3 (orientation) is done and green. The placer now co-optimizes a
90° rotation per movable part. Next actor starts **Phase 4 — routing + place↔route
feedback** (`docs/hardware/pnr-system.md` §9.4).

**What's new (`pnr/place/model.py`):** each movable part carries a categorical
over {0,90,180,270}, relaxed to a temperature-annealed softmax (deterministic
Concrete/Gumbel-Softmax, Cypress §9.3). Pin offsets and courtyard extents become
the _expected_ offset/extent under that distribution (so orientation is
differentiable and co-optimized with position); at the end we snap to the arg-max
angle. Fixed parts keep their constrained angle. `place(orient=True)` is the
default; `orient=False` recovers the Phase 2 position-only placement.

- **Result on `splanc_dev`:** legal, **HPWL 2023 → 1836 mm** (orientation on vs
  off; **88% below** the ato row), **61 parts rotated**, deterministic.
  `orientation_test` gates legal-discrete-angles + not-worse-than-Phase-2 HPWL +
  determinism (design §9.3 acceptance). Full suite: **6/6 green**.
- **Reproducibility:** `model.py` sets `torch.set_num_threads(1)` at import so
  float reductions don't vary with thread scheduling — needed for the
  deterministic-placement guarantee (and the `test_deterministic` gates).

**Watch-out for the next actor:** `place()` defaults to `orient=True`; the Phase 2
`placement_test` deliberately passes `orient=False` for position-only semantics —
keep any determinism comparison on the _same_ `orient` value (a mismatch there is
not a nondeterminism bug).

**Next up — Phase 4 (design §9.4):** FLUTE+FastRoute lookahead global route over
the placed board; overflow → RePlAce-style region inflation with a PathFinder
history term; converge the place↔route loop. Acceptance `route_feedback_test`:
global-route overflow reaches 0 within a pass cap and the loop terminates (no
oscillation). Build it over the placed `BoardGraph` (pins are already available
via `pnr.place.geometry.pin_positions`).

## 2026-08-21 (evening) — Phase 2 placement MVP landed

**State:** Phase 2 is done and green. The placer reflows the atopile row into a
legal, compact layout.

**What exists now (`hardware/pnr/pnr/place/`):**

- `model.py` — differentiable **global placement** (torch, CPU, seeded): loss =
  log-sum-exp wirelength + pairwise spreading + outline containment + soft
  edge-align + soft grouping + keep-out penalty. Adam. Fixed parts held as
  anchors (still pull the wirelength).
- `legalize.py` — **grid nearest-free-fit legalizer** (numpy): rasterize the
  outline, block fixed courtyards + keep-outs, place movable parts biggest-first
  into the free slot nearest their continuous target. Disjoint blocks sized
  `ceil((courtyard+clearance)/g)` ⇒ **0 overlaps + in-outline by construction**.
- `geometry.py` (pure: Rect, courtyard, pin positions, edge-pose + keep-out
  resolution), `metrics.py` (pure: HPWL, overlap pairs, hard-violation checks),
  `placer.py` (`place()` orchestrator + `PlacementReport`), `__main__.py` (CLI).
- **Result on `splanc_dev`:** legal (0 overlaps / 0 outside / 0 fixed-off / 0
  keep-out), **HPWL 15832 → 2023 mm (87% shorter)** than the ato row, and
  deterministic. `placement_test` gates all of this (design §9.2 acceptance).
  Run it: `bazelisk … run //hardware/pnr:place -- <graph.json> <constraints.yaml>
--dump-svg placed.svg`.

**Data fix along the way:** the atomic EasyEDA footprints carry **no courtyard
layer**, so `ingest.py` had been falling back to the graphical bbox _including
silkscreen + reference text_ — inflating every part ~5× (a 0402 read as 4.1×5.1
mm; total 3580 mm²). Fixed to use the text-excluded `GetBoundingBox(False)` (0402
→ 1.9×1.2 mm; total 1490 mm²); regenerated the frozen `graph.json` (counts
unchanged). Bumped the fixture outline to 60×50 mm and fixed U5 (RF module) at the
north edge so its antenna keep-out is well-defined.

**MVP simplifications (Phase 3+ material, tracked):** no orientation search
(angles kept as ingested); **single-sided** legalization — `side_pref` compiles
to a soft term but parts stay top for now; keep-out supports rel-to-a-fixed-part
and absolute polygon (rel-to-a-movable-part would need the two-tier loop).

**Next up — Phase 3 (design §9.3):** Gumbel-Softmax bilevel **orientation**
(rotate pin offsets by a relaxed rotation class) + hMETIS **partition seed** for
initial clustering. Acceptance: orientations settle to legal discrete angles and
HPWL improves vs. Phase 2 on both fixtures. Then Phase 4 (routing + feedback).

## 2026-08-21 (pm) — Task 0 + Phase 1 landed

**State:** Task 0 and Phase 1 are done and green under Bazel. The engine now
ingests a resolved board into a neutral graph and compiles the constraint file;
next actor starts **Phase 2 — placement MVP** (`docs/hardware/pnr-system.md` §9).

**What exists now (`hardware/pnr/`):**

- `pnr/graph.py` — the internal `BoardGraph` (design §2 contract): components,
  pads, nets, outline. **stdlib-only** on purpose — it is the JSON seam between
  the two interpreters (KiCad `pcbnew` for ingest, hermetic rules_python for
  torch), which never share a process. JSON round-trips.
- `pnr/ingest.py` — `pcbnew` → `BoardGraph` (mm, y-up, bottom-left origin), plus
  a pure `dump_svg` ratsnest renderer that needs no KiCad. `pcbnew` is imported
  **lazily** (only under `@kicad_python`); the module imports fine without it.
- `pnr/constraints.py` — `constraints.yaml` (§3) → hard **barriers** / soft
  **penalty** terms, globs expanded against the netlist, unknown refs → warnings.
  Front end only (no torch math yet).
- `testdata/splanc_dev/` — the frozen fixture: `splanc_dev.kicad_pcb` (built
  board), `graph.json` (its ingested graph: **79 components, 71 nets, 338 pads**),
  and a hand-written `constraints.yaml`.
- Tests (all green — `bazelisk … test //hardware/pnr/...`): `torch_smoke_test`
  (Task 0 gate), `graph_test`, `constraints_test`, `ingest_test`. `ingest_test`
  asserts the frozen counts + a KiCad-gated live re-extraction that matches.

**Task 0 resolutions:**

1. **torch under Bazel — done.** `torch>=2.2` + `pyyaml>=6` in `//requirements.in`,
   relocked (`torch==2.13.0`). On this repo's platforms (aarch64-linux CI/
   container + macOS arm64) the plain PyPI wheel is already CPU-only (no CUDA
   aarch64 wheels), so no `+cpu` index is needed — matches the CPU-first design.
2. **Cypress license — do NOT vendor; clean-room reimplement.** This repo is
   **AGPLv3** (see `LICENSE`). NVlabs/Cypress is NVIDIA research code, typically
   under the **NVIDIA Source Code License** (research/non-commercial) — I could
   not fetch and confirm it from the sandboxed worktree (no network). That
   license is incompatible with AGPL distribution, so the safe, unblocking
   decision is to **reimplement Cypress's math clean-room** from the ISPD-2025
   paper (LSE wirelength, per-side density, Gumbel-Softmax orientation,
   net-crossing term) rather than fork the repo. Revisit only if a human confirms
   the actual license permits reuse. Phases 2–4 don't depend on the fork either
   way — the design already treats clean-room as the fallback.

**Gotcha cleared:** building the `splanc_dev` fixture hit the known atopile
**venvHash drift** (`hardware/README.md`) again — re-pinned the aarch64-linux
hash in `patches/rules_atopile-venvhash.patch` to build the fixture once. The
fixture is frozen in `testdata/`, so the tests never rebuild atopile.

**Next up — Phase 2 (placement MVP), design §9.2:** differentiable LSE-WL +
per-side density + hard-constraint penalties (fixed/edge/keep-out), gradient
descent, Tetris legalization (no orientation search yet). Acceptance
`placement_test`: 0 courtyard overlaps, 0 hard-constraint violations, all parts
inside the outline, HPWL ≤ the ato-row baseline. The graph/constraints front end
it consumes is in place; wire the loss over `BoardGraph` + `CompiledConstraints`.

### To regenerate the fixture graph (needs the KiCad `pcbnew` python)

    bazelisk --output_base=$HOME/.cache/bazel-atopile build //hardware/splanc_dev:splanc_dev
    KP=$HOME/.cache/bazel-atopile/external/rules_nixpkgs_core~~nix_pkg~kicad_python
    PCBNEW=$(dirname $(find /nix/store -name pcbnew.py -path '*kicad-base*' | head -1))
    PYTHONPATH="$PCBNEW:hardware/pnr" "$KP/bin/python3.12" -m pnr.ingest \
      hardware/pnr/testdata/splanc_dev/splanc_dev.kicad_pcb --name splanc_dev \
      --dump-json hardware/pnr/testdata/splanc_dev/graph.json

## 2026-08-21 (am) — design doc drafted; no code yet

**State:** design/strategy is done; **no PnR code exists**. Next actor starts at
Task 0 → Phase 1 in `docs/hardware/pnr-system.md` §9/§11.

- **What exists:** the design doc (problem space, cited SOTA survey, architecture,
  phased plan with acceptance tests, handoff/bootstrapping). The two boards
  (`//hardware/splanc_dev`, `//hardware/splanc_eol_tester`) build a resolved
  `.kicad_pcb` (row placement + ratsnest) — the ingestion input for this system.
- **What does NOT exist:** `hardware/pnr/` code (only this WORKLOG), the
  `constraints.yaml` fixtures, the `atopile_pnr` / `<board>.fab` rule.
- **Chosen architecture (don't re-litigate — see doc):** differentiable
  graph-relaxation placement (DREAMPlace/**Cypress**-style: LSE wirelength +
  per-side density + net-crossing routability, Gumbel-Softmax orientation) →
  FastRoute/FLUTE lookahead global route → place↔route feedback made convergent
  with a **PathFinder-style history term** (region inflation à la RePlAce) →
  FreeRouting detailed route → DRC → fab export via the existing kicad-cli
  exporters. Python + PyTorch (CPU-first). No RL / no learned router.

**Blockers to clear first (Task 0, doc §9/§11):**

1. **Cypress license** — confirm NVlabs/Cypress permits vendoring/forking as our
   placement base; if not, plan a clean-room reimpl of its math. Record the
   verdict here.
2. **PyTorch under Bazel** — add `torch` (CPU wheel) to `//requirements.in`,
   `bazel run //:requirements.update`, prove `import torch` in
   `//hardware/pnr:torch_smoke_test`. Record any wheel/platform gotchas here.

**First vertical slice (Phase 1):** `hardware/pnr/pnr/ingest.py` loads a fixture
`.kicad_pcb` via pcbnew (the `@kicad_python` interpreter, see `//hardware/atopile`)
and prints component/net/pad counts + `--dump-svg`; `constraints.py` parses the
example `constraints.yaml`. Green `ingest_test`.

**Environment reminders (full list in doc §11):** build with
`bazelisk --output_base=$HOME/.cache/bazel-atopile build //hardware/...` (the
`/workspace` mount is macOS-synced); pip = root `requirements.in` + `@pypi`;
prek hooks can abort commits (re-add + re-commit); don't push from the container.
