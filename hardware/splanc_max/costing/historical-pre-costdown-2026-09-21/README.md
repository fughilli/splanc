# Cost model provenance

Run `python3 hardware/splanc_max/costing/estimate.py` from the repository root. It regenerates the sibling BOM CSV/JSON and summary JSON from explicit quantities/prices in the script. USD, 1,000 systems, estimate dated2026-09-21.

`basis` distinguishes published price tiers carried forward from engineering allowances. `source` points to the exact distributor/manufacturer page retrieved; empty sources mean internally chosen budget assumptions, not vendor pricing. Stock shortages and cached observations are documented in `note` and in `docs/hardware/splanc-max-costing.md`. Prices are not live APIs and no purchasing occurs.

The current design assumptions are20channels,12/24V,2Aeach40Aaggregate, two boards plus USB bridge, 50-pin ribbon and pluggable terminal mating pairs, same-ground strip outputs with one isolation boundary to the Pi. The quoted quantity is whole systems: repeated parts must be procured in multiples of1,000. Budget calculations do not establish supply allocation or manufacturing readiness.

Enclosure scenarios are in `enclosure-scenarios.json`, separately from electronics so tooling is not silently counted as a recurring board cost. All figures there are engineering allowances, contextualized by the cited manufacturers' cost guides, not quotes.

Final reconciliation:52 LV/190 power/3 bridge components. Cost model includes explicit completion reserves for protections and EEPROMs not yet fitted; see report. TXU0304 and final connector choices add$12/set vs original estimate.
