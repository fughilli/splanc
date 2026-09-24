# Regional routing implementation and experiments

Implemented 2026-09-10, following ALGORITHM-REVIEW.md. No publication or production checkpoint replacement.

## Incorporated into our engine

- `pnr/route/detail/regional.py`: bounded multi-net route-order search, conflict-directed retries, actual width/clearance checks between provisional routes, reservation of pending singleton terminals, and all-or-nothing results. Uses the existing segment-checked octilinear router and shortcut relaxation.
- `hardware/tools/keyhole_region.py`: native single-layer adapter. Reopens selected signal copper wholly inside a region, discovers its external copper contacts using native connectivity/shapes, and constructs obligations to restore all contacts. An isolated loop/stub without sufficient external anchors stays unchanged. Internal tree geometry may change; external contacts stay fixed. Existing vias, nonselected layers, power/USB traces and footprints stay immutable.
- Acceptance checks native global DRC/unconnected items and preserves previously connected pad groups. Fewer total opens cannot justify sacrificing another existing pad connection.
- `hardware/tools/keyhole_loop.py --region FILE`: runs regional repair after additive attempts. An accepted transaction becomes the next input; reopening copper invalidates the additive failure cache. Each candidate, project, baseline, fixture, native report and diagnostic log has a separate path.
- `escape.trapped_access_sites` and `route.feedback.detail_congestion`: detailed PnR now supplies localized static escape observations to placement inflation. Only a bounded, exhausted grid neighborhood is reported. An open boundary, possible through-via, or budget exhaustion is inconclusive. Other failures retain the existing bounding-box fallback. This is a placement heuristic; it is not directional displacement optimization or a native proof of channel capacity.

The regional stage is opt-in, bounded and currently F.Cu only. This is not a port of tscircuit's complete capacity mesh, a multilayer joint solver, or a replacement for the full placer. Parallel bundle relaxation beyond the existing shortcut/alignment primitives remains future work.

## Native experiments

All real-board experiments started from `work/mini-routing/keyhole42/candidate-001.kicad_pcb` (70 native unconnected items), preserving the immutable manual22 fallback (55).

| Fixture | Result | Interpretation |
| --- | --- | --- |
| MODE/ILIM, 0.1 mm grid | No complete transaction; 25 segments selected, four obligations, two route orders attempted | Either signal can consume the corridor and prevent the other from completing. Partial success is discarded. |
| MODE/ILIM, 0.05 mm grid, larger region | Same incomplete result | Finer grid alone did not fix the competing topology. |
| SDA/SCL between U7 and U10 | No complete transaction; ten segments selected, six obligations | Missing connection fails terminal escape before useful order negotiation. |
| Isolated MODE control, through `keyhole_loop --region` | Accepted within the control: 411 → 410 native opens, zero violations, existing pad connectivity preserved | Validates routing, native writeback and loop/gate integration. This control intentionally has almost all other copper absent and is not board-routing progress. |

Outputs under `artifacts/regional-mode-01`, `regional-mode-02`, `regional-scl-01`, and `regional-control-loop/region-001`. Each native fixture directory includes the exact baseline PCB/project and `fixture.json`; these local artifacts are ignored by Git. Region specifications are tracked under `fixtures/`.

Visual inspection of `artifacts/regional-mode-02/fixture.svg` confirms that the ILIM diagonal and its fixed via separate the MODE pad from its resistor through a narrow area bordered by feedback copper. The new solver currently cannot relocate that via or jointly change layers. A next useful extension is bounded via-access/layer alternatives within the same transaction, preserving external connectivity. The image supports that hypothesis, not a proof that no surface solution exists.

## Reproduce through the repair loop

Run from the repository with a KiCad-compatible Python and CLI:

```sh
python3 hardware/tools/keyhole_loop.py ../mini-routing/keyhole42/candidate-001.kicad_pcb \
  --out-dir /tmp/splanc-regional-replay \
  --region hardware/experiments/tscircuit-mini/fixtures/mode-ilim.json \
  --region hardware/experiments/tscircuit-mini/fixtures/sda-scl.json \
  --rounds 1 \
  --kicad-python /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
  --kicad-cli /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
```

The output directory must not exist. Bounds use native KiCad coordinates; placement failure sites use engine coordinates. The two frames are deliberately not mixed.

## Verification

New unit cases cover order-dependent two-net routing, finite-width spacing, complete rollback, pending terminal reservation, same-net branches, segment intersections, preservation of old connectivity, localized escape feedback, inconclusive searches, possible via escapes, and coordinate-frame validation. Native control additionally exercises the subprocess pipeline and DRC gate. All six affected Bazel targets passed: regional_test, keyhole_test, local_feedback_test, detail_escape_test, detail_route_test, and route_feedback_test. The two affected fast targets passed again after the final edge-cell localization fix. Source compilation and git diff --check also passed.

## Subsequent extension

The surface-only limitations above describe the initial implementation. See [LAYERED-RESULTS.md](LAYERED-RESULTS.md) for the subsequent layered regional solver, via relocation, escape-port decomposition, native control and unresolved real-board experiments.
