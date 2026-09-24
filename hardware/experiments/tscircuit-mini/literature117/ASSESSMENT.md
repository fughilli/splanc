# Applying the EDA literature review to Splanc

Reviewed 2026-09-24 against the paused full116 runtime and capacity115 source.
Source document: user attachment `eda-placement-routing-review.md`. This is a
selective technical assessment, not an audit of every catalog entry or a measured
router comparison. Proposals below are adaptations unless explicitly described
as already implemented. No routing run resumed and no frozen inputs changed.

## Recommendation

Keep the hybrid architecture. The highest-value additions are joint terminal
access assignment and reusable route topology/corridor information shared between
placement and detailed routing. These address the observed pad-escape traps,
repeated repair, placement-surrogate mismatch, and trace/via artifacts more
directly than replacing the search with a trained policy.

### 1. Joint pin-access planning and small constrained repair windows — first

**Existing implementation:** `full116/runtime/hardware/pnr/pnr/route/detail/escape.py`
lines94–148 walks components and pads, selects one escape and immediately reserves
its resources. `regional.py` lines73–196 retries conflict-directed net orders and
commits only complete repairs. These are useful foundations, but a locally legal
first escape can consume the only exit for another pad.

**Proposed adaptation:** enumerate several native-width, pad-entry-qualified
access alternatives for every terminal in a small interacting cluster. Include
surface paths, existing same-net via/thermal-hole access, and only source-legal
new vias. Construct conflicts between alternatives; choose jointly using bounded
backtracking or a small integer/constraint solver. Reserve the complete choice
before trunk routing. Escalate the window only when failure involves its boundary.
Give each result a reason: no generated option, mutually conflicting choices,
boundary conflict, or budget exhaustion. Infeasibility applies only to the modeled
candidate set, not every possible PCB route.

**Why this board:** U18/U19/U5 repeatedly have dense escapes, narrow pad-entry
issues and excessive via branches. Test these regions plus TP1 restoration. Keep
actual pad-group current widths and pair constraints; never solve by shrinking
tracks or weakening preservation.

