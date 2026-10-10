# U18 placement and native joint routing

2026-09-11. Local, unpublished continuation of JOINT-RESULTS.md.

The new persistent checkpoint is `work/mini-routing/keyhole-u18-53/candidate.kicad_pcb`, with matching `.kicad_pro`, `fp-lib-table`, `candidate.drc.json`, `original-connectivity.json`, and `structural-validation.json`. Paths starting with `work/` are relative to the transfer root. Native KiCad 10.0.6 reports **53 opens, 11 dangling tracks, one dangling via, and no other violations**. Original manual22 remains untouched at 55 opens, 11 dangling tracks and one dangling via. This is routing progress, not completion or manufacturing signoff.

## Placement and routing result

Only U18 moved, from native (46.25,66.5) to (46.75,65.0) mm. U19 remains fixed. The modeled U18/U19 gap increased from 0.4 to 1.9 mm; conservative demand remains 4.2 mm. That demand is a heuristic, not proof of required physical spacing. The placement hard checks pass. Every original connected pad group remains connected. Two formerly missing connections closed: CC2 to C51.1, and the local A5 link between U18.7 and U18.4.

The native structural comparison verifies 141 footprints and 578 pads, unchanged net assignments, unchanged pad geometry except U18 translation, unchanged rotation/side, unchanged board drawings, four copper layers, and byte-identical project rules. All 2,034 copper items outside the explicitly modified ground/CC/auxiliary signal nets remain unchanged, including power and USB differential-pair copper. This preserves existing design state; it does not certify unfinished power or USB routing.

## Improvements taught to the pipeline

- `place_splanc_mini.py --preserve-input-placement --movable U18 --max-move-mm 2` restricts congestion refinement to the requested movable component while respecting existing fixed components.
- `keyhole_region.py` now audits native pad components with `GetConnectedItems`, including actual filled-plane islands. The former pad/track-only traversal falsely split ground connections. The native regression covers both a continuous plane and disconnected islands sharing one zone UUID; it never merges islands just because they share a zone object.
- Regional extraction records external attachment items and queries their connectivity **after copper removal**. `regional.needs_connection` omits restoration requests already satisfied by unchanged copper. Unknown or disconnected anchors remain required. This avoids trying to draw redundant full-width traces between nearby contacts on the same existing via/track island. The final native connectivity guard still applies.
- Package-local ground restoration requires preserved copper, same-package lv endpoints within 5 mm, and an existing package ground through-hole pad. It uses exact selected endpoints and existing 0.2 mm leaf width. The reviewed auxiliary-net policy includes B5, VBIAS and board.pd-1; power trunks and USB D+/D- remain outside this routing policy.
- The experiment utilities apply an authorized placement to a new board, reopen only copper directly conflicting with moved pads, and prune native-reported dangling copper with pad-connectivity, open-count and DRC guards. Every cleanup pass saves a new checkpoint. No new width or clearance exemptions were introduced.

## Failure analysis and decisive experiments

Independent restoration reached 58 opens. Targeting the actual original auxiliary-supply component (C59.1, not the originally separate U19.1 island) reduced this to 57. Native plane-aware auditing then isolated the two remaining displaced connections correctly.

Rendered native copper showed that restored CC1 and the auxiliary-supply via constrained CC2. Joint restoration of CC2, CC1 and the auxiliary supply solved the case after two conflict-resolution nodes: 57 to 56 opens. The first narrow ROI excluded an external copper attachment and correctly stopped; widening the ROI preserved that attachment. The first one-node joint budget was insufficient; the successful fixture allows 32 nodes.

On A5, the 0.1 mm grid failed. At 0.05 mm, A5 itself routed, but the transaction failed on a redundant B5 boundary repair. Removing only natively already-connected restoration obligations yielded a complete DRC-accepted transaction: 56 to 55, with B5 and VBIAS restored. Thus the failure was not proof of unroutable placement.

Additive routing then closed CC2 to C51 (55 to 54), and joint A5/B5 routing closed the local A5 gap (54 to 53). nFAULT_IN still fails: the latest joint attempt exhausted its individual search budget before completing an independent path. No provisional fault route was accepted.

## Exact replay artifacts

All following paths are under `work/splanc/hardware/experiments/tscircuit-mini/artifacts/`:

- `u18-placement-01/`: graph, rules, placement checks and channel report.
- `u18-native-01/`: initial moved board, conflicting copper manifest and cleared board (67 opens). Experimental intermediates are not best checkpoints.
- `u18-restore-01/region-008/`: ground/bias/B5 restoration to 58 opens.
- `u18-restore-02/region-001/`: auxiliary supply restored, 57 opens.
- `u18-joint-03/region-001/`: CC2 restored jointly, 56 opens.
- `u18-a5-fine-01/region-001/`: A5 routes provisionally but redundant B5 request blocks the transaction.
- `u18-a5-fine-02/region-001/`: native accepted 55-open result after the redundant-restoration fix; original pad audit passes.
- `u18-close-01/region-003/`: CC2-to-C51 closure, 54 opens.
- `u18-close-02/region-001/`: local A5 closure, 53 opens. `region-002` retains the unsuccessful nFAULT_IN case.
- `u18-prune-04`, `u18-prune-06` through `u18-prune-09`: sequential obsolete ground-stub cleanup on the improving branch. `u18-prune-09/candidate.kicad_pcb` is the exact final source copied to the persistent checkpoint. `u18-prune-10` removes nothing. Earlier cleanup trials on 55/54-open branches are not latest.
- `native-audit-control-01/region-001/`: native fine-pitch control replay, one open to zero with no new violations. Synthetic pre-existing warnings remain.

Region fixtures are in `fixtures/u18-*.json`; their generated `fixture.json` records the actual parameters for each run. The joint fine-grid A5 fixture uses 0.05 mm search pitch with unchanged 0.2 mm physical tracks and 0.151 mm conservative clearance.

## Verification and remaining work

Five Bazel targets passed: channels, keyhole, layered, joint and regional. After the restoration-filter change, regional, joint and layered tests passed again, including the new same-island/disconnected/unknown-anchor regression. Native continuous/split-plane tests and native fine-pitch replay passed. The real A5 regression passes native DRC and original-pad preservation. Source compilation and whitespace checks pass.

Continue from the persistent 53-open board. Next candidates include the saved nFAULT_IN escape failure and the original MODE/ILIM and remaining signal gaps; use bounded joint extraction and placement feedback as evidence warrants. Remaining total work is 53 native opens, 11 dangling tracks and one dangling via, then complete electrical, power, USB pair, mechanical/enclosure and pogo verification. No manufacture, publication, merge, subagents or app permission changes occurred.
