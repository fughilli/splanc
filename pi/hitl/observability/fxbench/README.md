# fx_bench performance observability

Per-effect firmware render-timing history from the HITL CI, plotted in Grafana so
**drift is visible over time and across branches** — caught before it flakes CI.

## Why

`fx_bench` (FUG-11) runs the LED-mapper effects on a real ESP32-C6 on every
`.github/workflows/hitl.yaml` run and gates each effect's frame-cycle cost against
a committed golden (`web/tests/testdata/device-bench-esp32c6[-jit].json`) with a
per-effect margin. Goldens drift over releases: the JIT `sweep16` effect crept
from a 2026-08-20 golden of 40320 cycles to a stable ~46700 (+16%), landing right
on the ±15% margin → ~50% CI flake. Nothing plotted that trend, so it was only
noticed once it started flaking. This pipeline turns every logged measurement into
a time series + distribution so the next such drift is obvious early.

## What the data is

Every run logs, per effect, per build (JIT and interpreter), a line like:

```text
  sweep16: frame=46690 show=61278 @ 16 LEDs
```

`frame`/`show` are CPU cycles; the harness reports the window-MINIMUM frame (the
interrupt-free compute cost — `stable_cycles()` in `../../harness/fx_bench_core.py`).
The same effect appears several times per run (interp + jit builds, fit/heldout,
and bazel flaky retries); **every** sample is captured so the distribution is real.

## Pipeline (stdlib-only Python, no push token needed)

```text
GitHub Actions (hitl.yaml runs, all branches)
      │  REST API: workflow runs → hitl_tests job → job log (ANSI-stripped)
      ▼
ingest_fx_bench.py  ──parse every  "<label>: frame=X show=Y @ N LEDs"  line──►
      │             (build attributed from the "[jit] pinned ON/OFF" marker +
      │              the closing "[golden] …device-bench-esp32c6[-jit].json" line)
      ▼
data/measurements.jsonl        append-only history (one row per sample)
data/measurements.json         compact array for Grafana (2 rows/sample: metric=
                               frame|show), each with per-row ratio/ln_ratio vs golden
data/measurements-recent.json  a trailing-window slice (RECENT_WINDOW_DAYS, default
                               180d) of the same schema — what the performance-overview
                               reads so it never fetches the unbounded full asset
data/goldens.json              golden value + ±margin band per effect/build
data/goldens_line.json         golden as a flat line (value at first & last timestamps)
      │
      ▼   uploaded as assets on the `fxbench-data` GitHub release (--upload-release)
Grafana Cloud  ── grafanacloud-infinity datasource (reads the release URLs) ──►
      fx_bench dashboards (../dashboards/fxbench-*.json)
```

