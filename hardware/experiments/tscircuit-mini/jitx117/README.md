# JITX 117: isolated feasibility and routing benchmark

## Status on 2026-09-24

- Official `jitx==4.4.1`, `jitxcore==4.4.0` and `jitxlib-standard==4.4.0` installed in `output/jitx117/bootstrap/.venv` on the external disk. Scaffold discovery succeeds (`splanc_jitx_probe.main.SplancJitxProbe`). This is the vendor's two-resistor sample, **not a port of Splanc**.
- Official runtime 4.4.1 installed under the normal per-user `~/.jitx` location. It is x86_64: the initial install correctly stopped for missing Rosetta. The user installed Rosetta, then `arch -x86_64 uname` and runtime installation succeeded. No automatic terms acceptance command was run.
- Authentication reports `authorized: false`, `file_present: false`, `no license file on disk`. No Splanc design has been imported, built, uploaded or routed in JITX. No performance comparison result exists yet.
- `full116` remains paused. All protected and historical board files are untouched.

## Current support, verified rather than assumed

The public topological autorouter operates **one active copper layer at a time**. It searches a topological route, then realizes the geometry. Auto-via is a separate operation placing adjacent vias; it is not documented as a complete multilayer search. SI constraints/envelopes are separate. A successful single-layer batch must not be presented as automatic whole-board completion.

The installed 4.4.1 CLI has a callable `jitx project import kicad INPUT --output DESTINATION` wrapper around the runtime's `import-kicad ... -json`. It accepts a KiCad project file or directory. However it is hidden from normal CLI help and lives in `_cli/_deprecated/import_.py`, explicitly marked slated for removal in the next release. The installed Python API exposes a `legacy-kicad` exporter. The current manual does **not** establish import fidelity for KiCad 10 boards or promise that this legacy importer produces Python 4.4 projects. These remain practical import-roundtrip gates, not assumed capabilities. No custom reconstruction has been represented as native import.

## Prepared native inputs

Run `prepare_inputs.py` using KiCad's bundled Python. It copies bytes, records SHA256 provenance, and inventories with native KiCad 10.0.6 without saving or altering source boards.

- `output/jitx117/inputs/original/board.kicad_pcb`: frozen full116 seed, historic 85 opens / zero native violations.
- `output/jitx117/inputs/under-radio/board.kicad_pcb`: pogo114 **preflight** with only TP1 moved beneath U6 and associated terminal branches removed, historic 96 opens / six dangling warnings; no clearance or shorts. This is not the rejected final 57-open board.
- Both retain all 141 footprints, 578 pads, 94 net-table entries, four copper layers, nine keepouts, paired project settings, and full source electrical rules in `source-rules.json`.
- Original has 1814 track segments / 234 vias. Under-radio preflight has 1786 / 231. Original-placed JSON is provided only as original-frame provenance; under-radio native footprint locations are authoritative for that case.
- Native DRC copies are `inputs/*/baseline-drc.json`. Comparison must separate placement and retained-copper differences: give **both routers each identical input**, then compare improvements within each case.

Baseline itself is not electrically qualified: its previous full audit reported 153 subwidth track flags, one unqualified USB pair and an incomplete native stackup. The source rules carry 1 oz outer/inner copper screening assumptions, layer-specific power widths, current-based via arrays and USB topology/width/gap/skew/reference requirements. These may not silently disappear during conversion. Protected best fresh28 remains 48 opens / zero native violations.

## Next steps after account/license authorization

1. Run the persistent CLI `output/jitx117/bootstrap/.venv/bin/jitx auth login`. The user completes the browser device-code flow with their own account. Do not send credentials to the agent. Check `jitx auth show` afterwards.
2. Confirm that the account permits this design's existing license. Free/Open requires CERN OHL-P v2 and sharing the design with JITX; open-source status alone does not establish eligibility. Do not relicense or upload Splanc to qualify. Use a suitable existing account/license or user-arranged evaluation when needed.
3. Try the vendor legacy importer on **the isolated input directory only**, output to a new `output/jitx117/imported/<case>` directory. Determine whether it accepts PCB+project without schematic, whether it emits Python or old Stanza, and whether current runtime can build it. Stop on unsupported semantics instead of inventing dummy components or dropping constraints.
4. Export an **unchanged** roundtrip to native KiCad, compare every footprint pose/pad/net/geometry/drill/zone/keepout/outline/layer and retained track, then native DRC and electrical/source-rule audit. The nine keepouts, through-hole obstacles, power/current constraints and ordered USB chain are mandatory. Any needed adapter is explicit and reviewed before routing.
5. With fixed placements, run the documented router per copper layer, recording wall-clock time, route/via changes and any manual intervention. Auto-via/SI setup is a distinct phase. Compare to our router from exactly the same case and routing budget. Do not use an all-board unroute to give one side a different starting state.
6. Export final native output; refill and run native DRC, whole-seed connectivity preservation, pad-center entry quality, power widths/current arrays, USB matching/reference checks. Export/review all-layer PDF images and 5 mm same-net via clusters before presenting any accepted board result. Never overwrite original manual22 or protected best.

## Sources

- [Official CLI installation](https://docs.jitx.com/en/latest/getting-started/cli/installation.html)
- [Runtime setup and sign-in](https://docs.jitx.com/en/latest/getting-started/cli/creating-new-project.html)
- [Current device-code sign-in instructions](https://docs.jitx.com/en/latest/jumpstart-kits/js0-setup/JS0_Reference_Companion.html)
- [Topological autorouter](https://docs.jitx.com/en/latest/essentials/physical_design/autorouter.html)
- [Auto-via](https://docs.jitx.com/en/latest/user-interface/board-view/auto-via.html)
- [Local runtime/data architecture](https://docs.jitx.com/en/latest/jumpstart-kits/shared/JITX_Architecture_and_Systems_Requirements_v2_0.html)
- [Plans](https://www.jitx.com/plans) and [Free/Open conditions](https://app.jitx.com/create-account/startup)

No paid order, account registration, design sharing, publication, license modification, old-run restart or source-tree algorithm change was performed.
