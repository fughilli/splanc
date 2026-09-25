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
