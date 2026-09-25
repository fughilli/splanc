# DRC120: initialized native KiCad checks

The startup hypothesis is supported on this Mac mini with KiCad 10.0.6. The new backend is integrated **opt-in**, with the original cold CLI as the default and final acceptance path. It has not yet been validated in a complete fresh Splanc PnR run.

## Measurements

Five cold calls and five batches of eight checks per fixture, shuffled in a fixed order:

| Fixture | Cold CLI median | Eight checks in one supported jobset | Amortized speedup |
| --- | ---: | ---: | ---: |
| 2-part LED | 1.303 s | 3.173 s | 3.29× |
| 20-part chaser | 1.333 s | 3.237 s | 3.29× |
| Protected Mini, 48 opens | 1.495 s | 4.214 s | 2.84× |
| Fresh119 screening Mini, 186 opens | 1.507 s | 4.447 s | 2.71× |

Jobsets repeatedly check the unchanged board. They demonstrate amortization, not mutable-model performance or whole-router speedup. JSON, individual reports and wall/child-CPU measurements: `output/drc120/jobset/results.json`; compact summary: `output/drc120/benchmark-summary.json`.

The initialized editor service additionally supports retained models and track-only deltas. The final 13-step chaser fault/restoration sequence took roughly 0.36–0.39 s per warm check versus 1.33–1.43 s cold. Five protected Mini warm requests had median 0.471 s (first load 0.575 s; subsequent reuse 0.456–0.480 s), preserving 48 opens / zero violations. These latter timings are indicative correctness-run observations; some tests overlapped briefly and were not a controlled whole-pipeline A/B. Memory snapshot of that Mini host was about586MiB RSS. Artifacts: `output/drc120/validation/{qualified-sequence,mini-warm-final.json}`.

Actual fresh119 early-power profile: 40 DRC calls used 52.47 s of a 270.59 s parent wall interval, about19%. Parent waits and child CPU are not added. Even a threefold DRC improvement cannot imply a threefold PnR speedup. Failed warm checks pay both warm and cold cost, so candidate quality matters.

## Integration and use

Canonical implementation is `hardware/pnr/pnr/drc_warm/`, exposed through `pnr.native_drc.run_drc`. The experiment copies retain the tested prototype history. No user KiCad preferences, plugins, app permissions or protected source boards are modified.

```python
from pathlib import Path
from pnr.drc_warm.session import DrcSession
from pnr.native_drc import run_drc

with DrcSession(seed_board, Path("new-output/private-drc-host")) as host:
    # Existing subprocess workers can receive host.environment instead.
    result = run_drc(kicad_cli, candidate, report, env=host.environment)
    final = run_drc(kicad_cli, candidate, final_report,
                    env=host.environment, final=True)
```

Each host is single-threaded on the initialized editor's wx main thread. Use one bounded session per independent candidate lane, not concurrent mutations of one BOARD. `PNR_DRC_SERVICE` opts calls into a particular private host; omit it for the existing CLI. The caller must refill/save zones before checks exactly as before. This service does not refill, change severities, suppress violations, or qualify electrical intent.

The service retains a separate BOARD, never the displayed seed. Static non-copper content is compared exactly. Track/arc/via additions, removals and width changes use UUID deltas; footprints, pads, zones, outline or other static changes force a board reload. Project/rule/table/library hashes and footprint inventory are checked. Changed policy, exclusions, unsupported reports, timeout, host failures, or nonzero findings invoke the original CLI. Full native DRC runs on every request. `final=True` always invokes the cold CLI.

A session is bounded to64 native attempts and64 input snapshots, then falls back to CLI until the caller creates a fresh session. This bounds retained native wrappers and artifacts. The context manager terminates only its recorded PID after command identity validation. Closing a session preserves its compact evidence; callers may archive/prune their own completed experiment directories under the experiment retention policy.

Native text reports are converted with exact description/position matching. Ambiguous violations are rejected. Identical-length tracks at the **same exact endpoint, net and layer** can be equivalent witnesses for an open; all aliases are retained. KiCad itself chooses different nearest unconnected witnesses and different first-error-per-item violation subsets across repeated cold checks. Raw reports and exact-signature differences remain in the evidence. Nonzero warm reports are never substituted for cold reports.

## Validation and rejected approaches

- 13 contract tests pass, including original CLI timeout/stale-report behavior and new final-gate, parser, static-state and fail-closed tests.
- Native 13-step sequence: clean → missing track → clean → undersized track → clean → short → clean → invalid via → clean → clearance violation → clean → placement change → clean. Expected native fault categories checked in both warm/cold reports; all clean restorations returned zero opens/findings. Failed exact witness matches explicitly verified invocation of the original CLI, rather than pretending native UUID selection is deterministic.
- Staged package/env integration, forced cold final gate and changed-project fallback pass. `qualified-sequence/fault-category-audit.json` records12 fault-category report checks.
- Earlier unbounded wrapper lifetimes produced a SWIG `GetTracks` error after repeated edits. A bounded native/wrapper keepalive arena resolved that sequence. Failed outputs remain as diagnostic evidence under `session-chaser`, `arena-chaser`, `verified-chaser`; they are not successful test runs. Extended sequences also exposed nondeterministic CLI witness lists, corrected in the validation comparator without relaxing clean/fault acceptance.
- Standalone `pcbnew.WriteDRCReport` segfaults in `PROJECT_PCB::FootprintLibAdapter` during library-provider initialization on installed10.0.6. `wx.App` alone and a disposable ignored-library-severity test did not solve initialization. Neither is used in the backend. The actual initialized nested PCB Editor executable with a private complete profile is required.

Tests:

```sh
PYTHONPATH=hardware/pnr python3 -m unittest discover -s hardware/pnr/tests -p 'test*native_drc.py'
```

`jobset_benchmark.py`, `make_faults.py`, `validate.py` and `stage_runtime.py` reproduce the prototype tests with explicit new output directories. The fault generator runs under KiCad Python, creating disposable fixtures only. These are not new routing results and do not supersede protected fresh-28.

## Regional DRC is not implemented

KiCad's [10.0.6 native DRC engine](https://github.com/KiCad/kicad-source-mirror/blob/10.0.6/pcbnew/drc/drc_engine.cpp) invalidates/regenerates caches before running providers. The [scripting helper](https://github.com/KiCad/kicad-source-mirror/blob/10.0.6/pcbnew/python/scripting/pcbnew_scripting_helpers.cpp) reinitializes rules and exposes whole-board report generation, not a dirty-region API. Warm initialization/model reuse is useful without extracting the C++ kernel.

Local-only authoritative DRC would require dependency-aware invalidation for global connectivity, zones, custom rules, differential length/skew and reference copper. Performance121 separately explores cheap geometric proxies inside provisional epochs, with native boundary acceptance/rollback. Neither approach permits skipping full native/electrical final gates.
