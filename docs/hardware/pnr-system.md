# Algorithmic Place-and-Route for PCBs — problem space, prior art, and design sketch

**Status:** draft / design exploration. **Owner:** FUG-131 follow-on.
**Goal:** a single build target that takes a circuit (netlist) plus a set of
spatial constraints and produces a **complete, DRC-clean, fabricatable PCB** and
its **manufacturing files** (Gerbers, drill, BOM, pick-and-place) — no human in
the layout loop.

This document defines the problem, surveys the state of the art (traditional and
neural), and sketches an implementation. It is deliberately opinionated about
what to build vs. borrow; the reference list at the end is the primary-source
backing for each claim.

---

## 1. Goal and scope

Today (see [`hardware/README.md`](../../hardware/README.md)) each board is an
`atopile_project` target whose `.pdf`/`.gerber` come from `ato` auto-placing
parts in a naive row and a bounded FreeRouting pass. That is a **preview**, not a
layout: no real placement, spaghetti routing, no design-rule guarantee.

The target end state:

```text
bazel build //hardware/<board>:<board>.fab
  →  constraints + netlist
  →  placement (graph relaxation)
  →  routing
  →  routing-guided re-placement  ⟲  re-routing   (until converged)
  →  DRC-clean .kicad_pcb
  →  Gerbers + Excellon drill + BOM + pick-and-place  (vendor-ready)
```

Requirements that shape every decision below:

- **Autonomous & reproducible.** It runs under Bazel as one hermetic-ish target.
  Same inputs → same board (modulo a fixed RNG seed). This rules out
  cloud-only/opaque services and argues for deterministic or seedable solvers.
- **Constraint-first.** The value is honoring _mechanical/electrical intent_
  (connectors on an edge, an antenna keep-out, a button reachable from the
  enclosure), not just minimizing wirelength.
- **PCB, not ASIC.** Few layers (2–4), large heterogeneous rotatable parts,
  two-sided placement, connectors on the board edge, real design rules
  (clearance, annular ring, min trace/space), differential pairs and
  length-matching. Most academic PnR is ASIC-centric and must be adapted.
- **Incremental adoption.** It should slot into the existing atopile flow: the
  netlist and footprints already come from `ato`; the output is the `.kicad_pcb`
  that the existing `.gerber`/`.pdf`/BOM exporters consume.

## 2. Problem statement

### Inputs

- **Netlist + footprints.** From atopile: components (each with a footprint =
  pad geometry, courtyard, side-agnostic outline), and nets (pin-to-pin
  connectivity). We already resolve these into a `.kicad_pcb` with unplaced/row
  footprints and a ratsnest; that is a usable ingestion point.
- **Spatial constraints** (the crux — see §3): connector/button/antenna
  positions and **orientations**, board-edge alignments, approximate board
  **outline/dimensions**, **top/bottom** side assignment or preference,
  keep-outs (antenna clearance, mounting holes), and grouping hints.
- **Design rules:** clearance, trace width per net class, via geometry, layer
  count, controlled-impedance / diff-pair rules.

**Outputs:** a placed + routed `.kicad_pcb` that passes DRC, plus fab files.

**Objective (informal):** honor all hard constraints; minimize a weighted sum of
routed wirelength, via count, and routing congestion/crossings; keep the board
within the target outline. This is a **constrained, mixed continuous/discrete,
non-convex** optimization — position ∈ ℝ², orientation ∈ discrete rotations,
side ∈ {top, bottom}, plus a routing sub-problem that is itself NP-hard.

**Why the loop.** Placement quality can only be _truly_ judged after routing
(a placement that looks compact can be unroutable), but routing depends on
placement. The classic resolution is to **estimate** routability during
placement and **periodically ground-truth** it with a fast router, feeding the
result back — a damped fixed-point iteration, not a one-shot hand-off. §6 makes
this precise.

### Ingestion contract (v0)

The bridge into the engine is the resolved `.kicad_pcb` that
`atopile_layout` already emits (footprints placed in a row, ratsnest, no
tracks), read via KiCad's **`pcbnew` Python API** — the same interpreter the
autoroute step already uses (`@kicad_python`, see `//hardware/atopile`). This
avoids parsing the s-expr by hand and gives us a write-back path. Extract into an
internal graph with exactly these fields (all present in a built board — verified
against `splanc_dev.kicad_pcb`):

