# Batched native validation

Isolated runtime for full109's next UI-confirmed restart. The active production
runtime is unchanged. `run.py` resumes through the restart110 controller contract;
`runtime.py` selects this package for both controller and full_iteration workers.

Distinct-net additive signal, power, and plane-access workers return
`proposal_ready=true, accepted=false`. They retain geometric/current/entry/reference
checks but omit their two internal native DRC invocations. Merge the ready group,
refill, check required target connectivity, preserve existing connectivity and pad
entries, reject newly inadequate pad entries, preserve reference witnesses, then
run one native DRC. Only this gate accepts copper. Failed groups are bisected
against the latest accepted prefix; failing leaves remain eligible for serial retry.
Coupled pairs, rip-up and placement-changing transactions keep their existing path.

Regression evidence:
- test_batch.py: four deterministic unit tests including fail-closed validation.
- test_native_batch.py: actual KiCad merge + DRC, compatible two-route group uses
  1 DRC vs 2 serial calls, 2.14s vs 4.29s on this fixture. Conflicting group uses
  3 calls, retains the valid route and rejects the crossing. Not a whole-run speedup.
- test_native_controller.py: actual signal AND power proposal workers and controller;
  two proposals, no worker DRC files, one combined validation, 0 opens/0 violations.
- Real Splanc early-power smoke: 267 opens unchanged. Four proposals rejected;
  one routed proposal failed a new pad-entry requirement. No improvement claimed.
- Restart broker verifies all staged hashes before stopping current work. Controller
  preflight passes. UI control/restart/snapshot regression passes.

Native test commands require KiCad Python and may need native-execution permissions.
Each native controller test uses a new output directory. Results are under
output/batch111. Synthetic fixture tests are not a replacement for full Splanc
routing qualification, PDF/image review, or a fresh source-to-board run.

Deployment: output/fresh-pnr-20260919/full109/next-controller.json selects and hashes
this runtime. The broker only consumes it after an explicit restart epoch from the
UI. It archives partial rounds and preserves completed rounds/snapshots/preferences.
No restart is triggered by staging. Subsequent completed routing rounds retain the
full109 PDF/5mm-via-scan watcher and mandatory actual visual review workflow.
