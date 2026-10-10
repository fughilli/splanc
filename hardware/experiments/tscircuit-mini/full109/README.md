# Controllable parallel PnR
Full109 supersedes user-requested108restart to add live settings without editing
frozen code.611inputs frozen; same source placement/seed104, full electrical
pipeline, Rust kernel+profiles+geometric cleanup. Current defaults routeworkers2,
candidateworkers2,samples4,K4,N4. Controls stored live/control.json, history under
live/control-history, controller acknowledgements and per-lane worker settings in
telemetry. Round result.json includes starting controls. Mixed-round live worker
changes are identifiable from timestamped worker_config_applied events.

UI route_workers1..8; candidate_workers1..4;samples1..16;K2..12;N2..8. Combined
route worker cap16. Requested candidate changes apply next placement round;
routeworkers update persistent process pools at grid negotiation batch boundaries
and native routing batch/sweep boundaries. Existing work completes beforeresize.
If active candidate count exceeds newly requested count, routeworkers clamp to
16/current_candidate_workers until the next round. Coupled pair/power/rip-up
transactions remain serial. Other search controls apply next round; any new
control revision resets the plateau observation schedule at that boundary.
Invalid/stale writes rejected; API origin restrictions unchanged. Geometry rules,
clearances and electrical requirements are not editable through these controls.

Tests:11maze regressions and4realboard acceptance tests PASS in parallel107;
3speculative scheduler/delta tests PASS; native disjoint fusion2->1->0opens/0DRC,
crossing rejected. Fixed read-only UUID, via layer API, and overloaded constructor
hazards with explicit native geometry copying+signature checks. New2control tests
PASS including real pool resizing1->2->1, active-candidate cap, invalid/stale
updates. ActualHTTP persistence/bounds/stale checks and UI snapshot smokePASS.
No end-to-end speedup or fully routed board claimed. PDF/5mmscan watcher runs per
completed round; actual image review remains mandatory. Native merge fixture
output/parallel107/merge-fixture; acceptance log/private/tmp/parallel107-detail-tests.log.
