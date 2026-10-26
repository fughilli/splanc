# HITL capacity model: should I buy more boards?

One number per capability pool, on the `hitl-capacity` Grafana dashboard:

> **board deficit = boards required to meet the wait SLO − healthy boards installed**

Above 0 means buy that many boards of that kind; at or below 0 the bench copes. Queue
depth can't answer this question: a deep queue can come from one burst, from a
scheduling mistake, or from a concurrency cap, and none of those is fixed by buying
hardware. The model separates demand (what the hardware has to do) from supply (boards
that are installed and healthy) and sizes the pool for the peak.

## Pools

| pool                        | boards (supply `caps_class`) | requests it serves (demand `caps_class`)       |
| --------------------------- | ---------------------------- | ---------------------------------------------- |
| `c6` ESP32-C6               | `c6` + `c6-la`               | `c6` + `c6-la`                                 |
| `c6-la` C6 + logic analyzer | `c6-la` (rig-2's tapped C6s) | `c6-la`, plus its share of plain `c6` requests |
| `pi` led-mapper Pi          | `pi` + `pi-la`               | `pi` + `pi-la`                                 |
| `pi-la` Pi + FPGA/LA        | `pi-la` (pi-ledmapper-1)     | `pi-la`, plus its share of plain `pi` requests |

A child pool (`-la`) is a special subset of its parent's boards. The scheduler doesn't
hold special boards back, so a child pool also absorbs the parent's plain requests in
proportion to its share of the parent's boards (`Config.child_spill`). A child deficit is
bought as that special board. The parent then reports only the plain-board shortfall
left after that purchase, so summing the positive deficits gives the total to buy. The
labels match the hitl-reserved capacity metrics (`hitl_unit_*` / `hitl_reservation_*`,
see below).

## The model (`erlang.py`, `capacity_model.py`)

For each pool, over a rolling **7-day window**:

- **Demand.** The effective arrival rate is served requests plus requests that **timed
  out in the queue and were not retried** (unserved demand). A request abandoned after
  at least 30 min (`timeout_s`) gave up waiting. A request that left sooner was
  withdrawn, for example because its run was cancelled or superseded, and it is not
  demand. A timeout that the same owner re-requested within 2 min is the bazel/harness
  retry, so it is the same demand and is counted once. Demand board-hours = served hold
  time + unserved × mean hold.
- **Peak.** λ is the **p90 of the hourly arrival rates**, not the mean, because HITL
  load comes in bursts (a CI suite fires every test at once).
- **Hold.** 1/μ is the mean hold of served requests, including wasted holds such as
  lease expiries. Removing waste lowers demand.
- **Supply.** Healthy boards are the units that are present and not cordoned, averaged
  over the last 24 h of **observed** time, so a board added or lost mid-window counts
  right away. Each hour's board-seconds are divided by the seconds its counters were
  actually observed (`covered_s`: the live series' sample count × the 15 s scrape
  interval). A counter that has existed for 20 minutes therefore reads as whole boards.
  When the newest source covers less than 24 h (for example right after a redeploy),
  the rest comes from the newest older data, the journal backfill.
- **Coverage.** Each hour comes from exactly one source; live data wins over the
  backfill, so an overlap is never double-counted. Hours that no source observed,
  such as the gap between the end of the backfill and the redeploy, are skipped:
  they are unknown, not zero demand on zero boards. The window reports `hours` (with
  data) and `gap_hours`.
  **Usable** boards are what the daemons' concurrency caps (`--max-concurrent`,
  `--max-concurrent-class`) let run at once. healthy − usable is capacity lost to caps:
  fix the config instead of buying boards.