| Internal field | pcbnew source                                                             | Notes                                 |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| component id   | `fp.GetReference()`                                                       | e.g. `U1`, `J3`, `SW2`                |
| footprint id   | `fp.GetFPIDAsString()`                                                    | `Lib:Name` (pad geometry key)         |
| position       | `fp.GetPosition()` (nm → mm)                                              | initial (row) placement; we overwrite |
| orientation    | `fp.GetOrientationDegrees()`                                              | 0/90/180/270 (or finer)               |
| side           | `fp.GetLayer()` → `F.Cu`/`B.Cu`                                           | top/bottom                            |
| courtyard/bbox | `fp.GetCourtyard(layer)` / `fp.GetBoundingBox()`                          | overlap/density geometry              |
| pads           | `fp.Pads()` → `pad.GetPadName()`, `pad.GetPosition()`, `pad.GetNetname()` | pin→net binding + pin offset          |
| nets           | `board.GetNetsByName()` / `pad.GetNetCode()`                              | net graph (drop net 0 / unconnected)  |
| board outline  | `Edge.Cuts` drawings, or the constraint file `board.outline`              | placement region                      |

**Write-back:** after PnR, set `fp.SetPosition/SetOrientationDegrees/SetLayer`
(flip via `fp.Flip()` for side changes), add the routed tracks/vias
(`PCB_TRACK`/`PCB_VIA`), then `pcbnew.SaveBoard()` — yielding the same
`.kicad_pcb` the existing `.gerber`/BOM/`.pdf` exporters consume. **The engine
never emits Gerbers directly**; it only produces the placed+routed board and lets
the existing hermetic `kicad-cli` exporters do the fab files. A tiny
`pcbnew`-based `ingest.py`/`writeback.py` is the first code to write (Phase 1).

## 3. Constraint model

The user-facing constraint language is the differentiator. A first cut:

| Constraint                                       | Representation                                 | Enforcement in the optimizer                                                   |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Fixed placement (connector at (x,y,θ) on edge)   | anchor pose, `locked=true`                     | held constant; contributes to net forces but not to the position gradient      |
| Board-edge alignment                             | component edge ↔ board-outline edge           | attractor/penalty pulling the part to the edge; orientation snapped            |
| Orientation constraint / preference              | discrete rotation set (0/90/180/270 or fine)   | **Gumbel-Softmax** relaxation of the rotation class → differentiable (Cypress) |
| Top/bottom side                                  | discrete side var, or fixed                    | **per-side density maps**; side either fixed or a learned discrete variable    |
| Keep-out / antenna clearance                     | polygon region, no copper/parts                | hard penalty (barrier) in placement + a routing blockage                       |
| Approximate board dimensions                     | soft outline bbox                              | density defined over the outline; penalty for parts outside                    |
| Grouping (power stage, decoupling near IC)       | soft attractor between members; partition seed | net-weight boost + partition-based initial clustering                          |
| Net class (power width, diff pair, length match) | per-net rules                                  | routing-time constraints; length-match as a post-route tuning pass             |

Design principle: **hard constraints as feasibility barriers, soft intent as
penalty gradients**, so the same relaxation engine handles both. Constraints
should be expressible in the `.ato` (or a sidecar YAML) and compiled into this
model.

### Concrete constraint file (v0)

Start with a **sidecar YAML** next to the board (`elec/constraints.yaml`), keyed
by component reference — no `.ato` language changes needed for the MVP. Coordinate
frame: mm, origin at board-outline bottom-left, `rot` CCW degrees. A worked
example for `splanc_dev` (real refs: `usbc` Type-C, the two user buttons, the
ESP32-C6-WROOM module with its integrated antenna):

