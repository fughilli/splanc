# CI observability — failure dashboarding (FUG-128)

Turn every Bazel-running CI job into queryable failure telemetry and a browsable
report. From the Bazel **Build Event Protocol** (BEP) we recover **per-test-case**
results, categorize failures, and drive a Grafana dashboard that answers:

- **Failures aggregated by trace / reason** — `Failure: out of disk` vs
  `ValueError: divide by zero` (grouped by a scrubbed failure _signature_).
- **Failures aggregated by runner / DUT** — `github:linux` vs `github:macos`
  vs `hitl` — to spot flaky hardware/runner configurations.
- **Heatmap of failures by test case** — which tests fail most.

Each Bazel job also uploads a **self-contained static HTML report** (charts +
collapsible per-target details) and links it from the job summary and the log.

## Architecture

```text
  GitHub Actions job (test / firmware / build-site / hitl / test-macos)
     │  bazel test|build … --build_event_json_file=bep.json
     ▼
  .github/actions/bep-report  (composite action, always())
     │  python3 tools/ci_observability/bep_report.py
     ├─► report.html ──► upload-artifact ──► link in job summary + ::notice:: log line
     └─► NDJSON records ──► sinks.push_all()
                              ├─► Grafana Cloud Loki   (default; reuses FUG-117 creds)
                              └─► ClickHouse-compatible (optional columnar; Tinybird/…)
                                        │
                  dashboards-as-code    ▼
        observability/ci/dashboards/ci-failures.json ──► Grafana  (3 views above)
```

## Components

