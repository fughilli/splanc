# HITL gate thresholds: audit (2026-11-20)

Every timing and performance limit a HITL gate fails on, compared with what the
gate actually measures on the rigs. This answers the owner's question: where is
the acceptance limit far above the typical (p50) value, so loose that a real
regression could still pass?

**Status: proposal only.** No gate is changed by this PR. Each "tighten"
recommendation below needs owner approval first (one review-desk item per gate).

## Method

- **Data.** Every `hitl.yaml` run whose `hitl_tests` job log is still retained:
  2026-10-19 to 2026-11-20, 654 runs on all branches. GitHub keeps HITL logs for
  about 30 days. The values come from the lines each gate already prints,
  parsed by `pi/hitl/observability/metrics/legacy_extractors.py`. That is the same
  data the [HITL performance dashboard](https://splanc.grafana.net/d/hitl-performance)
  plots.
- **Statistics.** Each one is over the **main lane**: pushes to main, the merge
  queue, and the 6-hourly scheduled runs. PR branches carry work-in-progress
  failures, so they are left out. `n` counts samples, and a gate can measure several
  per run. **Limit/p50** and **limit/p95** are the headroom; for a floor (`>=`) the
  ratio is inverted to p50/limit.
- **Flag.** A gate is flagged when its headroom is **> 3× p50 or > 2× p95**.
- **New fails.** For each proposed limit, _new fails_ counts the main-lane samples
  from the window that passed the current limit but would fail the proposed one.
  CI's `--flaky_test_attempts=3` retries a failed test. So a per-run rate of x
  gives roughly x³ at the job level, if retries are independent. They are not
  independent when the cause is a slow rig.
- **Mesh and BLE rename.** These gates are not in CI yet. They run as manual
  binaries on rig-1 and on the `agent/ble-live-rename` branch. Their numbers come
  from the saved run logs under `.claude/mesh*/runs` and
  `.claude/blerename/runs`, so `n` is small.
- **Rig noise.** The main noise sources are:
  - shared 2.4 GHz airtime on the rig APs, with BLE and Wi-Fi coexistence on the
    C6;
  - the Pi 3/USB2 single bus on rig-3 (fenced out of CI);
  - ssh and tunnel jitter between the GitHub runner and the rig, over the tailnet;
  - queueing while 3 merge-queue runs share 2 rigs.

## Summary table

Units are as shown. Rows marked ⚑ are flagged as slack. Rows marked ⚠ are
**tight**: their p95 or max is near the limit, which is a flake risk rather than
hidden slack.

| Gate · threshold (where)                                                                         | Limit                           | n (main)   | p50              | p95           | max             | limit/p50  | limit/p95  | Flag              | Recommendation                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------- | ---------- | ---------------- | ------------- | --------------- | ---------- | ---------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ble_rename · rename → new name seen (`hitl_ble_rename.py --budget`)                              | 5 s                             | 3 / phase  | adv 0.57         | conn 4.38     | conn 4.84       | adv 8.8×   | conn 1.1×  | ⚑ adv / ⚠ conn   | **Keep 5 s** (owner decision). Now on the dashboard (`ble_rename.name_seen_latency.{adv,conn,final}`). Connected-phase samples reach 4.84 s, so tightening is unsafe until CI has ~50 runs.                                                   |
| live_latency · live p50 ≤ 1 frame + 50 ms (`live_latency_core.verdict_lan`)                      | 95 ms @45 ms frame              | 240        | 60.5 ms          | 131 ms        | (fail)          | 1.57×      | 0.73×      | ⚠                | Keep. Its p95 sits above the limit because the tail is the 10-27 Oct regression episode; drift is visible on the chart.                                                                                                                       |
| live_latency · live p99 ≤ 3 frames + 120 ms                                                      | 256 ms                          | 240        | 140 ms           | 319 ms        | (fail)          | 1.83×      | 0.80×      | ⚠                | Keep.                                                                                                                                                                                                                                         |
| live_latency · osc p50 / p99 (same budgets)                                                      | 95 / 256 ms                     | 172        | 37 / 84 ms       | 41 / 127 ms   | (fail)          | 2.6 / 3.0× | 2.3 / 2.0× | ⚑                 | **Tighten** to an OSC-specific p50 ≤ 60 ms and p99 ≤ 200 ms. New fails: 0/172 and 1/172. OSC has no frame-paced mailbox, so the live-sender frame budget does not apply to it.                                                                |
| video_latency · lat p99 (`video_latency_core` :359)                                              | 2000 ms                         | 219        | 28.9 ms          | 71.8 ms       | 86.8 s (fail)   | 69×        | 28×        | ⚑                 | **Tighten** to 500 ms. New fails: 1/219 (1706 ms). The code says "defaults are deliberately loose". Note the negative p50s on a few runs (clock-map failures); worth a sanity check.                                                          |
| video_latency · stalls/min (`:360`)                                                              | 1e9 (off)                       | 220        | 0                | 9             | 594             | —          | —          | ⚑                 | Keep it off, with a **trend alert** on stalls.                                                                                                                                                                                                |
| video_stream · fps ≥ `--min-fps` (`hitl_video_stream.py`)                                        | ≥ 10 fps                        | 275        | 59.8             | p5 34.3       | min 8.1 (fail)  | 6.0×       | —          | ⚑                 | **Trend alert**, or tighten to ≥ 20 fps (0 new fails). ≥ 30 fps would add 6/275 fails (20.7-29.8 fps), which is rig airtime noise.                                                                                                            |
| rejoin_loop · per-boot lease (`--window`)                                                        | 40 s                            | 6719 boots | 7.3 s            | 8.5 s         | 16.2 s          | 5.5×       | 4.7×       | ⚑                 | **Tighten** to 25 s: 0 new fails. The window only has to catch a stuck boot.                                                                                                                                                                  |
| rejoin_loop · p95 time-to-lease (`--p95-limit`)                                                  | 20 s                            | 217 runs   | 8.3 s            | 10.4 s        | 13.1 s          | 2.4×       | 1.9×       | (border)          | **Tighten** to 14 s: 0 new fails. This is the regression signal for the rejoin path, so add a p50 drift alert too.                                                                                                                            |
| ota_gate · handoff (`ota_core` :177)                                                             | 120 s                           | 242        | 17.8 s           | 20.7 s        | 46.8 s          | 6.8×       | 5.8×       | ⚑                 | **Tighten** to 60 s: 0 new fails.                                                                                                                                                                                                             |
| ota_gate · ota_finish (`:270`)                                                                   | 60 s                            | 242        | 0.69 s           | 0.74 s        | 1.02 s          | 87×        | 81×        | ⚑                 | **Tighten** to 10 s: 0 new fails. A slow finish means a slow flash commit, which should fail loudly.                                                                                                                                          |
| ota_gate · healthy after install (`:178`; crash/unhealthy phases 300 s)                          | 240 / 300 s                     | 242        | 23.9 s           | 26.4 s        | 40.9 s          | 10×        | 9×         | ⚑                 | **Tighten** the ok-path phases to 90 s: 0 new fails. Keep 300 s for the rollback phases, whose time is mostly the deliberate crash loop.                                                                                                      |
| ota_gate · resumes (`:179`)                                                                      | ≤ 8                             | 227        | 0 (powercut 1)   | 1             | 8 (powercut)    | —          | —          | ⚠ powercut       | Keep. The powercut phase once used all 8 resumes; watch it on the dashboard.                                                                                                                                                                  |
| no_reboot_no_park · control p50 / max (`no_reboot_no_park_core` :52-53)                          | 3 s / 15 s                      | 210        | 0.16 / 0.23 s    | 0.20 / 0.44 s | 0.27 / 3.3 s    | 19× / 66×  | 15× / 34×  | ⚑                 | **Tighten** p50 to 1 s and max to 5 s: 0 new fails. The owner rule "lag > cut-out" is about _not parking_, which a 5 s max still allows.                                                                                                      |
| no_reboot_no_park · slow-effect fps (`:51`)                                                      | ≥ 1 fps                         | 210        | 5.28             | 5.47          | —               | 5.3×       | —          | ⚑                 | Keep. The floor proves the effect is not parked, not its speed, so add a trend alert instead.                                                                                                                                                 |
| heavy_effect_reachability · handshake (`core` :43)                                               | 8 s                             | 897        | 1.75 s           | 3.06 s        | 6.4 s           | 4.6×       | 2.6×       | ⚑                 | Keep, plus a **trend alert**. Handshakes on a 93%-duty heavy effect reach 6.4 s under load, and 5 s would add 4/897 fails.                                                                                                                    |
| heavy_effect_reachability · rejoin / boot first OK (`:58`)                                       | 60 s                            | 178        | 22.7 / 19.3 s    | 24.7 / 26.2 s | 30.2 / 51.1 s   | 2.6 / 3.1× | 2.4 / 2.3× | (border)          | Keep. The boot phase has a 51 s outlier: a Wi-Fi rejoin plus a TLS handshake on a busy core.                                                                                                                                                  |
| map_upload · bulk chunk p90 (`map_upload_core` :145)                                             | 1000 ms                         | 213        | 172 ms           | 226 ms        | 343 ms          | 5.8×       | 4.4×       | ⚑                 | **Tighten** to 500 ms: 0 new fails. The code comment calls 1 s "coarse".                                                                                                                                                                      |
| map_upload · chunk silence (`:141`)                                                              | 5 s                             | 213 (max)  | 246 ms           | 445 ms        | 1.04 s          | 20×        | 11×        | ⚑                 | Keep. This is the DEVICE SILENT detector, a liveness check, not a latency check.                                                                                                                                                              |
| wifi_cadence · light-load frame-period excursion (`wifi_cadence_core` :35-37; `max(3000 µs, …)`) | 3000 µs                         | ~200/phase | 480-600 µs       | 740-820 µs    | 970 µs (passes) | 5-6×       | 3.7-4×     | ⚑                 | **Tighten** the absolute floor to 1500 µs for the light load: 0 new fails across the 7 phases. The heavy load keeps its baseline-derived limit.                                                                                               |
| wifi_cadence · heavy-load excursion (`1.5 × steady p99.9`)                                       | ≈ 3670 µs                       | ~199/phase | 1150-1290 µs     | 2500-2930 µs  | 3613 µs         | 3×         | 1.3×       | ⚠                | Keep. The max is 98% of the limit, so this is a flake risk. Watch the dashboard.                                                                                                                                                              |
| tls_churn · final-round wss recovery (`--recover-window`)                                        | 40 s                            | 825        | 2.2 s            | 3.3 s         | 8.1 s           | 18×        | 12×        | ⚑                 | **Tighten** to 15 s: 0 new fails.                                                                                                                                                                                                             |
| loaded_tls · wss recovery (`--recover-window`)                                                   | 40 s                            | 816        | 2.8 s            | 4.7 s         | 27.9 s          | 14×        | 8.5×       | ⚑                 | Keep 40 s plus a **p95 trend alert**. 15 s would add 1/816 fails (27.9 s), the rare slow round on the loaded heap.                                                                                                                            |
| e2e · time-sync RTT plausibility (`sync.py` :38)                                                 | 2000 ms                         | 271        | 51 ms            | 85 ms         | 297 ms          | 39×        | 23×        | ⚑                 | Keep. It is a sanity bound (implausible sample), not a performance gate. The value is now trended.                                                                                                                                            |
| stable_identity · second client refused (`core` :176)                                            | 5 s                             | 239        | 0.01 s           | 0.01 s        | 1.04 s          | 500×       | 500×       | ⚑                 | Keep. It separates "refused" from "hung", and the 1.04 s max shows a 1 s limit would flake.                                                                                                                                                   |
| preconnect · socket steps (`preconnect_probe.py` :256)                                           | 15 s                            | 372        | 0.73 s           | 1.51 s        | 2.98 s          | 21×        | 10×        | ⚑                 | Keep. It is a hang detector (a socket timeout), so add a **trend alert** on `fresh_dial`.                                                                                                                                                     |
| ble_capture_e2e · reply per request (`hitl_ble_player.py` :132)                                  | 40 s                            | 264-792    | 200-320 ms       | 0.9-2.2 s     | 7.8 s (stage)   | 120-290×   | 18-45×     | ⚑                 | **Add a soft limit of 10 s** (0 new fails) plus a trend alert on p95/max. The stage p95 of 2.2 s and max of 7.8 s are the D-75 "~2 s notify delay" (see below).                                                                               |
| ble_player_e2e · reply per frame (`--timeout`)                                                   | 40 s                            | —          | not logged       | —             | —               | —          | —          | (no data)         | Instrumented in this PR (`ble_player_e2e.ble_request_rtt`). Decide once there is data.                                                                                                                                                        |
| improv_fresh_join · same-creds join (`--join-budget`)                                            | 20 s from write ack             | 192        | wall 15-16 s     | wall 33-66 s  | wall 173 s      | n/a        | n/a        | ⚠ (unmeasurable) | Keep. Only the provisioner **wall time** (scan + connect + join) is logged, and the budget runs from the write ack. The improvflake agent is adding `join_latency` from the write ack.                                                        |
| improv_fresh_join · absent → UNABLE_TO_CONNECT (`--absent-budget`)                               | 45 s from write ack             | 193        | wall 47.3 s      | wall 64 s     | wall 115 s      | ~1.4× ¹    | —          | ⚠                | Keep (it is the app's timeout). By design the firmware reports at about 33 s, or about 31 s with improvflake's fix3, so the headroom is about 1.4×. It is tight, not slack.                                                                   |
| provisioning · Improv per attempt (`provision.py`, 60 s × 3 attempts; fx_bench 75 s × 4)         | 60 s                            | —          | proxy: wall 15 s | —             | —               | ~4×        | —          | ⚑ (proxy)         | Keep. FUG-94 BLE connect retries need the slack. It is instrumented in this PR (`provision.improv_*_wall_time`, `improv_attempts`), so attempts > 1 become visible.                                                                           |
| fx_bench · frame within ±margin of golden (`device-bench-*.json`)                                | ±10% (sweep16 ±15%, ±8 k floor) | 7313       | \|dev\| 1.0%     | 2.65%         | 9.4% (empty)    | 10×        | 3.8×       | ⚑ / ⚠ sweep16    | Keep. The margin absorbs golden churn across releases, and the fx_bench dashboards already trend drift. sweep16 is the opposite problem: p95 15.3% against ±15%, saved only by the floor, so re-golden it.                                    |
| mesh_smoke · formation (`mesh_smoke_core` :17)                                                   | 15 s                            | 18 (local) | 6.2 s            | 6.6 s         | 6.8 s           | 2.4×       | 2.3×       | (border)          | Keep. The n is too small. Decide after it is in CI; formation includes the 5 s member-advert interval.                                                                                                                                        |
| mesh_smoke · rejoin (`:19`)                                                                      | 45 s                            | 6 (local)  | 6.1 s            | 11.1 s        | 12.6 s          | 7.4×       | 4×         | ⚑                 | Revisit with CI data. 20 s would pass every saved run.                                                                                                                                                                                        |
| mesh_apply_at_skew / mesh_gateway · skew max (`GATE_MS`)                                         | < 10 ms                         | 9 (local)  | 1.3-1.7 ms       | 1.6-2.0 ms    | 2.0 ms          | 6-8×       | 5-6×       | ⚑                 | **Trend alert** on `skew_max`. The 10 ms limit is the human-visible bound (one 80 fps frame is 12.5 ms), so it is a product requirement, not rig slack. Also: the phase lines are cut at 1500/1800 chars, which drops `skew` for some phases. |

¹ This is the firmware's designed report time (about 33 s) against the 45 s budget.
The log cannot show the true value, because `wall_s` adds about 14 s of BLE scan and
connect.

## Flagged gates, grouped by recommendation

**Tighten** (proposed values; the new-fail count is over 30 days of main):

| Gate · threshold                       | Now         | Proposed    | New fails (main)  |
| -------------------------------------- | ----------- | ----------- | ----------------- |
| video_latency p99                      | 2000 ms     | 500 ms      | 1 / 219           |
| live_latency OSC p50 / p99             | 95 / 256 ms | 60 / 200 ms | 0 / 172 · 1 / 172 |
| rejoin_loop per-boot window            | 40 s        | 25 s        | 0 / 6719          |
| rejoin_loop p95                        | 20 s        | 14 s        | 0 / 217           |
| ota_gate handoff                       | 120 s       | 60 s        | 0 / 242           |
| ota_gate finish                        | 60 s        | 10 s        | 0 / 242           |
| ota_gate healthy (ok-path phases)      | 240 s       | 90 s        | 0 / 688           |
| no_reboot_no_park control p50 / max    | 3 s / 15 s  | 1 s / 5 s   | 0 / 210           |
| map_upload bulk p90                    | 1000 ms     | 500 ms      | 0 / 213           |
| wifi_cadence light floor               | 3000 µs     | 1500 µs     | 0 / ~1400         |
| tls_churn recovery                     | 40 s        | 15 s        | 0 / 825           |
| video_stream fps floor                 | 10 fps      | 20 fps      | 0 / 275           |
| ble_capture_e2e per request (new soft) | 40 s        | 10 s        | 0 / 1452          |

Each of these would have changed no main-lane verdict in the window, apart from
the three samples listed. The expected flake added per run is ≤ 0.5% before
retries.

**Keep the loose pass/fail, add a trend alert** (p50 drift vs the 30-day
baseline; the dashboard's `p50 drift %` column computes it already):

- loaded_tls recovery: the rare 28 s slow round on the loaded heap.
- heavy_effect_reachability handshake: it reaches 6.4 s on a 93%-duty core.
- preconnect fresh dial and video_latency stalls: hang detectors.
- no_reboot_no_park slow fps: it proves the effect is not parked, not its speed.
- e2e time-sync RTT: a sanity bound.
- fx_bench: already trended by the fx_bench dashboards.
- mesh skew: a product-level bound.

The alerts need a Grafana alert rule on the Infinity summary asset, or a CI check
in the ingest workflow that fails on drift > 25%. The Editor token used here can
create neither, so this needs an owner decision.

**Keep as-is (justified):**

- ble_rename 5 s (owner).
- stable_identity 5 s: a "refused vs hung" discriminator, with a 1.04 s max.
- map_upload 5 s silence: a liveness check.
- ota resumes ≤ 8.
- Improv budgets: they match the app's timeouts.
- Provisioning 60 s × 3: FUG-94 BLE connect flake.
- heavy rejoin/boot 60 s.

**Tight (flake risk, the opposite of slack):**

- wifi_cadence heavy load: max at 98% of the limit.
- live_latency live: its p95 sits over the limit in the October regression window.
- improv_fresh_join absent: about 1.4×.
- fx_bench sweep16: p95 at the margin, so re-golden it.
- ble_rename connected rename: 4.84 s of 5 s in 1 of 3 local runs.

## BLE notify latency (desk D-75)

`ble_capture_e2e` already logs the BLE request→notification round trip per request.
The "~2 s" delay shows clearly in the 30 days of CI data:

- stage requests: p50 324 ms, **p95 2.2 s**, max 7.8 s.
- timing requests: p95 1.5 s, max 4.4 s.
- hello requests: p95 212 ms.

The slow tail is on requests that make the firmware change what it renders
(`stage`, `timing`, `stop`), not on `hello`/`start`. That points at the firmware's
reply path more than the radio link, but the logs can't separate the two. It is now a
dashboard series: `ble_capture_e2e.ble_request_rtt.<kind>`, and
`ble_player_e2e.ble_request_rtt` from this PR. The improvflake agent's planned
firmware-send→central-receive metric (`ble_notify_latency`) will split the delay
between the link and the firmware.

## Not measured: limits whose value never reaches the log

These gates fail on a time that is never printed, so they can't be audited from
CI. Each needs a `hitl_metrics.emit()` at the listed site; these are follow-ups.

- osc_deck_follow: OSC applied ≤ 3 s, `hitl_osc_deck_follow.py:169`.
- kiosk: revert `dt` (printed only on failure, `hitl_kiosk.py:338`); activity
  push ≤ 5 s (`:291`).
- wide_uniforms: 0.5 s apply.
- fx_debug: resume and advance checks.
- upgrade_keeps_wifi: lease within 45 s.
- stable_identity: pong and mDNS latency.
- no_reboot_no_park: rejoin ≤ 90 s.
- ota_gate: back-in-app ≤ 120 s (badsig, keyrot).
- hitl_ws: connect, cert and manifest settle times (90 s each).
- web_ota_journey: `web_seconds` (900 s).
- improv_fresh_join: the dead `join_s` check (`improv_fresh_join_core.py:158`).
  Nothing sets `join_s`, so the budget check there never fires; the real limit is
  the provisioner's timeout.

## Reproducing

```bash
# mirror the retained hitl_tests logs, parse, summarise (no upload):
python3 pi/hitl/observability/metrics/ingest_hitl_metrics.py \
  --log-dir <dir with <run>.log.gz + runs.json> --out /tmp/hm --force
# or straight from the API (what CI runs every 3 h):
python3 pi/hitl/observability/metrics/ingest_hitl_metrics.py --max-pages 20
```

`hitl-metrics-summary.json` holds the n / p50 / p95 / max / limit / headroom per
series, lane and rig (or rig/DUT) behind this table.