```yaml
board:
  outline: { w: 40, h: 30 } # approx; the placer frames the real Edge.Cuts
  layers: 2
  default_clearance_mm: 0.2

fixed: # hard: locked pose (held out of the position gradient)
  usbc: { edge: south, align: center, rot: 0, side: top } # Type-C overhangs the south edge

edge_align: # soft: pull to a board edge, snap orientation
  SW1: { edge: north, side: top } # user button, enclosure-accessible
  SW2: { edge: north, side: top }

keepout: # hard: no parts/copper in region (poly or rel-to-component)
  - { name: esp32_antenna, ref: U1, extent: { edge: west, depth_mm: 8 } }

side_pref: # soft: bias to a side (top = user-facing)
  bottom: [C*, R*] # decouplers/passives to the back

group: # soft: attract members together, near an anchor
  - { members: [U3, L1, C_boost*], anchor: U3, radius_mm: 6 } # boost stage
```

Parser contract: unknown refs → warning (not error); globs (`C*`) expand against
the netlist; every constraint compiles to either a **barrier** (hard) or a
**weighted penalty term** (soft) in the placement loss (§4). Keep the schema
versioned (`v0`) — it will grow (diff-pair classes, thermal, mounting holes).

## 4. State of the art — placement

The modern analytical formulation _is_ graph relaxation: minimize
`L(x) = WL(x) + λ·D(x)` where `WL` is wirelength (springs pulling connected
parts together) and `D` is a density/overlap penalty (parts repel). Relax by
gradient descent, then legalize.

- **Quadratic / force-directed** — the cheapest, most intuitive form. Wirelength
  as spring energy gives a sparse SPD system `Qx = b`; **Kraftwerk2**
  (Spindler et al., TCAD 2008) contributes the **Bound2Bound** net model
  (HPWL-consistent) and a Poisson-based spreading force. Direct spring-embedder
  intuition; easy to prototype.
- **Electrostatics-based (ePlace / RePlAce)** — current ASIC SOTA. **ePlace**
  (Lu et al., TODAES 2015) models cells as charges, the density penalty as the
  potential energy of an electrostatic system (`eDensity`), coupled via
  **Poisson's equation solved by FFT**, minimized with **Nesterov's method**
  (closed-form step length, no line search). **RePlAce** (Cheng et al.,
  TCAD 2019) adds routability. This is OpenROAD's `gpl`.
- **GPU differentiable placement (DREAMPlace)** (Lin et al., DAC 2019, best
  paper) — the key reframing: **global placement ≡ training a neural network.**
  Smooth **log-sum-exp (weighted-average) HPWL** + electrostatic density are
  differentiable tensor ops in PyTorch with custom CUDA; backprop + an ML
  optimizer, **~40× faster than RePlAce, no quality loss.** This — _not_ RL — is
  the real ML advance and the template to copy.
- **PCB-specific: Cypress** (Zhang et al., **ISPD 2025 best paper**, open source
  at NVlabs/Cypress) — DREAMPlace-derived, built for PCBs. Loss
  `L = WL + λ_D·D + λ_NC·NC` with: **orientation-aware** LSE wirelength (pins
  rotated by θ, orientation relaxed via **Gumbel-Softmax**, solved by a
  **bilevel** alternation of positions vs. rotation probabilities); **per-side
  density maps** for two-sided boards; a differentiable **net-crossing (NC)**
  routability term (smooth Bézier-intersection bells) — and it explicitly shows
  **RUDY is a poor routability proxy for PCBs** (non-grid, few-layer). Reports
  1–5.9× routability and up to 492× speedup vs. tools; scales to 10k+ parts.
  **This is the closest prior art to what we want and the recommended base.**
- **PCB-specific: constraint-aware hybrid** (Tsou et al., NTU, DAC 2024 LBR) —
  SA pad-alignment + force-directed global placement anchored by power-flow +
  window legalization; reports **>50% better routability than Cypress** on real
  boards. Strong evidence that an **analytical core + annealed/discrete
  refinement + routing feedback** (exactly our intended architecture) beats pure
  GPU-analytical on constrained PCBs.
- **Simulated annealing** (**TimberWolf**, Sechen 1985; **VPR**, Betz/Rose) —
  move = displace/swap/flip a part; accept worsening with `exp(−ΔC/T)`. Still
  **wins in our regime**: hundreds–few-thousand parts with hard discrete
  constraints. Use as a legalization/discrete-refinement stage around the
  analytical step.
- **Partitioning** (**Fiduccia–Mattheyses** 1982; **hMETIS** multilevel) — not
  competitive as a placer anymore, but useful to **pre-cluster** functional
  groups and seed initial positions/regions before relaxation.

