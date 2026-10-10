# Fresh119 shutdown crash and continuation122

The 2026-09-24 native `unmove` worker completed its board and report, then
segfaulted in `visit_decref -> dict_traverse -> collect -> PyGC_Collect ->
Py_FinalizeEx`. The original macOS crash is Python-2026-09-24-154842.ips.
Earlier replays omitted PNR_PROFILE_DIR and therefore missed the trigger.

Exact archived C42 inputs reproduce 8/8 failures with original profiling and
8/8 with wx initialized. A factorial comparison of old/current sources,
annotations on/off and profiling on/off fails exactly when profiling is on.
All variants save the same PCB SHA256. Direct cProfile is not enough to trigger
it; the retained live profiler entries during our report/provenance processing
are implicated. Disabling builtins, removing the checkpoint thread, moving native
imports earlier, or late clear did not fix it. Reading a serialized snapshot
without early clear still fails; early clear before report allocation passes.
This narrows the lifecycle trigger; it does not identify the exact upstream
CPython/SWIG memory defect.

`pnr.profile.finalized_stats` now disables profiling, writes the complete pstats
snapshot once, clears native profiler entries, then reads that immutable file
for summary processing. Profiling remains enabled in production. Twenty fresh
processes with original compiled rules/annotations and distinct hash seeds pass
normal interpreter shutdown, identical saved PCB SHA256
`ae8a5649433ea05c6f956883b7161e3d3e2a83f22536e997e0041ee5d43f27cb`.
The native move/unmove regression now enables profiling and checks process exit,
restored pose/net/UUIDs and readable nonempty profiler artifacts. `profile_test`
checks entry release ordering and preserves return values/exceptions.

Raw replay matrix, captured logs and isolation scripts: `output/crash122/`.
`replay-results.json`, `factorial.json`, `wrapper-final.json` and
`fixed-replay-results.json` retain positive and negative evidence. The first
metadata-import probe used shadowing filenames and failed with ImportError;
corrected subdirectory probes are the relevant evidence. No failed replay board
was promoted; no process exit was ignored or bypassed.

## Outline reservation

Fresh119 source round02 has nine front-copper edge-clearance violations. With
55 mm height and0.35 mm pitch, the penultimate row is54.775 mm, only0.225 mm
from the far edge. Mirroring an inset cell count from ceil(height/pitch) fails
to reserve it. `block_edge_inset` now compares physical centers with all four
actual board boundaries. Tests cover transposition, integral and fractional
sizes and both track/via passability. Widths and DRC policy are unchanged.

The complete native ladder is rerun with explicit `--packed-maze` and
`--batched-wirelength` switches. Ambient experiment environment remains cleared.
Provenance records these options. Full source-to-final validation remains
necessary; protected fresh28 stays the primary result until a better board
passes all required gates.

## Regional native geometry lifecycle (continuation123)

The unmove fix did not cover regional routing. Fresh122 `keyhole_region.py`
workers could save an accepted route and then crash during GC; the controller
correctly rejected their exits. Exact saved COMP and two completed-routing
fixtures are in `output/crash122/regional-crash`. Profiling-off controls passed,
but disabling cProfile builtins, switching to statistical samples, initializing
wx, retaining the board alone and clearing cached shapes before reporting all
failed. Holding cached geometry until *after* profiler report completion, then
releasing it normally, passed15 factor replays. The bounded profile lease passed
36 fresh processes across3exactfixtures/12hashseeds, including24accepted native
transactions. It preserves normal shutdown and full native acceptance gates.
No upstream root memory-corruption cause is asserted.

`retain_native` now retains regional board/shape-cache owners only for the
duration of an active profiling call, then releases every lease after report
frames return, including exceptional exits. Four contract tests verify nested
calls, report-time lifetime, failure propagation and no unprofiled retention.
Existing profile tests still pass. Raw factor matrices retain failed hypotheses.
The installed LLDB itself bus-faulted during target creation; no machine
permissions or debugger protections were changed.

## Differential-pair portal resolution

Bounded 0.1mm lead/run samples supplement the old coarser distance set. A narrow
reference-window regression demonstrates the missing0.6mm portal; the original
uncoupled-length cap still rejects insufficient access. Exact native USB test:
266to260opens,0violations,0.28500019mm endpoint skew, postfill reference checks
pass, prior connectivity/pad entries preserved. Normal paired_bootstrap
controller accepts legal trial03 after175.890s; it rejects an illegal earlier
pose. Independent cold DRC agrees and controller/fixture copper+poses match.
All62actualPDFpages and8via-cluster images reviewed in
`output/pdf/mini-crash122-usb-legal` and
`output/crash122/pair-portal/legal-routes/pose-05/via-scan`.
Back-layer trunk still needs physical stackup/impedance qualification.
This is an early-stage gain, not a finished board.

Fresh122 was deliberately interrupted at a saved58-open checkpoint to integrate
these fixes; it did not reach plateau. Its651inputs verified unchanged and
build diagnostics archived before editing. Source watcher/warm-host startup now
requires completion/data timestamps from the current controller to avoid stale
Bazel results. Protected fresh28 remains48opens/0violations.