**Storage choice.** The `grafana_local.token` in `credentials/` is an Editor
service-account token: it can create dashboards/folders and query datasources, but
it **cannot push** to Prometheus/Loki/Graphite (that needs a write-scoped Grafana
Cloud access-policy token, which we don't have in-repo). So instead of pushing
metrics, the parsed dataset is served to Grafana Cloud's existing **Infinity**
datasource (`grafanacloud-infinity`), which fetches JSON from a URL and filters it
server-side with a JSONata `root_selector`. Backfill with arbitrary past timestamps
is trivial (each row carries the commit time), and there are zero write credentials
to provision.

The dataset is multi-MB and grows every run, so it is **not committed to git**
(the repo's `check-added-large-files` hook caps files at 600 KB). It lives as
assets on the `fxbench-data` GitHub _release_, re-uploaded each ingest; Grafana
reads the fixed download URLs
(`https://github.com/fughilli/splanc/releases/download/fxbench-data/…`). Only the
small `data/ingest_state.json` run-id ledger is tracked in git, so the incremental
ingest knows which runs it has already seen. If a write-scoped Loki/Prometheus
token is later added to the "HITL"/"Grafana" Actions environments, the same rows
could also be pushed there.

## Running it

```bash
# Backfill everything (idempotent; caches raw logs under cache/, skips seen runs),
# then publish the dataset to the fxbench-data release Grafana reads:
GITHUB_TOKEN=$(cat /workspace/credentials/github_api_token.txt) \
  python3 ingest_fx_bench.py --max-pages 8 --upload-release

# Incremental (this is what the scheduled workflow runs): seed history from the
# release, ingest only new runs, re-upload the refreshed assets:
python3 ingest_fx_bench.py --max-pages 2 --seed-from-release --upload-release

# Regenerate the dashboards after changing the generator or effect set:
python3 gen_dashboards.py
```

`--force` rebuilds the whole dataset from the cached/fetched logs (needs the local
`cache/`, so it's a local-only operation, not for CI). The token is read from
`--token-file` (default `/workspace/credentials/github_api_token.txt`) or
`$GITHUB_TOKEN`, and needs `contents:write` to manage the release.

## Ongoing ingest

`.github/workflows/fxbench-ingest.yaml` runs every 3 hours (and on demand):
it seeds the history from the `fxbench-data` release, ingests new runs
incrementally with the built-in `GITHUB_TOKEN`, re-uploads the refreshed assets,
and commits only the small `ingest_state.json` ledger back to `main` (`[skip ci]`).
Because Grafana reads the release download URLs, new CI runs show up in the
dashboards within a few hours automatically.

## Dashboards

Generated by `gen_dashboards.py` into `../dashboards/`, synced to Grafana by
`.github/workflows/grafana-dashboards.yaml` (and pushable by hand via
`/api/dashboards/db`):

| UID                            | What                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fxbench-drift`                | Frame/show cycles over commit time per effect; **main = trend line**, a `$branch` textbox overlays that branch's points; golden value + ±margin band as reference series.                                                                                                                                                                                                                           |
| `fxbench-distribution`         | Histograms of frame & show cycles per effect (spread / multi-modality across all branches), filterable by effect + build.                                                                                                                                                                                                                                                                           |
| `fxbench-overview`             | Golden + margin table per effect/build, and a sortable table of every frame-cycle sample.                                                                                                                                                                                                                                                                                                           |
| `fxbench-performance-overview` | **Systematic** drift aggregated across a client-side selectable **effect subset**: an overall performance index (mean `ln(measured/golden)` per commit = geomean in log space, 0 = at golden), a breadth-of-drift bar (regressed/within/improved counts), a drift-distribution heatmap, and a top-movers table. Reads the bounded `measurements-recent.json` slice — never the ~19.5 MB full asset. |

### The performance-overview: aggregating drift across effects

The overview answers "is the WHOLE effect set drifting, or just one effect?" — a
question the per-effect drift dashboard can't. It hinges on two ingest additions:

- **Per-row `ratio`/`ln_ratio`.** Each compact row carries `ratio = measured /
golden` and `ln_ratio = ln(ratio)` against its `(label, build, chip, metric)`
  golden. Enriching PER ROW (not pre-aggregating) preserves arbitrary client-side
  subsetting. The aggregate "performance index" is then a plain **mean of
  `ln_ratio`** grouped by commit — which is the geomean of `measured/golden` in log
  space (0 = at golden, `+0.02` ≈ +2% slower). We stay in log space because
  Grafana/JSONata have no `exp`/`log`, so a true geomean (`exp(mean(ln))`) can't be
  computed browser-side; the log-space mean is native, robust, and monotonic in the
  same direction. A row with no golden gets `ratio`/`ln_ratio` = `null` and the
  dashboard predicates skip it (each is guarded by a leading `ratio and …`).
- **The bounded slice.** The overview aggregates across effects, so a naive query
  would pull the entire (growing, ~19.5 MB) `measurements.json` per panel. Instead
  the ingest emits `measurements-recent.json` — the trailing `RECENT_WINDOW_DAYS`
  (default 180) of the same schema — and the overview reads only that.

All filtering is a JSONata per-row map/predicate (server-side in Infinity); all
aggregation is a **native single-frame Grafana transform** (group-by mean/sum,
`calculateField` abs) — no cross-frame merges, no JSONata grouping, no exp/log.

Grafana can't template a _datasource_ on a shared/public link, so the datasource
is pinned to `grafanacloud-infinity`; the effect/build/metric/branch filters are a
JSONata `root_selector` predicate (`$[label='$effect' and build='$build' …]`) bound
to dashboard template variables (custom lists / a textbox), not a `query` variable
— so the dashboards can still be shared publicly like the HITL rigs one.