- **Requirement.** Erlang C (M/M/c) gives the smallest c whose **merge-queue p95 wait
  ≤ SLO** (10 min by default; the SLO is a dashboard variable, and the dataset carries
  5 to 60 min). The pool also has to be stable overall (c > offered load), so dev work
  is never starved forever.
  - `fifo` (today's daemon): every class waits the same, so the SLO applies to all
    requests.
  - `priority` (merge-queue > PR CI > dev, non-preemptive; hitl-reserve#17): the
    merge-queue tail uses Cobham's mean with an exponential tail. PR CI is also guarded
    to p95 ≤ 40 min, the harness's `HITL_ACTIVATE_TIMEOUT`, so that priority can't
    "meet the SLO" by starving PR CI. Aging offsets (20/60 min) are longer than the
    SLO, so strict priority is the right approximation.
  - Routing `split`: one queue per host. The client picks a host when it reserves and
    stays queued there, so 2 rigs × 2 boards is not one 4-board queue.
- **Deficit** = required − healthy. **Headroom** = the largest demand multiple (up to
  ×10) at which today's usable boards still meet the SLO. Below ×1 the pool is already
  short. **Growth** ×1 … ×4 re-evaluates the deficit at multiplied demand, for example
  for the Kickstarter.

Offered load **ρ** = demand board-hours ÷ healthy board-hours, per day and at the
busiest hour.

**Efficiency shows up as lower demand, never as more capacity.** Priority scheduling
lowers the requirement for the same SLO. Test selection (bazel-diff) lowers arrivals.
Fixing lease-expiry waste lowers the hold. Healthy and usable boards only change when
boards or caps change. `test_capacity_model.py` checks this property.

### Validation: is the model honest?

The dashboard compares the measured wait distribution with the model's prediction for
the same window. The prediction is an hour-by-hour Erlang-C mixture at each hour's
arrivals on that hour's usable boards. The population is every request the queue had
to serve: activated requests plus timeouts. Withdrawn requests are excluded. Past the
40 min client timeout the measured curve is **censored**, because a timeout stops the
clock, so the comparison runs up to 30 min. Four variants are shown: `pooled` or
`split` routing, each with `mmc` (Poisson) or `ac` (Allen–Cunneen with the measured
burstiness). The headline uses `split-mmc`.

### Known limits

- **Arrivals are burstier than Poisson** (index of dispersion ~26 for C6). Evaluating at
  the p90 hour absorbs most of that. The validation shows what is left.
- **Shared host caps are approximated.** A host cap shared by several types is split in
  proportion to their busy time. The pre-#362 rigs also had strict host-wide FIFO, so
  Pi requests queued behind C6 requests. #362 removed that, and the model ignores it.
- **Backfill priority classes are inferred.** CI reservations are matched to the
  `hitl.yaml` job that was running when they were requested. A push to `main` counts
  as merge-queue. Jobs overlap a lot, so the merge-queue share is approximate. Live
  data carries the real class.

## Data

```text
journals (backfill) ─┐
                     ├─ hourly aggregates ─ model ─ capacity.json ─► release hitl-capacity-data ─► Infinity ─► dashboard
Prometheus (live) ───┘    (aggregates.json, 90 days, also on the release)
```

- **Backfill**: `data/backfill_aggregates.json`, built from the `hitl-manager` journals of
  rig-1 and rig-2, 2026-10-18..25 (`reserve` / `reconcile` / `release` / `listening on` /
  `concurrency:` lines). Daemon starts before per-class caps had no `concurrency:` line,
  so they get `--default-host-cap 2`, the old fleet-wide `--max-concurrent 2`. To refresh
  it, read the journals (read-only) and run:

  ```bash
  ssh -i pi/secrets/deploy_key root@hitl-rig-1 journalctl -u hitl-manager -o short-iso --since 2026-10-18 > rig1.txt
  python3 pi/hitl/observability/capacity/run_capacity.py backfill \
      --journal hitl-rig-1=rig1.txt --journal hitl-rig-2=rig2.txt --runs hitl_runs.json
  ```

  `--runs` is the `hitl.yaml` runs with their `hitl_tests` job windows (GitHub API).
  Use it for priority attribution; without it every reservation counts as dev.

- **Live**: the hitl-reserved capacity series, read through Grafana `/api/ds/query`:
  `hitl_reservation_requests_total`, `hitl_reservation_abandoned_total`,
  `hitl_reservation_wait_seconds` (by `result`), `hitl_reservation_hold_seconds`,
  `hitl_unit_busy_seconds_total` (by `outcome`), `hitl_unit_available_seconds_total`,
  all labelled `caps_class` / `prio_class`. They exist once the rigs run a hitl-reserve
  build with them (hitl-reserve#17). Until then the window stays at the backfill's end,
  and the dashboard's **Data window** stat shows that. For hours both sources cover, the
  live data wins. Live data has no owner names, so the not-retried fraction of timeouts
  comes from the backfill (`unretried_timeout_fraction`).
- **Merged PRs** come from the GitHub API, for board-hours per merged PR.
- **Test selection**: `daily[].selection_skipped_fraction` stays empty until the
  bazel-diff selection lands. Wire it in by passing `selection={date: {total, skipped}}`
  to `build_dataset`, for example from the HITL job's selection log.

## Running

```bash
cd pi/hitl/observability/capacity
python3 test_erlang.py && python3 test_reservations.py && python3 test_capacity_model.py
python3 gen_dashboard.py            # rewrites ../dashboards/hitl-capacity.json
GRAFANA_URL=https://splanc.grafana.net GRAFANA_TOKEN=... GITHUB_TOKEN=... \
  python3 run_capacity.py publish --repo OWNER/splanc --out-dir /tmp/cap   # prints the headline
```

`.github/workflows/hitl-capacity.yaml` runs `publish --seed-from-release
--upload-release` every 2 hours. It needs `GRAFANA_TOKEN` (query access is enough) in
the **Grafana** Actions environment; without it the run uses the backfill and history
only and posts a warning. The dashboard reads
`https://github.com/<repo>/releases/download/hitl-capacity-data/capacity.json`.
`grafana-dashboards.yaml` fills `<repo>` in from `github.repository` (the
`__GITHUB_REPOSITORY__` placeholder) when it syncs.
