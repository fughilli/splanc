# Geometry105 isolated improvement workstream

This runtime is a separate copy of PnR so ongoing full104 remains reproducible. No production PnR sources were changed during full104. Annotated input identity is recorded in fixtures/annotations.json. New geometric policies receive arbitrary net/pad arguments and source rules; fixture reference names do not occur in routing decisions.

Implemented:
- `pnr.geometric_tree`: exact-oracle octilinear visibility tree, new shared junctions, retained terminal centers, multiple greedy root trials. Candidate-node bound, no implicit clearance relaxation. Terminal fanout nodes and collinear seed reduction keep native endpoints reachable.
- `pnr.geometric_native`: ordinary-signal single-layer proposals, original uniform width, no moved vias/pads. Source current/plane/pair/array/locked/mixed-width protections. Connectivity and pad-entry checks, followed by external native DRC gate.
- `pnr.geometry_optimize`: automatic inventory and sequential per-net transactions with refill/DRC and rollback. Exposed as optional `--geometric-relax` in the isolated full_iteration, with native phase08b. Full source-to-board rerun with this flag still pending. No global corridor attraction or component-cluster shove yet.
- `pnr.escape_shove`: bounded local blocker rerouting around simultaneous reserved ordinary-signal escapes. Fixed existing terminals/widths/vias retained. Default commits only blocker copper: escape tracks and vias remain structured reservations until onward routing can complete. `--commit-escape` is diagnostic and can produce dangling vias; never promote without DRC. Component movement and recursive multiple-net displacement not implemented.

Profiling:
`PNR_PROFILE_DIR=OUTPUT python -m pnr.profile --label LABEL --module MODULE ...`
Writes per-process .pstats and JSON with CPU/wall, RSS units, failures, top functions, named spans, iteration/candidate IDs, argv and runtime version. Disabled execution preserves behavior. Native-loop workers and full-iteration subprocesses are wrapped in this isolated runtime. Profile each child separately; parent subprocess wait is not Python kernel work. Do not add inclusive timings across nested processes. cProfile overhead changes budget-limited searches; use identical workloads and unprofiled comparisons too.

First measured bottleneck was pad_entry.inspect repeatedly scanning all copper and every qualified pad. Indexed track net/layer and pad footprint/net/layer groups eliminate repeated SWIG calls. Full record equality (391 records) verified on baseline and rewritten board. Unprofiled original/indexed samples3.29/.30s and2.51/.13s; these are two examples, not a whole-loop speedup.

USB profile shows keyhole A* Python bookkeeping and native reference-polygon subtraction dominate. Reference-plane correctness remains mandatory. Coordinate/heuristic memoization and integer edge-cache keys retain exact results on25 forced-detour seeded cases. An optional Rust A* backend moves heading states, heap, costs, predecessor and edge cache into contiguous native arrays; all exact geometry queries still call the same Python/KiCad oracle. Python owns terminal escapes and path relaxation. C callback exceptions abort and propagate, never become clear edges. Environment: `PNR_SEARCH_BACKEND=rust PNR_RUST_SEARCH_LIB=/absolute/path/libpnr_search.dylib`; default remains Python. No OpenCL implementation yet: prioritize measured batchable fields after the search and native validation bottlenecks.

Rust compiler1.98.1 installed using official rustup into output/geometry105/toolchain only, with --no-modify-path. No crates/dependencies. Build:
`RUSTUP_HOME="$PWD/output/geometry105/toolchain/rustup" output/geometry105/toolchain/cargo/bin/rustc --edition 2021 --crate-type cdylib -C opt-level=3 hardware/experiments/tscircuit-mini/geometry105/rust/search.rs -o output/geometry105/rust/libpnr_search.dylib`
Kernel source rust/search.rs; Python adapter route/detail/rust_search.py. Exact path/status/expanded/raw-length equivalence25 seeds; existing keyhole13 and regional7 regressions pass with Rust. One benchmark reference2.64s/Rust1.14s; record tests across equal inputs before claiming production speedup. Real USB profile and final result must be checked separately.

Native geometry results (output/geometry105): board-fault-v2 changes U11 U into shared trunk11.845->8.534mm,0DRC/93opens, no lost entries. cleanup/best includes that plus4/6accepted signal trees: board-en39.879->39.674;board-20 42.826->42.785;19 38.384->37.804;B35.684->33.223mm. U4-clearance reroutes lv around verified escape reservations for scl/sda,0DRC/93opens; U4-shove earlier diagnostic retains2danglingvias and is NOTaccepted. None is a finished electrical board or promotion over protectedfresh28.

Image review: actual before/after annotation crops inspected underoutput/geometry105/crops. U11 now has one shared trunk. U4 has a larger detour preserving room for two escapes. Long-track changes are uneven; board-20 improvement is tiny, so do not call corridor compaction solved. Full104round1all8copperPDFpages also viewed; remaining technical/contact/via review stillpending. Two full all-layer PDF exports are running to output/pdf/geometry105-cleanup and geometry105-escape; do not mark reviewed until finished and viewed.

Latest validation: saved native fixtures PASS, including simultaneous SCL/SDA
escape corridors and legal reserved via sites. Shared reference-plane cache
matches the original checker on2,400 near/far segments across4 aperture shifts.
The combined Rust/reference-cache USB trial still expires at90s without routing
the pair. Native polygon subtraction remains the largest measured hot path.
Timing records use cProfile elapsed function time separately from process CPU;
concurrent workers and profiling overhead prevent treating these90s trials as a
controlled speed comparison. This work does not establish a full-loop speedup.

Pending: integrate bounded escape repair with complete onward routing; implement
multi-net corridor compaction; freeze the candidate runtime and run the entire
pipeline before promotion. Current full104 remains untouched and continues its
batch exploration. OpenCL remains deferred until profiling identifies suitable
batch work. PDFs and technical/via review are still pending completion.
