# Splanc engineering checkpoint — 24 September 2026

This draft captures the current Mini routing work and the Splanc / Splanc GNSS /
MAX electronics and mechanical prototypes. It is not a manufacturing release.
The pull request remains stacked on `pnr-system` / PR126.

## Start here

- [PnR design](pnr-system.md) and [input rules](pnr-inputs.md).
- [Native regression suite](../../hardware/pnr/regression/README.md) and
  [measured results](../../hardware/pnr/regression/RESULTS-118.md).
- [Initial placement exploration](../../hardware/experiments/tscircuit-mini/initial118/README.md):
  eight starts, capacity/diversity screening and three equally budgeted signal
  finalists. Pogo XY/rotation is released while bottom side stays mandatory.
- [Literature assessment](../../hardware/experiments/tscircuit-mini/literature117/ASSESSMENT.md).
- [Full electrical incremental loop](../../hardware/experiments/tscircuit-mini/full116/README.md).
  Experiment runtime directories contain source overlays, not installed Python
  environments. Some improvements remain in these isolated prototypes; do not
  assume every experiment has been promoted into the production source build.
- [Live viewer](../../hardware/tools/pnr_live/README.md), with layer/phase controls,
  immutable snapshots, rectangle annotations and persistent worker settings.
- [Splanc / GNSS](../../hardware/splanc/README.md),
  [MAX](../../hardware/splanc_max/README.md), and
  [launch-price model](launch-pricing.md).
- [Current enclosure generator](../../hardware/mechanical/CLEAN-ENCLOSURES.md)
  and [mechanical viewer](../../hardware/mechanical/viewer/README.md).

## What has been validated

The native PnR ladder closes eight designs at two seeds each: all16 saved boards
have zero KiCad opens and zero DRC findings, with original pin/net preservation,
source track widths and qualified tracked-pad entry. It ranges from a two-part
connector/LED fixture (externally current-limited) to a20-part TLC555/CD4017B LED
chaser and four-layer plane variant. It is a backend integration test; it does
not certify analog circuit behavior or complete atopile compilation.

The bounded initial pool reduced vias7→4 and copper90.91→72.93mm on the8-part
board, and vias28→26 / copper312.31→274.30mm on the20-part plane board. Total
compute increased. Both representative cases were rerun after the hard-side and
under-body placement changes and again passed native DRC and electrical-entry
gates. All100 pages of those new layer PDFs and all four5mm via clusters were
actually inspected. Potential ground-via sharing, route detours and crowded
fabrication text remain; closure does not mean optimal quality.

Final placement changes passed67 unit/regression tests. The isolated coordinated
pad-access fixture improved one native open to zero without increasing DRC
violations. Primary-source literature links and narrower test scopes are recorded
in the corresponding experiment reports.

## Current Mini status

The protected best remains48 native opens / zero native violations. It is not
fully routed or electrically qualified. A separate under-radio relocation trial
reached57 opens but failed preservation/electrical gates and was not promoted.

The newest placement-only comparison retains bottom TP1 beneath U6 at(17.25,32)mm.
Its overflow proxy is15.2% lower than the released-pogo baseline, with eight
coarse unreachable branches unchanged. The earlier position-locked best proxy
still scored better overall. This establishes broader exploration, not a native
routing win.

Fresh119 is now running the actual atopile source-to-board target with the initial
pool enabled. Six of eight initial starts legalized; detailed finalists and later
power/planes/USB/native phases remain in progress at this publication checkpoint.
Finite initial/source/native budgets are not an observed full-electrical placement
plateau. No fresh119 success or manufacturing readiness is claimed.

## Artifact policy and reproducibility

Generated boards, PDFs, renders, videos, release ZIPs, downloaded/derived CAD
models, caches and executable runtimes stay outside this source checkpoint.
Previously public source footprints, symbols and regression fixtures remain.
[Artifact inventory](collaborator-artifacts.json) records omitted current asset
paths, byte counts and hashes. Files are retained locally; exclusion from Git did
not delete them. The unpublished local commit series is preserved locally; the
published checkpoint descends directly from the existing PR head, so historical
release ZIP blobs are not introduced to the remote branch.

Use the regression README for independent KiCad closure tests. Use the initial
placement README's explicit build controls for a fresh Mini build. Prototype
family boards can be regenerated with their project tools. Mechanical scripts
also require the reference electronics/model inputs described under
`hardware/mechanical/assets`; some are derived from local prototype scenes, so a
fresh clone alone is not yet a self-contained reproduction of every product
render. Machine-local output links in historical reports are evidence locations,
not public downloads. No new artifact hosting or release has been published.
