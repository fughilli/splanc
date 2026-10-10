# User-flagged three-pad / six-via pattern

Checked unchanged keyhole-via-53 board (the source of September 13 PDF).
U5.5 = power_good; U5.6 = nCC; U5.7 = lv. U5.7 has one direct F.Cu
via branch. These three pads are not a single plane net in this checkpoint.

The nearby Q2.1, Q2.2, Q2.3 ground pads collectively contact six distinct
PCB vias, all with F.Cu track contacts only. No In2/B track port explains these
six vias. One via contacts several surface tracks, so this is not six independent
single-track leaves. Q2 appeared in the original 2 mm scan (cluster-021) and
was explicitly deferred for power-return capacity review. That deferral never
established whether six vias were warranted. It remains unresolved.

Root limitation: reviewed cleanup handles selected same-pad leaves, not the
whole surface-connected pad group. Global plane connectivity does not justify
one via per pad or per run; nor does it establish an adequate via count for
current. Future cleanup needs a local surface-copper component model, required
layer ports and explicit current/thermal capacity policy. It must rank redundant
fanouts even when they touch multiple tracks, instead of silently skipping them.
The 5 mm follow-up inspected selected new pairs and did not resolve this known
cluster. No additional board edits or claims of complete board-wide cleanup.

Native evidence: artifacts/u5-native-inspection.txt and q2-native-inspection.txt.
Diagnostic U5 four-layer drawing: artifacts/u5-all.svg (zones omitted).
