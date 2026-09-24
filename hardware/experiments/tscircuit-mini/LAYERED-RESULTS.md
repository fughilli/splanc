# Layered regional repair: implementation and native experiments

2026-09-10. Extends the surface-only work in REGIONAL-RESULTS.md. Local and unpublished; no production checkpoint has been replaced.

## Implemented

`pnr/route/detail/layered.py` adds explicit layer states and through-via transitions to the regional solver. It first tries surface routing, then decomposes the problem into reachable surface escape ports and an alternate-layer connection, then falls back to bounded weighted A*. It keeps exact terminal attachments, checks every segment through the geometry adapter, and relaxes geometry only within a layer. Hole spacing applies even to same-net vias; through-vias obstruct every copper layer.

Regional retries can change request order, force an earlier blocking path onto another layer, and exclude a neighborhood around a previously chosen via. All affected connections must be restored before any candidate is written. Partial paths in result JSON are diagnostic only. Explicit source-via windows support controlled topology experiments; they are fixture inputs, not board coordinates embedded in the generic router.

`hardware/tools/keyhole_region.py --layers --relocate-vias` reopens only eligible selected signal copper wholly inside the region, including selected unlocked 0.6/0.3 mm through-vias. The native adapter discovers external anchors and their actual access layers. New tracks use F.Cu, In2.Cu or B.Cu; In1 ground-plane routing is excluded, but via copper/hole checks cover every layer. It checks native pad/track shapes, holes, keepouts and board-edge clearance; it rejects new SMD via-in-pad. Plane fills are rebuilt for native DRC.

Power, USB, footprints and external contacts remain immutable in regional repair. The separate explicit `keyhole_shift_via.py` experiment can move one identified via while preserving attached widths and external contacts. It requires native nonregression and limits displacement and added lead length. It is not a general power-layout optimizer.

`keyhole_loop.py --region` passes layered routing, selected-via relocation and optional `source_via_windows` through to the native stage. Acceptance still requires fewer global native opens, preservation of prior pad connectivity, no new native violation identities and no increase in dangling copper.

## Results

All artifact paths below are relative to `hardware/experiments/tscircuit-mini/artifacts/`. These ignored directories retain exact native inputs, project rules, fixture data and results.

| Experiment | Result |
| --- | --- |
| `layered-mode-relocate-02` on keyhole42 | 24 bounded trials; at most one of three obligations restored. No candidate accepted. |
| `layered-scl-01` on keyhole42 | No complete repair; no legal scl via among 917 checked sites in this search. This is not an exhaustive geometric proof. |
| `layered-manual22-mode-01` | Eight orders, at most one of two obligations restored. No improvement to the 55-open fallback. |
| `layered-manual22-a5-01`, `layered-manual22-fault-01` | No complete repair within the selected regions/search limits. |
| `vcc-shift-10/candidate-clean.kicad_pcb` and `.kicad_pro` | Native nonregressing precursor only: 70 opens, 42 dangling tracks, two dangling vias, zero other violations. |
| `vcc-shift-mode-ports-loop/region-001` | Escape-port decomposition tried 24 regional alternatives on the precursor; at most one of three obligations restored. No accepted repair. |
| `vcc-shift-mode-directed-01` | Explicit upper ILIM escape window; interrupted after more than ten minutes of CPU-active search without a complete result. Baseline, fixture and `interruption.json` preserved; no candidate written. This is a runtime-limited failure, not a proof of unroutability. |
| `layered-control-ports-loop/region-001/candidate.kicad_pcb` and `.kicad_pro` | Synthetic layer-crossing control accepted: one open to zero, two new vias, prior pad connectivity preserved, no new native violations. Existing two silk-over-copper reports and one dangling obstacle track remain. This is not the Mini board. |

The VCC precursor moves via UUID `0e970d96-c461-4936-b1b6-85e1fe347750` from (72.1898,43.7872) to (72.9898,43.7872) mm. Attached F/B tracks retain their original 0.2 mm widths; total rebuilt lead length grows from 5.0522 to 6.5657 mm. A newly exposed redundant 0.1269 mm VCC stub is removed only after native DRC identifies it, followed by another connectivity/DRC check. Native nonregression does not establish power-loop suitability. Keep this candidate experimental until a complete beneficial transaction and electrical review justify it.

Visual inspection and via-site diagnostics motivated this shift: the fixed VCC via restricts ILIM's upper escape and encourages paths through MODE's escape area. Opening more legal via sites did not by itself solve the competing topology. The remaining problem is joint selection of escape corridors, not simply finding any legal via.

## Replay

Tracked region specs: `fixtures/mode-ilim-layered.json`, `fixtures/sda-scl-layered.json`, and `fixtures/mode-ilim-directed.json`. The directed fixture constrains ILIM's source via to the upper escape window and is intended for the VCC precursor above. Native coordinates are used throughout these files.

From the repository, using a fresh output directory:

```sh
python3 hardware/tools/keyhole_loop.py ../mini-routing/keyhole42/candidate-001.kicad_pcb \
  --out-dir /tmp/mini-layered-replay \
  --region hardware/experiments/tscircuit-mini/fixtures/mode-ilim-layered.json \
  --rounds 1 \
  --kicad-python /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
  --kicad-cli /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
```

`make_layer_control.py --project PROJECT.kicad_pro --out-dir NEW_DIR`, run with native KiCad Python, generates the isolated four-layer wall-crossing control and its region JSON. Run that region through the same loop. The control is deliberately small and is not evidence of whole-board routing capability.

## Verification and limits

Nine layered unit tests pass, covering checked two-via bridges, existing inner-layer access, forced layer alternatives, transition budgets, source escape windows, crossing nets, all-layer via obstacles, same-net hole spacing and blocked via access. Bazel `layered_test`, `regional_test` and `keyhole_test` pass. The native control passes KiCad 10.0.6 connectivity and DRC acceptance. A final replay at `artifacts/layered-control-final-loop/region-001` also passes after adding per-request `search-events.jsonl` diagnostics; the file records attempt, request, search status, expansion count and observed blockers.

Search is heuristic, not complete or optimal. An overall wall-time budget is still needed; per-request progress logging now helps identify slow searches, but the interrupted directed trial started before that logging addition. Budgets apply per maze stage and per regional trial, rather than to aggregate runtime. Surface ports are sampled to at most 32 spatially distributed sites; at most two layer transitions are considered. Through-via geometry uses the Mini's 0.6/0.3 mm policy. Multi-net escape topology planning, directional placement changes and whole-bundle geometry relaxation remain unfinished. No claim of 100% routing is made.

Latest accepted placement candidate remains `work/mini-routing/keyhole42/candidate-001.kicad_pcb` plus project (70 opens). The better connectivity fallback remains immutable `work/mini-routing/manual22.kicad_pcb` plus project (55 opens). The original manual22 PCB/project hashes were verified unchanged. Full routing, dangling cleanup, native clearance/short checks and electrical/mechanical/interface validation remain required.

## Subsequent work

See [JOINT-RESULTS.md](JOINT-RESULTS.md) for joint conflict negotiation, cooperative time limits, native-query caching, three-via connectors, bottom-layer access, exact-axis lead-outs and corrected shared-net placement demand. It supersedes the two-transition and missing overall-search-budget limitations above.
