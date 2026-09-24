# Splanc Mini / tscircuit focused experiment

Local evaluation on 10 September 2026. No canonical board was replaced and no
files were published. This directory has its own package manifest, workspace,
and pinned lockfile. Original board: transfer-root `work/mini-routing/manual22.kicad_pcb`.
SHA256: `db1b927c57615ccb0f56799ff2e089b818fe29006c2fcc6363213f26384097cb`.

## Result

**Promising router, not yet a demonstrated replacement for this board's PnR.**
One isolated route passes native KiCad DRC through a conservative native adapter.
Direct KiCad conversion is not faithful, and the full-board routing trial fails
at differential-pair topology handling. No 100%-routed board was produced.

| Experiment | Measured result |
|---|---|
| Unmodified KiCad → Circuit JSON → KiCad | 141 footprints, 578 pads, 333 vias and 4 layers retained, but all 9 keepouts lost and every native pad net assignment empty. Native 0 opens is invalid as a success metric. |
| Supply missing connectivity-map metadata | Net associations restored through 534 source ports, but native output has 174 opens versus original 55; 204 clearance and 199 hole-clearance violations remain. Names are sanitized, some pad positions/drills change, and the plane loses its net. |
| MODE with existing surrounding copper | Local Pipeline 9 failed in its port-point search after 62.2 seconds. Foreign traces were conservatively represented as rotated rectangles. This is not proof the exact native geometry is unroutable. |
| MODE with fresh copper | Router reports success in 0.104 seconds; native KiCad finds one clearance violation: 0.1157 mm versus required 0.15 mm. |
| MODE with larger clearance settings | Increasing settings to 0.20 mm did not remove that violation. |
| MODE with foreign obstacle envelopes enlarged 0.05 mm per side | Success in 0.114 seconds; **native KiCad 0 violations, 0 MODE opens**. The other nets intentionally remain unrouted (410 native opens); this is a control case, not a board improvement. |
| Full board, source-compiled rules | 74 multi-pin nets, 587 pad/hole/keepout obstacles, fixed 70 × 55 mm/four-layer geometry. Reached length matching after ~206 seconds, then threw: `differential pair connection "Dpos" must resolve to exactly one final point-pair connection, got 3`. No completed native candidate. |

The initial 120-second full-board diagnostic used project widths and timed out
in detailed routing. A longer provisional run was stopped and replaced by the
source-compiled-rules trial, which includes the corrected 1.0 mm SW requirement.
Those provisional runs must not be described as full constraint validation.

## Interpretation and limits

The USB nets each have four pad endpoints: two USB-C contacts, an ESP32-C6 pad,
and an ESD-array pad. The router's differential-pair stage cannot consume those
whole branched nets directly. A faithful adapter needs explicit paired segments
and connector branches with an end-to-end skew check. Dropping pair constraints
would not satisfy the board requirements.

The native SRJ adapter preserves pin locations, layer membership, net identities,
source-compiled widths (1.5 mm power, 0.5 mm logic, 1.0 mm SW, 0.2 mm signals),
0.6/0.3 mm vias, nine keepout regions, and USB .15 mm gap/.3 mm skew metadata.
Pads and rule areas use enclosing rectangles, so this is a conservative geometric
approximation rather than an exact native shape model. The full trial models
all nets as route connections; it does not yet express the ground plane as a
separate plane-fanout stage. No placement optimization was attempted. Fixed
interfaces therefore stayed at their original positions in the native adapter.
The direct converter itself does not preserve all those properties.

The full trial reached high-density routing, simplification and DRC-repair stages,
but that is not evidence those routes pass native DRC; it threw before output.
The `AUTOROUTER_VERSION` constant reports 0.0.896 in installed package 0.0.897.
All computation used the local Pipeline 9 with no remote routing/cache service.

Recommended next bounded test: represent the USB topology explicitly, retain
native KiCad footprints/keepouts/plane intent, and retry the tscircuit router.
Only consider migrating the circuit definition after conversion fidelity and a
complete native-DRC-validated routing result are demonstrated.

## Reproduction

Dependencies are pinned in `package.json` and `pnpm-lock.yaml`. Install in this
subdirectory with `pnpm install --frozen-lockfile --ignore-scripts`. The converter
currently needs `polygon-clipping` added explicitly because it imports that
runtime dependency without declaring it. No global install is needed.

`NODE` is a Node.js executable; `KICAD_PYTHON` is KiCad's pcbnew-capable Python;
`CLI` is kicad-cli. Run from this experiment directory with the original board
and compiled rules paths provided explicitly.

```sh
"$NODE" roundtrip.mjs "$BOARD" artifacts/roundtrip
"$KICAD_PYTHON" audit_roundtrip.py "$BOARD" artifacts/roundtrip/roundtrip.kicad_pcb artifacts/roundtrip/native-fidelity.json
"$NODE" repair-import-metadata.mjs artifacts/roundtrip/import.circuit.json artifacts/roundtrip/metadata-repaired.kicad_pcb

"$KICAD_PYTHON" export_native_srj.py "$BOARD" --net MODE --out artifacts/mode.srj.json
"$NODE" run-router.mjs artifacts/mode.srj.json artifacts/mode-route 90

"$KICAD_PYTHON" export_native_srj.py "$BOARD" --fresh --rules "$RULES" --out artifacts/mini-compiled-rules.srj.json
"$NODE" run-router.mjs artifacts/mini-compiled-rules.srj.json artifacts/mini-compiled-rules-route 300
```

`import_routes.py` applies output copper onto a **new copy** of the original
native board for validation. `--fresh` removes old copper only in that copy.
Native DRC is required after every import. It refuses an existing output path.
The guarded MODE input is retained as `artifacts/mode-inflated.srj.json`; it is
`mode-fresh.srj.json` with every foreign obstacle enlarged by .1 mm in width and
height. `mode-conservative.srj.json` instead changes only clearance settings.

## Evidence

- `RESULTS.json`: compact package versions, DRC counts and whole-board failure.
- `artifacts/roundtrip/`: Circuit JSON, unmodified and metadata-repaired exports,
  native pad-by-pad fidelity reports and DRC reports.
- `artifacts/mode-inflated-native.kicad_pcb` + `.kicad_pro`: native control board.
- `artifacts/mode-inflated-native-drc.json`: zero violations, other nets unrouted.
- `artifacts/mode-result.svg(.png)`: visually inspected route diagram.
- `artifacts/mini-compiled-rules.srj.json`: complete trial input.
- `artifacts/mini-compiled-rules.log` and `mini-compiled-rules-route.report.json`:
  final failure evidence. The report was reconstructed from the captured log
  after the initial runner allowed the upstream exception to escape.

Upstream references inspected:
[tscircuit](https://github.com/tscircuit/tscircuit),
[KiCad importer](https://github.com/tscircuit/kicad-to-circuit-json),
[KiCad exporter](https://github.com/tscircuit/circuit-json-to-kicad),
[capacity autorouter](https://github.com/tscircuit/capacity-autorouter).
