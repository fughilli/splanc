# Local PnR routing laboratory

Start `python3 hardware/tools/pnr_live/server.py output/fresh-pnr-20260919/full104/live --port 8766`, then open http://127.0.0.1:8766. The server binds loopback only. The experiment does not depend on the viewer process: workers write atomic, immutable telemetry files via `pnr.live.emit`. Native board versions are copied by SHA256 before subsequent edits. All artifacts stay local.

The viewer polls every 1.2 seconds. Native KiCad extraction can add latency, particularly when many transactions finish together. Native accepted copper is solid. Provisional signal routing is dashed purple, with approximate preview width, until a native checkpoint replaces it. Geometry is exported through KiCad, not inferred from screenshots. Simplified pad shapes in the live canvas are diagnostic; native PDFs/DRC remain authoritative. Each selected layer's filled plane polygons include holes.

Choose a candidate lane, then a captured phase or live transaction. Scroll to zoom, drag to pan, hover to inspect pad identities/nets or native track widths. Green/red copper compares the current and previous native transactions. Movement arrows show the candidate's batch displacement. Cost dots show each held-out component's layered routing probes; the configuration panel colors the jointly checked Cartesian combinations and rings the sampled choices. Click a configuration to preview its moves; click an exploration lane to inspect its routing. Grey rejected configurations retain rejection reasons on hover. These are sampled configurations, not a proof that the search covers the global optimum. Air wires are a geometric MST guide across net pads, not native unconnected counts.

**Snapshots:** Pause or Draw rectangle obtains an immutable server pin and displays that exact state. Enter a note, then drag rectangles. Save structured snapshot stores a `pnr-annotated-snapshot-v1` JSON under the experiment's `live/snapshots/`, plus a download link. Rectangles carry lane, phase, native board hash, event id, note and mm-y-up bounds. The bundle contains the pinned state, iteration/phase records, evaluated costs, current geometries, view settings and annotations. For historical phase inspection it also embeds selected geometry. Resume automatically saves existing rectangles before returning to live view. Test artifacts are explicitly labeled AUTOMATED SNAPSHOT REGRESSION.

Regression: `node hardware/tools/pnr_live/test_ui.cjs STATE_JSON` exercises native canvas rendering, zoom, pin, rectangle and snapshot submission with a captured state. The HTTP smoke test must also verify snapshot pin revision/annotation round-trip on the actual server. This is not a browser visual review. Run `node --check hardware/tools/pnr_live/dist/app.js` after edits.

## Private tailnet access (2026-09-21)
The user accesses the viewer through Tailscale. Localhost alone was insufficient.
Current mini Tailscale IPv4:100.106.118.104, DNS:kevins-mac-mini-1.tail6b8ad3.ts.net.
Run with `--listen 127.0.0.1 --listen 100.106.118.104 --allow-origin http://100.106.118.104:8766 --allow-origin http://kevins-mac-mini-1:8766 --allow-origin http://kevins-mac-mini-1.tail6b8ad3.ts.net:8766` in addition to the root and port arguments. Explicit listeners preserve local access without binding every LAN interface. Tailnet clients permitted by Tailscale policy can view the state and save snapshots. No Funnel/public hosting used. Recheck the IP on another machine; do not assume localhost reaches the routing host. Page/API/pin verified through the tailnet IP locally; remote client confirmation remains separate.

## Viewer performance (2026-09-21)
The server watches event-directory mtime and only sorts unseen event filenames;
idle polls no longer scan the entire history. State responses filter unselected
geometry before deep-copying and cache serialized bytes per revision/lane.
`/api/state?since=REV&run=RUN&lane=LANE` returns a small `unchanged` response only
for the same run and revision; lane switches send since=-1. Pins still copy the
complete immutable state. Refresh an already-open page after upgrading app.js.
Measured full106 unchanged polls:163bytes/~0.6–1.2ms locally through tailnetIP,
versus857KB full response. This is not a remote-browser end-to-end benchmark.
Native pin/rectangle round-trip and UI smoke tests pass. Profiling benchmark data
is under output/geometry105/hotspot-followup. Current live root is full106/live.

Trace rendering now uses round canvas caps and joins for native/provisional copper,
so separate segments form continuous rounded junctions. Guides keep butt caps.
Current restarted run is full108/live; same viewer URL. Refresh to load updated JS.

## Runtime controls
Current live experiment:full109. Refresh the page to show Performance controls:
route workers, concurrent candidates, sampled alternatives, K and N. Requested
and active values are separate. POST /api/controls validates exact integer fields,
limits and revision; stale browser updates fail instead of overwriting newer ones.
Route pools resize at safe batch boundaries; candidate/search controls apply next
placement round. Combined route worker cap16 also respects still-active candidate
counts when reducing concurrency. Changes persist in control-history and result
metadata; new revisions reset plateau observation at the next round. Controls do
not change electrical/clearance rules. Rounding applies only to copper strokes.

## Persistent preferences and confirmed restart
Preferences live outside run folders at output/pnr-settings.json. Viewer startup
migrates an existing run's values when no preferences exist; fresh run control files
inherit saved preferences. Restart110 controller also seeds headless starts from
that file. Per-run revision/history remain separate from durable preferences.
Apply first prompts with explicit boundary/restart/cancel choices. No save occurs
until a choice. Restart means stop/archive/rerun the unfinished placement ROUND,
not merely add threads to an in-flight native transaction. Completed rounds and
snapshots remain. Power/pair phases remain serial. Restart status/error is visible.

For current full109, restart110/broker.py watches only explicit restart_epoch
increments, verifies controller PID identity, stops descendants, confirms exit,
archives unfinished rounds under interrupted/epoch-NNN, and launches restart110/run.py
against the same root. It resumes from the most recent accepted completed round;
if none exists it reruns the baseline. Each restart has a distinct telemetry lane
suffix and an audited seed104+epoch. This is resumed search, not bit-identical RNG
replay. Broker controller identity/status survive broker restart. Do not start two
brokers for the same root. Archived driver hashes are under controller-upgrades.
