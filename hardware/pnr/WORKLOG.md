# WORKLOG — algorithmic PnR (branch `pnr-system`)

Handoff notes and build log, newest first — read the top entry to orient, then
scan back. Full design + rationale lives in
[`docs/hardware/pnr-system.md`](../../docs/hardware/pnr-system.md); this file is
the running state so a fresh-context agent can pick up cleanly. Update it at the
end of every session.

## 2026-08-21 (night) — Phase 3 orientation landed (START HERE)

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

```bash
bazelisk --output_base=$HOME/.cache/bazel-atopile build //hardware/splanc_dev:splanc_dev
KP=$HOME/.cache/bazel-atopile/external/rules_nixpkgs_core~~nix_pkg~kicad_python
PCBNEW=$(dirname $(find /nix/store -name pcbnew.py -path '*kicad-base*' | head -1))
PYTHONPATH="$PCBNEW:hardware/pnr" "$KP/bin/python3.12" -m pnr.ingest \
  hardware/pnr/testdata/splanc_dev/splanc_dev.kicad_pcb --name splanc_dev \
  --dump-json hardware/pnr/testdata/splanc_dev/graph.json
```

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