| Path                                                 | What                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bep_report.py`                                      | Parse BEP → normalized records → NDJSON + HTML + step-summary; push to sinks. Stdlib only. |
| `report_html.py`                                     | The self-contained static HTML report renderer.                                            |
| `sinks.py`                                           | `loki` + `tinybird` + `clickhouse` sinks; each no-ops without credentials.                 |
| `schema/ci_test_results.sql`                         | ClickHouse DDL for the columnar table.                                                     |
| `schema/ci_test_results.datasource`                  | Tinybird-native Data Source form of the same.                                              |
| `../../.github/actions/bep-report/action.yml`        | Reusable CI step wiring it all together.                                                   |
| `../../observability/ci/dashboards/ci-failures.json` | The Grafana dashboard, as code.                                                            |

## Per-test-case granularity

Bazel's BEP `TestResult` events point at each test's `test.xml` (JUnit). The
parser follows those and extracts one record **per `<testcase>`** — classname,
name, time, and the `<failure>`/`<error>` message + trace. When a target doesn't
emit its own JUnit XML, Bazel writes a minimal one and we fall back to a single
synthetic case for the whole target (trace pulled from `test.log`). Build/analysis
failures (no test result) become one `record_type=target` row, with the compiler
stderr as the reason.

> To get true per-case rows from a `py_test`, have it write JUnit XML to the
> `$XML_OUTPUT_FILE` Bazel sets — e.g. `pytest --junitxml="$XML_OUTPUT_FILE"`.
> Without it you still get correct target-level pass/fail, just not sub-case rows.

Each record also carries a `failure_category` (coarse bucket:
`disk|memory|timeout|network|build|assertion|other`) and a `failure_signature`
(the reason line with paths/addresses/line-numbers/timestamps scrubbed) so
identical failures across runs group into one row.

## The columnar database

The issue asks for a **columnar** store that is low-cost, fully-hosted, and
well-supported. Evaluated options:

| Option                            | Free & hosted?                      | Notes                                                                                                                                                                     |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tinybird** (Build/Forward free) | ✅ free, hosted, managed ClickHouse | **Recommended columnar backend.** No credit card. Ingest via its Events API (`sinks.push_tinybird`); columns match `schema/ci_test_results.datasource`.                   |
| ClickHouse Cloud                  | ⚠️ 30-day trial then paid           | The archetype, but not fully-free-hosted.                                                                                                                                 |
| Self-hosted ClickHouse            | free, **not** hosted                | You run it.                                                                                                                                                               |
| **Grafana Cloud Loki**            | ✅ free, hosted                     | Not columnar, but LogQL aggregates these structured events into all three views — and FUG-117 already wired the credentials, so this is the **zero-new-account default**. |

**What we ship:** the dashboard (`ci-failures.json`) is built against **Loki**,
because those credentials already exist in this repo (FUG-117) — so the pipeline
produces the three required views the moment the Loki secrets are present, with
no new account. The **Tinybird sink** (Events API) and the **ClickHouse sink**
(native `INSERT`) are the columnar upgrade: the same records also land in a real
columnar table for ad-hoc SQL (reference queries in `schema/ci_test_results.sql`).
All sinks run independently; leave any unconfigured. See the recipes below.

## Configuration — pick a recipe (both fully free)

All the code is wired and tested. Turning it on is **just credentials** — set as
**repository** secrets (Settings → Secrets and variables → Actions → _Repository
secrets_) so every job inherits them; fork PRs get empty values and every push
step no-ops. The sinks are independent — configure one, the other, or both.

The HTML report + artifact link need **no** credentials at all — they work on
the very next CI run regardless.

### Recipe A — Grafana Cloud Loki only (least effort; the shipped dashboard)

This is the simplest fully-free path, and the `ci-failures.json` dashboard is
built for it. You likely already have the Grafana Cloud stack + Loki from
FUG-117.

1. Grafana Cloud free tier (10k series / 50 GB logs) → **Loki → Details**: note
   the push URL + numeric user; create an access-policy token with `logs:write`.
2. Set repository secrets:

   | Secret                    | Value                                                        |
   | ------------------------- | ------------------------------------------------------------ |
   | `GRAFANA_CLOUD_LOKI_URL`  | `https://logs-prod-<region>.grafana.net/loki/api/v1/push`    |
   | `GRAFANA_CLOUD_LOKI_USER` | numeric Loki instance id (e.g. `1740555`)                    |
   | `GRAFANA_CLOUD_LOKI_KEY`  | a Grafana.com API token / access-policy token (`logs:write`) |

   The sink authenticates with HTTP **basic auth** (`USER:KEY`) — exactly the
   `basic_auth { username = "<id>"; password = "<token>" }` block Grafana Alloy
   uses — so the same token/URL work here unchanged.

   > These already exist in the "HITL" _environment_ from FUG-117 — copy the
   > same values to **repository** secrets so the non-HITL jobs (test, macos, …)
   > can read them too. (Environment secrets are invisible to jobs that don't
   > opt into that environment; these jobs don't.)

3. In Grafana → Connections → Data sources, add a **Loki** data source pointing
   at that stack. The dashboard's `DS_LOKI` variable selects it.

That's the whole recipe — nothing else to stand up. **You do not need Tinybird
or ClickHouse for the dashboard.**

### Recipe B — Tinybird (Forward) columnar backend (also free)

Use this if you want a real columnar table for ad-hoc SQL / the three
aggregations in ClickHouse SQL. Tinybird's free tier needs no credit card. From
your Tinybird quick-start, you only need steps that create **our** data source
and a token — **skip the taxi sample data, the `best_tip_zones` pipe, and
Tinybird Local/Docker.**

```bash
# In a fresh Tinybird project dir (`tb init`), drop our schema in:
cp <splanc>/tools/ci_observability/schema/ci_test_results.datasource datasources/
tb deploy                      # creates the ci_test_results data source in Cloud
tb --cloud token ls            # or create one scoped to append ci_test_results
```

Get the workspace **API host** (e.g. `https://api.us-east.aws.tinybird.co`) from
`.tinyb` (`jq -r .host .tinyb`) or the workspace URL, and a **token with append
scope** for `ci_test_results` (the admin token works; a scoped one is cleaner).
Then set repository secrets:

| Secret                | Value                                                               |
| --------------------- | ------------------------------------------------------------------- |
| `TINYBIRD_API_URL`    | your workspace API host, e.g. `https://api.us-east.aws.tinybird.co` |
| `TINYBIRD_TOKEN`      | a token with `DATASOURCES:APPEND` scope for `ci_test_results`       |
| `TINYBIRD_DATASOURCE` | data source name (optional; default `ci_test_results`)              |

The sink posts rows to Tinybird's **Events API**
(`POST /v0/events?name=ci_test_results`, newline-delimited JSON) — the correct
ingestion path for Tinybird Forward. Explore the data in Tinybird's own UI
(`tb --cloud open`) with SQL, or graph it in Grafana by adding the community
**ClickHouse/Tinybird** data source and using the reference queries in
`schema/ci_test_results.sql`.

> **Self-hosted / ClickHouse Cloud instead of Tinybird?** Use the `CLICKHOUSE_*`
> secrets (`CLICKHOUSE_URL`, `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD` or
> `CLICKHOUSE_TOKEN`, optional `CLICKHOUSE_DATABASE`/`CLICKHOUSE_TABLE`) and
> create the table from `schema/ci_test_results.sql`. That sink uses ClickHouse's
> native `INSERT … FORMAT JSONEachRow` HTTP endpoint — which Tinybird does not
> expose, hence the separate Tinybird sink above.

### Grafana dashboard sync (already set up by FUG-117)

The dashboard is synced by the existing `grafana-dashboards.yaml` workflow, which
reads the "Grafana" Actions environment (`GRAFANA_URL`, `GRAFANA_TOKEN`, optional
`GRAFANA_FOLDER_UID`). It now also globs `observability/ci/dashboards/*.json`, so
a merge to `main` pushes the CI dashboard automatically. (You can also import the
JSON by hand: Grafana → Dashboards → New → Import.)

Once the secrets are in place, the next CI run parses its BEP, uploads the HTML
report, and populates whichever sink(s) you configured.

## Local use

```sh
bazel test //some/target --build_event_json_file=/tmp/bep.json
bazel run //tools/ci_observability:bep_report -- \
  --bep /tmp/bep.json --out-html /tmp/report.html --runner local
open /tmp/report.html
```

`bazel test //tools/ci_observability:bep_report_test` runs the unit tests.