**Source:** [TritonRoute/OpenROAD](https://openroad.readthedocs.io/en/latest/main/src/drt/README.html)
explicitly separates pin-access analysis, track assignment and search/repair.
The specific small conflict solver above is our proposed PCB adaptation.

### 2. Turn the capacity proxy into reusable route guidance — first

**Existing implementation:** `place/capacity_proxy.py:164` negotiates shared
multilayer demand, but returns scores/heatmaps rather than persistent routing
choices. History starts afresh per evaluation. It reconstructs all net demand;
it does not model retained copper reuse or prove detailed terminal access. The
actual detailed router therefore need not realize the paths that made a placement
look promising.

**Proposed adaptation:** export several coarse corridor/topology candidates per
net, terminal-access choices and resource prices. Optimize candidates together;
pass the selected corridors as soft guides to detailed routing. Feed actual
failure locations back into the same model. Keep a separate retained-copper mode:
reserve fixed geometry once, and route only residual connectivity demand, avoiding
double counting. Evaluate finalists at multiple grid offsets/resolutions and
record rank instability as uncertainty, retaining exploratory alternatives.

**Why this board:** the old proxy ranked legal under-radio TP1 at220/302. The new
proxy ranks it much better, but one tested resolution reverses that preference.
Full116 is paused after two completed, rejected candidate evaluations, so we still
lack evidence that proxy improvements produce accepted routing improvements.

**Sources:** [CUGR](https://github.com/cuhk-eda/cu-gr) models detailed routability;
[DGR](https://wadmes.github.io/cv/raw/DAC24.pdf) jointly selects tree/path candidates
using continuous relaxation before discrete layer assignment and maze refinement.
We should borrow joint candidate selection first; a full GPU differentiable solver
is not required for a small PCB. The offset ensemble is our proposed calibration
method, not a claim about DGR.

### 3. Preserve topological routes through placement changes — second

**Existing implementation:** incremental116 now removes obsolete terminal branches
without stopping at false junctions caused by overlapping segments. Geometry
cleanup already reconstructs ordinary, single-width signal trees on one layer
(`geometric_native.py`, `geometric_tree.py`), with connectivity/pad-entry/native
checks. It excludes source-protected power/plane/pair cases. We do not currently
have a persistent obstacle-relative route representation that deforms with moving
components, nor general coordinated multi-net smoothing.

**Proposed adaptation:** store terminal/via anchors and which obstacle sides each
route traverses. For modest legal placement changes, replay that topology against
new obstacles, realize a short legal geometric route, then search a different
topology only on failure. Optimize neighboring corridors together when their
ordering is fixed. Preserve source-sized trunks, joint pair geometry and all
reference/entry checks. This is a larger project, best gated by the JITX trial.

**Source:** [JITX topological autorouter](https://docs.jitx.com/en/latest/essentials/physical_design/autorouter.html)
describes topology search, geometric realization and replay after movement. It
also explicitly says its router operates one layer at a time; its documentation
does not establish automatic complete multilayer board closure.

**Correction to an earlier premise:** current [Freerouting architecture](https://github.com/freerouting/freerouting/blob/master/docs/architecture.md)
includes trace pull-tight, shove and via optimization. It is inaccurate to say
Freerouting has no geometry-relaxation step. Whether our former integration ran
those optimizers effectively is a separate question, not settled by this review.

### 4. Resource-driven collective placement and coordinated assignment — second

**Existing implementation:** batch_relocate samples combinations of top-N poses,
with spatial/under-body diversity and singleton moves. Earlier collective
expansion prototypes displaced components, but coarse congestion reduction did
not demonstrate accepted full-pipeline improvement.

**Proposed adaptation:** turn corridor prices into candidate-specific movement
costs and solve a small joint placement assignment including swaps/rotations,
legal spacing, fixed components and relative constraints. Use a displacement
penalty to discourage needless route destruction. Re-evaluate routes after each
collective proposal. Do not copy standard-cell row/site assumptions onto arbitrary
PCB footprints, two-sided bodies or mounting/antenna restrictions.

**Sources:** [OpenROAD global placement](https://openroad.readthedocs.io/en/latest/main/src/gpl/README.html)
uses RUDY/global-route feedback and inflation; [RUPlace](https://yibolin.com/publications/papers/PLACE_DAC2025_Chen.pdf)
alternates routing and incremental placement with explicit coupling. Those
support the coupling principle. Merely running P/R/P/R is not implementing ADMM.
ABCDPlace's matching and swap ideas are relevant, but its standard-cell solver
is not a drop-in PCB placer.

### 5. Polygon free-space routing / MCTS — targeted experiment, later

The [DATE2023 PCB paper](https://past.date-conference.com/proceedings-archive/2023/DATA/603.pdf)
uses polygon-region paths, detailed A*, dynamic repartitioning and nested reroute
search. Its reported10/10 completion versus8/10 baselines is on ten two-layer
boards, with more vias. The reusable idea is updating geometric connectivity as
traces are laid, reducing coarse/detail disagreement. Test polygon corridors in
one troublesome region before introducing full-board MCTS. Our existing local
conflict-directed repair means tree search is an extension, not an entirely new
architecture.

## Defer

- Training a board-wide RL/diffusion policy: no diverse qualified training corpus
  or demonstrated advantage over the current deterministic weaknesses.
- Wholesale DREAMPlace/OpenROAD transplant: useful mechanisms, incompatible PCB
  geometry/resource/electrical assumptions without major adaptation.
- GPU/OpenCL migration solely because the literature uses GPUs: measure a hot
  batchable kernel and total speedup first; retain existing Rust gains.
- Further blanket board expansion or larger penalties without local access and
  model-calibration evidence.

## Evaluation contract

Use identical placement, outline, source current policy, stackup assumptions,
pair rules and routing budget when comparing routers. Keep separate tests for
preserved-copper continuation and fresh routing at the same placement. Do not
compare a moving-placement run with a fixed-placement route as equivalent.

Fixture ladder: U18/U19/U5 escape clusters; TP1 movement and restoration; then
whole-board original and under-radio placements. Record native opens, lost seed
connections, DRC types, pad entries, reference failures, subwidth tracks, paired
qualification, via count, copper length, native-DRC time and total wall time.
All layered geometry must survive native save/refill/DRC and the existing full
acceptance gate. A lower proxy or lower total opens cannot conceal lost prior
connectivity. Use multiple fixed seeds and equal budgets, and preserve failed
results. Final promoted boards still require complete visual/electrical review.

The protected best remains fresh28 (48opens/0violations). The paused full116
experiment has no new accepted completed round; its first two candidate outcomes
are56opens/2violations/guardfalse and70opens/3violations/guardfalse. Those numbers
are not improvements over an accepted board.