**Wirelength & congestion models:** optimize the smooth **LSE/weighted-average**
HPWL (differentiable), report true **HPWL**, evaluate routed length with
**FLUTE** RSMTs (Chu/Wong, TCAD 2008). For routability drive with Cypress's
**net-crossing** term, _not_ RUDY, and/or real router feedback (§6).

## 5. State of the art — routing

- **Global routing** on a coarse gcell grid with per-edge **capacity/demand**;
  overflow is the objective. Primitives: **maze (Lee)** / **A\*** for shortest
  paths, **pattern routing** (L/Z/3-bend) for speed, **FLUTE** Steiner
  decomposition for multi-pin nets, and **FastRoute 4.0** (Pan/Xu/Chu) — Steiner
  - edge-shifting + monotonic/multi-source maze + **virtual capacity** + layer
    assignment — fast enough to run **inside** the placement loop as a lookahead
    router.
- **Negotiation-based rip-up & reroute — PathFinder** (McMurchie/Ebeling,
  FPGA'95). Node cost `c(n) = (b(n) + h(n))·p(n)`: base `b`, **present-sharing**
  `p` (grows with current overuse), **historical congestion** `h` (accumulates
  every iteration a node stays over-capacity and _never forgets_). Rip up and
  reroute all nets each pass with Dijkstra on the current cost; raise `p` and add
  to `h` on overused nodes. Nets first share cheaply, then "negotiate" away only
  when another net needs a resource more. **This is the canonical
  soft-constraint-that-hardens mechanism** and the core idea we reuse to make the
  place↔route feedback monotone (see §6). FreeRouting, VPR, and commercial FPGA
  routers are all PathFinder-based.
- **Detailed routing — TritonRoute** (Kahng et al., OpenROAD `drt`): pin-access
  analysis → track assignment → DRC-driven search-and-repair on a real geometric
  DB. The architecture transfers to PCB; the IC design-rule set does not.
- **PCB-specific:** differential pairs, length/skew matching (serpentine tuning),
  layer/via minimization, **escape/BGA fanout** (matching / min-cost flow), and
  **topological routers** — **Toporouter** (Blake, implementing Dayan's
  rubberband thesis) and commercial **TopoR** route by _homotopy_ first, then
  embed geometry, sidestepping grid deadlock. **FreeRouting** (our current
  stopgap) is a PathFinder-style negotiated router on a 45°-capable geometric
  model: BatchFanout → BatchAutorouter → BatchOptimizer.

## 6. State of the art — the place↔route feedback loop (the heart)

Modern flows close the loop with **routability-driven placement + lookahead
global routing**:

- **RUDY** (Spindler/Johannes, DATE 2007) — a fast, router-free congestion proxy
  (each net spreads its wire demand over its bbox). Cheap and differentiable, but
  **Cypress shows it is a poor PCB model**; prefer the differentiable
  net-crossing term for the inner signal.
- **RePlAce cell-inflation loop** — run a **lookahead global route**, inflate the
  area of cells in overflowed gcells so the density force spreads them, iterate
  until congestion meets target. This is precisely "routing result guides
  placement," made continuous and convergent.

**Our loop (proposed):** a two-tier feedback, damped to a fixed point.

1. **Inner (every relaxation step):** differentiable routability gradient —
   Cypress **net-crossing** + density — so each placement step already avoids
   obvious congestion, no router in the hot path.
2. **Outer (every N steps / rounds):** run a **FastRoute-style lookahead global
   route** for ground truth. Feed back **both** current overflow **and** a
   **PathFinder-style accumulated history term** `h(region)` so a region that
   stays congested across rounds exerts _monotonically increasing_ spreading
   pressure (component inflation / anchor weight à la RePlAce), rather than a
   one-shot snapshot that oscillates.
3. **Converge** when overflow ≈ 0 and placement is stable; only then run
   **detailed routing** (FreeRouting today; a PCB-rule-aware detailed router
   later), then length-matching / diff-pair tuning, then DRC.

The PathFinder history term is what turns an oscillating place⇄route hand-off
into a damped, convergent iteration — the single most important design idea here.

## 7. State of the art — neural / ML (sober take)

- **RL placement (Google AlphaChip**, Nature 2021 + 2024 addendum) — GNN netlist
  encoder + policy net places macros sequentially, then force-directed for the
  rest. Impressive but **not leverageable for us**: it targets _macro_ placement,
  its payoff depends on **pre-training over a corpus of similar chips** (which a
  small org building novel PCBs lacks), it needs many GPUs/collectors, and its
  advantage is **disputed** (Cheng/Kahng ISPD'23 "Updated Assessment"; Markov's
  critique; rebutted by "That Chip Has Sailed," 2024). Borrow the _idea_ (GNN
  encoder, learned reward proxy), not the pipeline.
- **GNN congestion/routability predictors** (CongestionNet, RouteNet;
  **CircuitNet** dataset) — the **most transferable ML pattern**: a fast learned
  predictor scores a placement's routability before routing. But all labels are
  ASIC; we'd train our own on synthetic PCB layouts. Start with the cheap
  analytical/net-crossing signal; graduate to a small GNN only if it's limiting.
- **Differentiable placement (DREAMPlace)** — the real, mature ML-adjacent win
  (already adopted in §4). Not "AI that learns," just classical placement in an
  autodiff framework — GPU speed, gradient-based relaxation, **no training data.**
- **Learned routers / diffusion layout** — immature; no reproducible PCB
  baselines. **DeepPCB** (InstaDeep) is the one PCB-specific commercial ML PnR,
  but it is closed, cloud-only, and unvalidated (marketing, not a reference).

**Bottom line:** copy DREAMPlace's autodiff-placement trick as the relaxation
engine, add a cheap routability signal to drive the loop, route classically, and
treat RL and learned routers as inspiration, not dependencies.

## 8. Proposed architecture

```text
            ┌─────────────────────────────────────────────────────────┐
            │  ingest: atopile netlist + footprints + constraints (§3) │
            └───────────────────────────┬─────────────────────────────┘
                                        │  seed: hMETIS partition → initial poses
                                        ▼
        ┌──────────── PLACEMENT (graph relaxation) ─────────────┐
        │  differentiable L = WL(LSE) + λ_D·D(per-side)         │
        │        + λ_NC·net-crossing + Σ constraint penalties   │  ← inner routability
        │  orientation: Gumbel-Softmax (bilevel);  autodiff+GPU │
        └───────────────────────────┬──────────────────────────┘
                                     │ legalize: Tetris/Abacus per side + SA refine
                                     ▼
        ┌──────────── LOOKAHEAD GLOBAL ROUTE (FastRoute/FLUTE) ─┐
        │  overflow map + PathFinder history h(region)          │  ← outer ground truth
        └───────────────────────────┬──────────────────────────┘
             converged? ── no ──► inflate/anchor congested regions ─► re-place
                                     │ yes
                                     ▼
        ┌──────────── DETAILED ROUTE ───────────────────────────┐
        │  FreeRouting (stopgap) → PCB-rule DRT (later);         │
        │  diff-pair + length-match tuning                       │
        └───────────────────────────┬──────────────────────────┘
                                     ▼
              DRC  →  .kicad_pcb  →  Gerbers/drill/BOM/pick-place (kicad-cli)
```

**Build integration.** A new rule (e.g. `atopile_pnr` / a `<board>.fab` target)
consumes the resolved netlist from the existing `atopile_layout` step, runs the
PnR engine, and emits a placed+routed `.kicad_pcb` that the existing
`.gerber`/BOM exporters consume. The Nix toolchain already provides `kicad-cli`
plus a `pcbnew`-capable Python (see `//hardware/atopile`); the PnR engine
(PyTorch + the router) is packaged as another Bazel `py_binary` (see §11). This
replaces the autoroute "preview" with a real layout while keeping the
single-build-target UX.

**Reuse vs. build:**

| Layer                   | Recommendation                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement core          | **Fork NVlabs/Cypress** (DREAMPlace-derived, PCB-specific, orientation + per-side + net-crossing already done) — check its license before vendoring |
| Global router (in-loop) | **FLUTE + FastRoute** (OpenROAD `grt`, BSD-3) as the lookahead router                                                                               |
| Feedback                | RePlAce inflation loop + **PathFinder history** term (our glue)                                                                                     |
| Legalization / discrete | Tetris/Abacus + **SA** (VPR/TimberWolf move set)                                                                                                    |
| Detailed router         | **FreeRouting** now (GPL/JVM — keep at arm's length via DSN/SES, as today); PCB-rule DRT later                                                      |
| DB I/O + fab export     | **KiCad `pcbnew` + `kicad-cli`** (already wired)                                                                                                    |

## 9. Phased implementation plan

Each phase names a concrete **acceptance test** (a `py_test` gated on the two
fixtures below) so "done" is unambiguous and regressions are caught.

0. **Task 0 — decisions (resolve before coding, see §11).** (a) Verify the
   **Cypress license** permits vendoring/forking; if not, plan a clean-room
   reimpl of its math. (b) Land **PyTorch under Bazel** (CPU wheel via the root
   `requirements.in`) and prove `import torch` in a `py_test`. Acceptance: a
   green `//hardware/pnr:torch_smoke_test` + a one-paragraph license note in the
   WORKLOG.
1. **Ingestion + constraint schema.** `ingest.py` (pcbnew → internal graph, §2)
   and a `constraints.yaml` parser (§3) for both fixtures. Acceptance:
   `ingest_test` asserts the parsed graph for `splanc_dev` has the expected
   component/net/pad counts and that `constraints.yaml` round-trips to compiled
   penalty/barrier terms; a `--dump-svg` renders the ratsnest + constraints.
2. **Placement MVP.** Differentiable LSE-WL + per-side density + hard-constraint
   penalties (fixed/edge/keep-out), gradient descent, Tetris legalization; no
   orientation search yet. Acceptance: `placement_test` on `splanc_dev` reports
   **0 courtyard overlaps, 0 hard-constraint violations, all parts inside the
   outline**, and **HPWL ≤ the ato-row baseline** (regression-tracked number).
3. **Orientation + grouping.** Gumbel-Softmax bilevel orientation; hMETIS
   partition seed. Acceptance: orientations settle to legal discrete angles;
   HPWL improves vs. Phase 2 on both fixtures (tracked).
4. **Routing + feedback loop.** FLUTE+FastRoute lookahead; overflow→inflation
   with PathFinder history; converge. Acceptance: `route_feedback_test` shows the
   lookahead **global-route overflow reaches 0** within a pass cap, and the loop
   **terminates** (no oscillation) on both fixtures.
5. **Detailed route + DRC + fab.** FreeRouting DSN/SES on the converged
   placement; DRC gate; Gerber/drill/BOM/pick-place. Acceptance: **`bazel build
//hardware/splanc_dev:splanc_dev.fab`** yields a **DRC-clean** board and a
   complete Gerber/drill/BOM/pick-place set — the end-to-end target.
6. **Quality passes.** Diff-pair/length-match; via/length optimization;
   (optional) a learned routability predictor if the analytical signal limits us.

### Test fixtures & extraction

Use the two existing boards as regression fixtures — both already build a
resolved `.kicad_pcb`:

```bash
# Resolved board (row placement + ratsnest) — the ingestion input:
bazelisk --output_base=$HOME/.cache/bazel-atopile \
  build //hardware/splanc_dev:splanc_dev
# -> bazel-bin/hardware/splanc_dev/splanc_dev.kicad_pcb  (79 footprints, real nets)
# Same for //hardware/splanc_eol_tester:splanc_eol_tester
```

Commit a **frozen copy** of each fixture's `.kicad_pcb` + a hand-written
`constraints.yaml` under `hardware/pnr/testdata/<board>/` so tests don't depend
on rebuilding atopile. `splanc_dev` (dense, mixed power/sensor/USB) and
`splanc_eol_tester` (logic analyzer + load bank) give two distinct topologies.

## 10. Open questions & risks

- **Determinism under Bazel.** GPU + floating-point + solver nondeterminism vs.
  a "same inputs → same board" promise. Likely: fixed seeds, pinned kernels,
  accept CPU fallback for reproducible CI; treat the fab target as
  `no-sandbox`/`local` like the current atopile actions.
- **Licensing.** Cypress and OpenROAD are permissive-ish (verify Cypress);
  **FreeRouting is GPL/AGPL + JVM** — keep it as an external DSN/SES process (as
  today), not linked in.
- **Netlist fidelity from atopile.** We need clean net + footprint + pad data and
  a way to write placement/routing back. The `.kicad_pcb` + `pcbnew` API is the
  pragmatic bridge (we already use it for autoroute).
- **PCB design rules.** No open PCB-grade detailed router with a real DRC engine
  exists; FreeRouting is the near-term backend, a PCB-rule DRT is a larger build.
- **Compute.** The usable path (autodiff placement + FastRoute + classical
  detailed route) runs on one GPU or CPU with permissive OSS and **no training
  data** — deliberately avoiding the RL path's data/compute needs.
- **Convergence guarantees.** The place↔route loop can oscillate; the PathFinder
  history term and damped inflation are the mitigation, but need tuning + a
  pass/round cap.

## 11. Handoff / bootstrapping (read this first if you're picking this up)

You are starting from a **design doc, not a codebase** — no PnR code exists yet.
This section is the concrete on-ramp. Also read `hardware/pnr/WORKLOG.md`
(running log, newest-first) and the existing atopile wiring you'll build on:
`hardware/README.md` §"How the Nix toolchain is wired" and `//hardware/atopile`.

### Repo mechanics you need

- **Build in this container with a local output base** — `/workspace` is a
  macOS-synced (case-insensitive) mount, so use:
  `bazelisk --output_base=$HOME/.cache/bazel-atopile build //hardware/...`.
  (Plain `bazel build` from `/workspace` can corrupt on the synced cache.)
- **Bazel is bzlmod** (`MODULE.bazel`, Bazel 7.7.1). **Python** = `rules_python`
  3.11; pip deps are one **root lockfile**: add to `//requirements.in`, run
  `bazel run //:requirements.update`, consume via
  `load("@pypi//:requirements.bzl", "requirement")` +
  `requirement("torch")` (see `tools/sim_studio/BUILD.bazel` for the pattern).
- **Nix provides the PCB tools** already: `kicad-cli` + a `pcbnew`-capable
  python3.12 (`@kicad_python`) + `@freerouting`, bound by `//hardware/atopile`.
  Reuse that toolchain for ingest/write-back/detailed-route — don't re-fetch KiCad.
- **Hooks**: `prek` runs `buildifier`, `prettier`, `markdownlint`, `black`,
  `flake8`, etc. on commit — a hook that reformats a file **aborts** the commit;
  re-add and re-commit. Python is `black`+`flake8`+`isort` formatted.
- **Commits/branches**: work on `pnr-system`; end commit messages with the
  `Co-Authored-By` trailer; **do not push from the container** (hand the user
  the push/PR commands). No Claude-Session trailer.

### Proposed code layout

```text
hardware/pnr/
  BUILD.bazel            # py_binary(pnr), py_library, py_test targets
  WORKLOG.md             # running handoff log (seeded)
  pnr/
    ingest.py            # pcbnew .kicad_pcb -> internal graph (§2 contract)
    constraints.py       # constraints.yaml -> compiled penalty/barrier terms (§3)
    place/               # differentiable placement (torch): wirelength, density, legalize
    route/               # FLUTE/FastRoute lookahead + PathFinder feedback
    writeback.py         # graph -> .kicad_pcb (pcbnew), then hand to kicad-cli exporters
  testdata/<board>/      # frozen .kicad_pcb + constraints.yaml fixtures
```

The `<board>.fab` target is an `atopile_pnr` rule (parallel to `atopile_project`)
that runs `pnr` on the resolved board and feeds the result to the **existing**
`.gerber`/BOM/`.pdf` exporters. Land it last (Phase 5); until then drive `pnr` as
a plain `py_binary` on the committed fixtures.

### Language & dependency decisions (made — don't re-litigate)

- **Python + PyTorch** for the placement engine (matches DREAMPlace/Cypress, and
  the repo's Python tooling). **CPU wheel** first (determinism + no GPU in CI);
  keep tensor ops device-agnostic so a GPU is a later speedup, not a dependency.
- **pcbnew** (from `@kicad_python`) for all `.kicad_pcb` I/O — never hand-roll
  s-expr parsing.
- **FreeRouting** stays an **external process** via DSN/SES (GPL/JVM; already
  wired) — do not link it in.
- **FLUTE/FastRoute**: prefer OpenROAD's implementations (BSD-3). Decide in
  Phase 4 whether to vendor the C++ or reimplement the (small) FLUTE LUT in
  Python; log the choice.

### Task 0 → first vertical slice

1. **Resolve blockers (Task 0, §9):** confirm the **Cypress license** allows
   reuse (repo: NVlabs/Cypress) and land **torch** in the lockfile with a green
   `torch_smoke_test`. Record both in the WORKLOG.
2. **First slice (Phase 1):** `ingest.py` that loads
   `testdata/splanc_dev/splanc_dev.kicad_pcb` via pcbnew and prints
   component/net/pad counts + a `--dump-svg` of the ratsnest; a `constraints.py`
   that parses the example `constraints.yaml`. Green `ingest_test`. This is the
   smallest end-to-end proof the bridge works before any optimization.

Then follow §9 phase by phase; update the WORKLOG at each handoff.

## References (primary sources)

**Placement.** DREAMPlace (Lin et al., DAC 2019) —
<https://www.cerc.utexas.edu/utda/publications/C252.pdf>. ePlace (Lu et al.,
TODAES 2015) — <https://cseweb.ucsd.edu/~jlu/papers/eplace-todaes14/paper.pdf>.
RePlAce / OpenROAD `gpl` —
<https://github.com/The-OpenROAD-Project/OpenROAD/blob/master/src/gpl/README.md>.
Kraftwerk2 (Spindler et al., TCAD 2008) —
<https://courses.e-ce.uth.gr/ECE439/handouts/KRAFTWERK-2-Handouts.pdf>.
TimberWolf (Sechen, JSSC 1985) —
<https://janders.eecg.utoronto.ca/1387/readings/timberwolf.pdf>. hMETIS —
<https://users.ece.utexas.edu/~dpan/EE382V_PDA/papers/hmetis.pdf>.
**Cypress** (Zhang et al., ISPD 2025) —
<https://www.csl.cornell.edu/~zhiruz/pdfs/cypress-ispd2025.pdf>, repo
<https://github.com/NVlabs/Cypress>. PCB placement w/ complex constraints (Tsou
et al., DAC 2024) — <https://dl.acm.org/doi/10.1145/3649329.3663495>.

**Routing & feedback.** PathFinder (McMurchie/Ebeling, FPGA 1995) —
<https://dl.acm.org/doi/pdf/10.1145/201310.201328>. FLUTE (Chu/Wong, TCAD 2008)
— <https://home.engineering.iastate.edu/~cnchu/pubs/j29.pdf>. FastRoute 4.0 —
<https://home.engineering.iastate.edu/~cnchu/pubs/c52.pdf>. TritonRoute —
<https://openroad.readthedocs.io/en/latest/main/src/drt/README.html>. RUDY
(Spindler/Johannes, DATE 2007) —
<https://past.date-conference.com/proceedings-archive/2007/DATE07/PDFFILES/08.7_1.PDF>.
FreeRouting — <https://github.com/freerouting/freerouting>,
<https://deepwiki.com/freerouting/freerouting>. Toporouter (Dayan rubberband) —
<https://github.com/bert/pcb/wiki/Autorouters:-gEDA-pcb-Toporouter>. OpenROAD
flow — <https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts>.

**Neural / ML.** AlphaChip (Nature 2021; 2024 addendum
<https://www.nature.com/articles/s41586-024-08032-5>); "That Chip Has Sailed"
(Goldie et al., 2024) — <https://arxiv.org/html/2411.10053v1>; "Updated
Assessment of RL for Macro Placement" (Cheng/Kahng, ISPD 2023) —
<https://arxiv.org/abs/2302.11014>. circuit_training —
<https://github.com/google-research/circuit_training>. CircuitNet —
<https://github.com/circuitnet/CircuitNet>. GNN4IC (CongestionNet/RouteNet
index) — <https://github.com/DfX-NYUAD/GNN4IC>. DeepPCB Pro (InstaDeep,
marketing) —
<https://instadeep.com/2024/09/instadeep-introduces-deeppcb-pro-an-ai-powered-pcb-design-tool/>.
