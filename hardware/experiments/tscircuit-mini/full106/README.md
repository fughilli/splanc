# Profiled Rust restart
User requested terminating full104 and restarting with instrumented faster kernels.
Full104 preserved, termination explicitly user_requested_profiled_rust_restart.
Full106 starts the same relocate101 round2 source placement from scratch through
all electrical phases, seed104, K4/N4/samples4/workers2, normal plateau schedule.
This is a checkpoint-seeded full phase experiment, not a fresh atopile build.
607 production inputs frozen in full106-source; executed driver/wrapper/Rust source
and binary archived in executed-tools. Production runtime now includes validated
geometry105 Python optimizations and optional native-gated geometric relaxation.
PNR_SEARCH_BACKEND=rust; binary full106/runtime/libpnr_search.dylib. Actual first
native-electrical profile recorded296 Rust search calls. Native/electrical guards
remain. PNR_PROFILE_DIR captures final profiles and .live.pstats/.live.json every
60seconds during long workers. Nested profile wrappers reuse the active profiler.
Watch.py exports PDFs/5mm scans each completed round; image review remains manual.
Do not edit frozen runtime midrun. Parallel107 remains a separate unpromoted test.
